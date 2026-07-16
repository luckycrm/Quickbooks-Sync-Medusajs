import { QUICKBOOKS_MODULE } from "../modules/quickbooks";
import type QuickbooksModuleService from "../modules/quickbooks/service";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { getReadyQuickbooksConnection } from "./connection";
import { syncMedusaProductToQuickbooks } from "./product-sync-service";
import {
  createQuickbooksInvoice,
  createQuickbooksSalesReceipt,
  findQuickbooksCustomers,
  findQuickbooksItems,
  getQuickbooksConfig,
  getQuickbooksInvoice,
  getQuickbooksSalesReceipt,
  updateQuickbooksInvoice,
  updateQuickbooksSalesReceipt,
} from "./quickbooks";

type ScopeLike = {
  resolve: (name: string) => any;
};

type OrderModuleService = {
  listAndCountOrders: (
    filters?: Record<string, unknown>,
    config?: Record<string, unknown>,
  ) => Promise<[Record<string, unknown>[], number]>;
};

const ORDER_SYNC_BATCH_SIZE = 100;

// Placed ("pending") orders sync as QuickBooks invoices, completed orders as
// sales receipts. Draft, archived and canceled orders are never synced.
const SYNCABLE_ORDER_STATUSES = ["pending", "completed"];

// QuickBooks reserved item id for the built-in shipping line. Requires
// "shipping" to be enabled in the QuickBooks company sales settings.
const QUICKBOOKS_SHIPPING_ITEM_ID = "SHIPPING_ITEM_ID";

// QuickBooks hard limit: taxable transactions allow at most 750 lines.
const QUICKBOOKS_MAX_TRANSACTION_LINES = 750;

const asRecord = (value: unknown) => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
};

const asString = (value: unknown) => (typeof value === "string" ? value : null);

const asNumber = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);

    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  // Medusa returns money and quantity fields as BigNumber instances (or raw
  // big-number payloads) when queried alongside computed totals — unwrap them.
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const candidate = record.numeric_ ?? record.numeric ?? record.value;

    if (candidate !== undefined && candidate !== value) {
      return asNumber(candidate);
    }
  }

  return null;
};

const roundAmount = (value: number) => Math.round(value * 100) / 100;

// Order line quantity lives on the detail relation (order_item); the value on
// the line item itself is only present when the order module decorates it.
const getOrderItemQuantity = (itemRecord: Record<string, unknown>) =>
  asNumber(itemRecord.quantity) ??
  asNumber(asRecord(itemRecord.detail)?.quantity) ??
  1;

const formatQuickbooksDate = (value: Date) => value.toISOString().slice(0, 10);

function buildQuickbooksAddress(address: Record<string, unknown> | null) {
  if (!address) return null;

  return {
    Line1: asString(address.address_1) || "",
    Line2: asString(address.address_2) || "",
    Line3: asString(address.address_3) || "",
    City: asString(address.city) || "",
    CountrySubDivisionCode: asString(address.province) || "",
    PostalCode: asString(address.postal_code) || "",
    Country: asString(address.country_code) || "",
  };
}

type OrderTaxSettings = {
  treatment: "out_of_scope" | "inclusive" | "exclusive" | null;
  taxCodeId: string | null;
};

const TAX_TREATMENT_TO_GLOBAL_TAX_CALCULATION: Record<string, string> = {
  out_of_scope: "NotApplicable",
  inclusive: "TaxInclusive",
  exclusive: "TaxExcluded",
};

function buildQuickbooksLineItems(
  items: Record<string, unknown>[],
  quickbooksItems: Record<string, unknown>[],
  taxSettings: OrderTaxSettings,
) {
  // With exclusive amounts, the selected sales tax code is applied per line
  // so QuickBooks calculates and adds tax on top.
  const lineTaxCodeId =
    taxSettings.treatment === "exclusive" ? taxSettings.taxCodeId : null;
  const lineItems: Record<string, unknown>[] = [];

  const quickbooksItemsBySku = new Map<string, Record<string, unknown>>();
  for (const qbItem of quickbooksItems) {
    const sku = asString(qbItem.Sku)?.trim();
    if (sku && !quickbooksItemsBySku.has(sku)) {
      quickbooksItemsBySku.set(sku, qbItem);
    }
  }

  const servicesItem = quickbooksItems.find(
    (i) => asString(i.Name) === "Services",
  );
  const productsItem = quickbooksItems.find(
    (i) => asString(i.Name) === "Products",
  );
  const defaultItem =
    servicesItem ||
    productsItem ||
    (quickbooksItems.length ? quickbooksItems[0] : null);

  for (const item of items) {
    const itemRecord = asRecord(item);

    if (!itemRecord) {
      continue;
    }

    const sku =
      asString(itemRecord.variant_sku)?.trim() ||
      asString(itemRecord.sku)?.trim() ||
      null;

    const matchedItem =
      (sku ? quickbooksItemsBySku.get(sku) : null) || defaultItem;

    if (!matchedItem) {
      console.warn(
        `[quickbooks-order-sync] No QuickBooks item found for SKU "${sku}" and no fallback available.`,
      );
    }

    const quantity = getOrderItemQuantity(itemRecord);
    // Rate: the order's own unit price when present, otherwise the sales
    // price stored on the matched QuickBooks item.
    const unitPrice =
      asNumber(itemRecord.unit_price) ?? asNumber(matchedItem?.UnitPrice) ?? 0;
    // Tax-exclusive amount: QuickBooks calculates taxes itself.
    const amount = asNumber(itemRecord.subtotal) ?? unitPrice * quantity;

    // Line description mirrors the synced QuickBooks item name (falls back to
    // the Medusa titles for unmatched lines).
    const description = (
      asString(matchedItem?.Name) ||
      asString(itemRecord.title) ||
      asString(itemRecord.product_title) ||
      "Product"
    ).substring(0, 400);

    lineItems.push({
      Description: description,
      Amount: roundAmount(amount),
      DetailType: "SalesItemLineDetail",
      SalesItemLineDetail: {
        ItemRef: {
          value: asString(matchedItem?.Id) || "1",
          ...(asString(matchedItem?.Name)
            ? { name: asString(matchedItem?.Name) }
            : {}),
        },
        Qty: quantity,
        UnitPrice: roundAmount(unitPrice),
        ...(lineTaxCodeId ? { TaxCodeRef: { value: lineTaxCodeId } } : {}),
      },
    });
  }

  return lineItems;
}

function buildQuickbooksTransactionPayload(input: {
  order: Record<string, unknown>;
  quickbooksCustomerId: string | null;
  quickbooksItems: Record<string, unknown>[];
  taxSettings: OrderTaxSettings;
}) {
  const orderRecord = asRecord(input.order);

  const items = Array.isArray(orderRecord?.items) ? orderRecord.items : [];
  const summary = asRecord(orderRecord?.summary);

  // Pre-tax amounts only: QuickBooks automated sales tax calculates and adds
  // taxes based on the shipping address and item tax codes.
  const shippingSubtotal =
    asNumber(orderRecord?.shipping_subtotal) ??
    asNumber(summary?.shipping_total) ??
    0;
  const discountTotal =
    asNumber(orderRecord?.discount_total) ??
    asNumber(summary?.discount_total) ??
    0;

  const lineItems = buildQuickbooksLineItems(
    items as Record<string, unknown>[],
    input.quickbooksItems,
    input.taxSettings,
  );

  const shippingTaxCodeId =
    input.taxSettings.treatment === "exclusive"
      ? input.taxSettings.taxCodeId
      : null;

  if (shippingSubtotal > 0) {
    lineItems.push({
      Description: "Shipping",
      Amount: roundAmount(shippingSubtotal),
      DetailType: "SalesItemLineDetail",
      SalesItemLineDetail: {
        ItemRef: {
          value: QUICKBOOKS_SHIPPING_ITEM_ID,
        },
        Qty: 1,
        UnitPrice: roundAmount(shippingSubtotal),
        ...(shippingTaxCodeId
          ? { TaxCodeRef: { value: shippingTaxCodeId } }
          : {}),
      },
    });
  }

  if (discountTotal > 0) {
    lineItems.push({
      Amount: roundAmount(discountTotal),
      DetailType: "DiscountLineDetail",
      DiscountLineDetail: {
        PercentBased: false,
      },
    });
  }

  const payload: Record<string, unknown> = {
    Line: lineItems,
    TxnDate: formatQuickbooksDate(new Date()),
    PrivateNote: `Medusa Order: ${asString(orderRecord?.id) || "unknown"}`,
  };

  // Tax treatment: how QuickBooks interprets the amounts. Ignored by US
  // companies with automated sales tax; honored everywhere else.
  const globalTaxCalculation = input.taxSettings.treatment
    ? TAX_TREATMENT_TO_GLOBAL_TAX_CALCULATION[input.taxSettings.treatment]
    : null;

  if (globalTaxCalculation) {
    payload.GlobalTaxCalculation = globalTaxCalculation;
  }

  // Mirror the Medusa order number as the QuickBooks document number.
  // Honored when custom transaction numbers are enabled in QuickBooks.
  const displayId = orderRecord?.display_id;
  if (displayId !== undefined && displayId !== null) {
    payload.DocNumber = String(displayId);
  }

  if (input.quickbooksCustomerId) {
    payload.CustomerRef = {
      value: input.quickbooksCustomerId,
    };
  }

  const email = asString(orderRecord?.email);
  if (email) {
    payload.BillEmail = {
      Address: email,
    };
  }

  const billingAddress = asRecord(orderRecord?.billing_address);
  if (billingAddress) {
    payload.BillAddr = buildQuickbooksAddress(billingAddress);
  }

  const shippingAddress = asRecord(orderRecord?.shipping_address);
  if (shippingAddress) {
    payload.ShipAddr = buildQuickbooksAddress(shippingAddress);
  }

  return payload;
}

async function getMedusaOrderById(scope: ScopeLike, orderId: string) {
  const query = scope.resolve(ContainerRegistrationKeys.QUERY) as {
    graph: (input: {
      entity: string;
      fields: string[];
      filters?: Record<string, unknown>;
    }) => Promise<{ data?: Record<string, unknown>[] }>;
  };

  try {
    const response = await query.graph({
      entity: "order",
      fields: [
        "id",
        "display_id",
        "version",
        "status",
        "currency_code",
        "customer_id",
        "email",
        "billing_address.*",
        "shipping_address.*",
        "items.*",
        "items.product_id",
        "items.variant_id",
        // quantity lives on the order detail row (order_item), not the line
        // item — request it via the detail relation explicitly.
        "items.quantity",
        "items.detail.quantity",
        "items.unit_price",
        "items.subtotal",
        "items.total",
        "items.variant_sku",
        "items.title",
        "items.variant_title",
        "items.product_title",
        "shipping_methods.*",
        "summary.*",
        "item_subtotal",
        "shipping_subtotal",
        "subtotal",
        "discount_total",
        "total",
        "created_at",
        "updated_at",
      ],
      filters: {
        id: [orderId],
      },
    });

    return response.data?.[0] ?? null;
  } catch (error) {
    console.error("[quickbooks-order-sync] failed to fetch order", {
      orderId,
      error,
    });
    return null;
  }
}

export async function findQuickbooksCustomerByEmail(
  scope: ScopeLike,
  email: string,
): Promise<string | null> {
  const { config, connection } = await getReadyQuickbooksConnection(scope);

  if (!connection) {
    return null;
  }

  try {
    const customers = await findQuickbooksCustomers(connection, config, {
      PrimaryEmailAddr: email,
    });

    if (customers.length > 0 && customers[0].Id) {
      return asString(customers[0].Id);
    }
  } catch (error) {
    console.error("[quickbooks-order-sync] failed to find customer", {
      email,
      error,
    });
  }

  return null;
}

async function getQuickbooksCustomerIdByMedusaCustomerId(
  scope: ScopeLike,
  medusaCustomerId: string,
): Promise<string | null> {
  const quickbooksService: QuickbooksModuleService =
    scope.resolve(QUICKBOOKS_MODULE);
  const customerLink =
    await quickbooksService.getCustomerLinkByMedusaCustomerId(medusaCustomerId);

  if (customerLink?.quickbooks_customer_id) {
    return customerLink.quickbooks_customer_id;
  }

  return null;
}

function computeOrderHash(order: Record<string, unknown>): string {
  const orderRecord = asRecord(order);
  const items = Array.isArray(orderRecord?.items) ? orderRecord.items : [];
  const summary = asRecord(orderRecord?.summary);

  const hashData = {
    id: orderRecord?.id,
    display_id: orderRecord?.display_id,
    version: orderRecord?.version,
    status: orderRecord?.status,
    items: items.map((item) => ({
      id: asString(asRecord(item)?.id),
      quantity: getOrderItemQuantity(asRecord(item) || {}),
      unit_price: asRecord(item)?.unit_price,
      subtotal: asRecord(item)?.subtotal,
    })),
    summary: {
      total: summary?.total,
      subtotal: summary?.subtotal,
      shipping_total: summary?.shipping_total,
      discount_total: summary?.discount_total,
    },
  };

  return JSON.stringify(hashData);
}

type QuickbooksConnectionInput = {
  realm_id?: string | null;
  access_token?: string | null;
  refresh_token?: string | null;
};

async function upsertQuickbooksInvoiceForOrder(input: {
  connection: QuickbooksConnectionInput;
  config: ReturnType<typeof getQuickbooksConfig>;
  payload: Record<string, unknown>;
  existingInvoiceId: string | null;
}) {
  if (input.existingInvoiceId) {
    const existing = await getQuickbooksInvoice(
      input.connection,
      input.config,
      input.existingInvoiceId,
    );

    if (existing?.Id && existing.SyncToken !== undefined) {
      return await updateQuickbooksInvoice(input.connection, input.config, {
        ...input.payload,
        Id: existing.Id,
        SyncToken: existing.SyncToken,
        sparse: true,
      });
    }
  }

  return await createQuickbooksInvoice(
    input.connection,
    input.config,
    input.payload,
  );
}

async function upsertQuickbooksSalesReceiptForOrder(input: {
  connection: QuickbooksConnectionInput;
  config: ReturnType<typeof getQuickbooksConfig>;
  payload: Record<string, unknown>;
  existingSalesReceiptId: string | null;
}) {
  if (input.existingSalesReceiptId) {
    const existing = await getQuickbooksSalesReceipt(
      input.connection,
      input.config,
      input.existingSalesReceiptId,
    );

    if (existing?.Id && existing.SyncToken !== undefined) {
      return await updateQuickbooksSalesReceipt(
        input.connection,
        input.config,
        {
          ...input.payload,
          Id: existing.Id,
          SyncToken: existing.SyncToken,
          sparse: true,
        },
      );
    }
  }

  return await createQuickbooksSalesReceipt(
    input.connection,
    input.config,
    input.payload,
  );
}

export async function syncMedusaOrderToQuickbooks(
  scope: ScopeLike,
  medusaOrderId: string,
) {
  const { config, connection, quickbooksService } =
    await getReadyQuickbooksConnection(scope);

  if (!connection) {
    return {
      skipped: true,
      reason: "QuickBooks link not found or not connected.",
    };
  }

  const order = await getMedusaOrderById(scope, medusaOrderId);

  if (!order) {
    return { skipped: true, reason: "Order not found in Medusa." };
  }

  const orderRecord = asRecord(order);
  const status = asString(orderRecord?.status);

  if (!status || !SYNCABLE_ORDER_STATUSES.includes(status)) {
    return {
      skipped: true,
      reason: `Order status is "${status}", only placed (pending) and completed orders are synced.`,
    };
  }

  const existingLink =
    await quickbooksService.getOrderLinkByMedusaOrderId(medusaOrderId);

  const orderHash = computeOrderHash(order);

  if (
    existingLink?.last_synced_hash === orderHash &&
    (existingLink?.quickbooks_invoice_id ||
      existingLink?.quickbooks_sales_receipt_id)
  ) {
    return {
      skipped: true,
      reason: "Order has not changed since last sync.",
    };
  }

  // Fetch only the QuickBooks items matching this order's SKUs — orders can
  // carry 1000+ lines and pulling the full catalog per order would burn the
  // API throttle.
  const orderItems = Array.isArray(orderRecord?.items)
    ? (orderRecord.items as Record<string, unknown>[])
    : [];

  const orderSkus = [
    ...new Set(
      orderItems
        .map(
          (item) =>
            asString(asRecord(item)?.variant_sku)?.trim() ||
            asString(asRecord(item)?.sku)?.trim(),
        )
        .filter((sku): sku is string => !!sku),
    ),
  ];

  let quickbooksItems: Record<string, unknown>[] = [];

  try {
    const SKU_QUERY_CHUNK = 40;

    for (let i = 0; i < orderSkus.length; i += SKU_QUERY_CHUNK) {
      const chunk = orderSkus.slice(i, i + SKU_QUERY_CHUNK);
      const found = await findQuickbooksItems(connection, config, {
        Sku: chunk,
      });
      quickbooksItems.push(...found);
    }
  } catch (error) {
    console.error(
      "[quickbooks-order-sync] failed to fetch QuickBooks items",
      error,
    );
  }
  const knownSkus = new Set(
    quickbooksItems
      .map((item) => asString(item.Sku)?.trim())
      .filter((sku): sku is string => !!sku),
  );
  const missingProductIds = new Set<string>();

  for (const item of orderItems) {
    const itemRecord = asRecord(item);
    const sku =
      asString(itemRecord?.variant_sku)?.trim() ||
      asString(itemRecord?.sku)?.trim();
    const productId = asString(itemRecord?.product_id);

    if (sku && productId && !knownSkus.has(sku)) {
      missingProductIds.add(productId);
    }
  }

  if (missingProductIds.size) {
    console.log("[quickbooks-order-sync] creating missing QuickBooks items", {
      medusa_order_id: medusaOrderId,
      product_ids: [...missingProductIds],
    });

    for (const productId of missingProductIds) {
      try {
        const result = await syncMedusaProductToQuickbooks(scope, productId);
        const results = Array.isArray(result.results)
          ? (result.results as Record<string, unknown>[])
          : [];

        for (const variantResult of results) {
          const createdSku = asString(variantResult.sku)?.trim();
          const createdItemId = asString(variantResult.quickbooks_item_id);

          if (!variantResult.skipped && createdSku && createdItemId) {
            quickbooksItems.push({ Id: createdItemId, Sku: createdSku });
            knownSkus.add(createdSku);
          }
        }
      } catch (error) {
        console.error(
          "[quickbooks-order-sync] failed to create missing QuickBooks item",
          {
            medusa_product_id: productId,
            error: error instanceof Error ? error.message : error,
          },
        );
      }
    }
  }

  const customerId = asString(orderRecord?.customer_id);
  let quickbooksCustomerId: string | null = null;

  if (customerId) {
    quickbooksCustomerId = await getQuickbooksCustomerIdByMedusaCustomerId(
      scope,
      customerId,
    );
  }

  const email = asString(orderRecord?.email);

  if (!quickbooksCustomerId && email) {
    quickbooksCustomerId = await findQuickbooksCustomerByEmail(scope, email);
  }

  const treatment = asString(
    (connection as Record<string, unknown>).quickbooks_order_tax_treatment,
  );
  const taxSettings: OrderTaxSettings = {
    treatment:
      treatment === "out_of_scope" ||
      treatment === "inclusive" ||
      treatment === "exclusive"
        ? treatment
        : null,
    taxCodeId: asString(
      (connection as Record<string, unknown>).quickbooks_order_tax_code_id,
    ),
  };

  const payload = buildQuickbooksTransactionPayload({
    order,
    quickbooksCustomerId,
    quickbooksItems,
    taxSettings,
  });

  // QuickBooks rejects taxable transactions with more than 750 lines — fail
  // fast with a clear reason instead of a cryptic API error.
  const lineCount = Array.isArray(payload.Line) ? payload.Line.length : 0;

  if (lineCount > QUICKBOOKS_MAX_TRANSACTION_LINES) {
    console.error(
      "[quickbooks-order-sync] order exceeds QuickBooks line limit",
      {
        medusa_order_id: medusaOrderId,
        display_id: orderRecord?.display_id,
        lines: lineCount,
        limit: QUICKBOOKS_MAX_TRANSACTION_LINES,
      },
    );

    return {
      skipped: true,
      reason: `Order has ${lineCount} lines; QuickBooks allows at most ${QUICKBOOKS_MAX_TRANSACTION_LINES} lines per transaction.`,
    };
  }

  // A placed order that was already synced as an invoice keeps updating that
  // invoice even after completion — QuickBooks handles the payment lifecycle.
  const useInvoice =
    status === "pending" || !!existingLink?.quickbooks_invoice_id;

  try {
    if (useInvoice) {
      const invoice = await upsertQuickbooksInvoiceForOrder({
        connection,
        config,
        payload,
        existingInvoiceId: existingLink?.quickbooks_invoice_id || null,
      });

      if (!invoice?.Id) {
        return {
          skipped: true,
          reason: "QuickBooks did not return a persisted invoice.",
        };
      }

      await quickbooksService.upsertOrderLink({
        medusa_order_id: medusaOrderId,
        quickbooks_invoice_id: asString(invoice.Id),
        quickbooks_sync_token: asString(invoice.SyncToken),
        realm_id: connection.realm_id,
        sync_type: "invoice",
        last_synced_hash: orderHash,
        last_synced_at: new Date(),
      });

      console.log("[quickbooks-order-sync] order synced as invoice", {
        medusa_order_id: medusaOrderId,
        display_id: orderRecord?.display_id,
        quickbooks_invoice_id: invoice.Id,
        action: existingLink?.quickbooks_invoice_id ? "updated" : "created",
      });

      return {
        skipped: false,
        medusa_order_id: medusaOrderId,
        quickbooks_invoice_id: asString(invoice.Id),
        doc_number: asString(invoice.DocNumber),
        txn_date: invoice.TxnDate,
        sync_type: "invoice",
        direction: "medusa_to_quickbooks",
      };
    }

    const salesReceipt = await upsertQuickbooksSalesReceiptForOrder({
      connection,
      config,
      payload,
      existingSalesReceiptId: existingLink?.quickbooks_sales_receipt_id || null,
    });

    if (!salesReceipt?.Id) {
      return {
        skipped: true,
        reason: "QuickBooks did not return a persisted sales receipt.",
      };
    }

    await quickbooksService.upsertOrderLink({
      medusa_order_id: medusaOrderId,
      quickbooks_sales_receipt_id: asString(salesReceipt.Id),
      quickbooks_sync_token: asString(salesReceipt.SyncToken),
      realm_id: connection.realm_id,
      sync_type: "sales_receipt",
      last_synced_hash: orderHash,
      last_synced_at: new Date(),
    });

    console.log("[quickbooks-order-sync] order synced as sales receipt", {
      medusa_order_id: medusaOrderId,
      display_id: orderRecord?.display_id,
      quickbooks_sales_receipt_id: salesReceipt.Id,
      action: existingLink?.quickbooks_sales_receipt_id ? "updated" : "created",
    });

    return {
      skipped: false,
      medusa_order_id: medusaOrderId,
      quickbooks_sales_receipt_id: asString(salesReceipt.Id),
      doc_number: asString(salesReceipt.DocNumber),
      txn_date: salesReceipt.TxnDate,
      sync_type: "sales_receipt",
      direction: "medusa_to_quickbooks",
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    console.error("[quickbooks-order-sync] failed to sync order", {
      medusa_order_id: medusaOrderId,
      error: errorMessage,
    });

    return {
      skipped: true,
      reason: `Failed to sync order: ${errorMessage}`,
    };
  }
}

export async function syncMedusaOrdersToQuickbooks(
  scope: ScopeLike,
  medusaOrderIds: string[],
) {
  const uniqueIds = [...new Set(medusaOrderIds.filter(Boolean))];
  const results: Record<string, unknown>[] = [];
  let synced = 0;
  let skipped = 0;

  for (const orderId of uniqueIds) {
    const result = await syncMedusaOrderToQuickbooks(scope, orderId);

    results.push(result);

    if (result.skipped) {
      skipped += 1;
    } else {
      synced += 1;
    }
  }

  console.log("[quickbooks-order-sync] bulk sync summary", {
    count: uniqueIds.length,
    synced,
    skipped,
  });

  return {
    count: uniqueIds.length,
    synced,
    skipped,
    results,
    direction: "medusa_to_quickbooks",
  };
}

async function listAllSyncableMedusaOrderIds(scope: ScopeLike) {
  const orderModuleService = scope.resolve("order") as OrderModuleService;
  const orderIds: string[] = [];
  let skip = 0;
  let total = 0;

  do {
    const [orders, count] = await orderModuleService.listAndCountOrders(
      { status: SYNCABLE_ORDER_STATUSES },
      {
        take: ORDER_SYNC_BATCH_SIZE,
        skip,
        order: { created_at: "DESC" },
      },
    );

    total = count;

    for (const order of orders) {
      const orderId = asString(order.id);

      if (orderId) {
        orderIds.push(orderId);
      }
    }

    skip += orders.length;

    if (!orders.length) {
      break;
    }
  } while (skip < total);

  return orderIds;
}

export async function syncAllMedusaOrdersToQuickbooks(scope: ScopeLike) {
  const medusaOrderIds = await listAllSyncableMedusaOrderIds(scope);

  if (medusaOrderIds.length === 0) {
    return {
      count: 0,
      synced: 0,
      skipped: 0,
      results: [],
      message: "No placed or completed orders found to sync.",
    };
  }

  return await syncMedusaOrdersToQuickbooks(scope, medusaOrderIds);
}
