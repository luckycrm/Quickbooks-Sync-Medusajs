import { QUICKBOOKS_MODULE } from "../modules/quickbooks"
import type QuickbooksModuleService from "../modules/quickbooks/service"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import {
  createQuickbooksClient,
  findQuickbooksCustomers,
  findQuickbooksItems,
  findQuickbooksTaxRates,
  getQuickbooksConfig,
  isConnectionExpired,
  refreshOauthToken,
  toStoredConnection,
} from "./quickbooks"

type ScopeLike = {
  resolve: (name: string) => any
}

type OrderModuleService = {
  listAndCountOrders: (
    filters?: Record<string, unknown>,
    config?: Record<string, unknown>
  ) => Promise<[Record<string, unknown>[], number]>
}

type CustomerModuleService = {
  listCustomers: (
    filters?: Record<string, unknown>,
    config?: Record<string, unknown>
  ) => Promise<[Record<string, unknown>[], number]>
}

const ORDER_SYNC_BATCH_SIZE = 100

const asRecord = (value: unknown) => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return null
}

const asString = (value: unknown) => (typeof value === "string" ? value : null)

const asNumber = (value: unknown) =>
  typeof value === "number" ? value : null

const formatQuickbooksDate = (value: Date) => value.toISOString().slice(0, 10)

async function getReadyQuickbooksConnection(
  scope: ScopeLike,
  actorId?: string | null
) {
  const quickbooksService: QuickbooksModuleService = scope.resolve(QUICKBOOKS_MODULE)
  const config = getQuickbooksConfig()

  if (!config.configured) {
    return { quickbooksService, config, connection: null }
  }

  let connection = await quickbooksService.getConnection()

  if (connection && connection.refresh_token && isConnectionExpired(connection)) {
    const refreshedToken = await refreshOauthToken(connection, config)
    connection = await quickbooksService.upsertConnection(
      toStoredConnection(refreshedToken, actorId)
    )
  }

  if (!connection?.access_token || !connection?.realm_id) {
    return { quickbooksService, config, connection: null }
  }

  return { quickbooksService, config, connection }
}

function buildQuickbooksAddress(address: Record<string, unknown> | null) {
  if (!address) return null

  const parts: string[] = []
  const line1 = asString(address.address_1)
  const line2 = asString(address.address_2)
  const line3 = asString(address.address_3)

  if (line1) parts.push(line1)
  if (line2) parts.push(line2)
  if (line3) parts.push(line3)

  return {
    Line1: line1 || "",
    Line2: line2 || "",
    Line3: line3 || "",
    City: asString(address.city) || "",
    CountrySubDivisionCode: asString(address.province) || "",
    PostalCode: asString(address.postal_code) || "",
    Country: asString(address.country_code) || "",
  }
}

function buildQuickbooksLineItems(items: Record<string, unknown>[], quickbooksItems: Record<string, unknown>[]) {
  const lineItems: Record<string, unknown>[] = []

  // Create a map for faster SKU lookup
  const quickbooksItemsBySku = new Map<string, Record<string, unknown>>()
  for (const qbItem of quickbooksItems) {
    const sku = asString(qbItem.Sku)?.trim()
    if (sku && !quickbooksItemsBySku.has(sku)) {
      quickbooksItemsBySku.set(sku, qbItem)
    }
  }

  // Find fallback items
  const servicesItem = quickbooksItems.find(i => asString(i.Name) === "Services")
  const productsItem = quickbooksItems.find(i => asString(i.Name) === "Products")
  const firstAvailableItem = quickbooksItems.length > 0 ? quickbooksItems[0] : null

  const defaultItem = servicesItem || productsItem || firstAvailableItem

  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    const itemRecord = asRecord(item)

    const quantity = asNumber(itemRecord?.quantity) || 1
    const unitPrice = asNumber(itemRecord?.unit_price) || 0
    const amount = asNumber(itemRecord?.total) || unitPrice * quantity
    const sku = asString(itemRecord?.sku)?.trim()

    const description = (asString(itemRecord?.title) || "Product").substring(0, 400)

    // Try to match by SKU, otherwise use fallback
    const matchedItem = (sku ? quickbooksItemsBySku.get(sku) : null) || defaultItem

    if (!matchedItem) {
      console.warn(`[order-sync] No QuickBooks item found for SKU "${sku}" and no fallback available. Line item might be invalid.`)
    }

    lineItems.push({
      Id: String(i + 1),
      LineNum: i + 1,
      Description: description,
      Amount: Math.round(amount * 100) / 100,
      DetailType: "SalesItemLineDetail",
      SalesItemLineDetail: {
        ItemRef: {
          value: asString(matchedItem?.Id) || "1", // Fallback to "1" only as last last resort
          name: asString(matchedItem?.Name) || "Services",
        },
        Qty: quantity,
        UnitPrice: Math.round(unitPrice * 100) / 100,
      },
    })
  }

  return lineItems
}

function buildQuickbooksSalesReceiptPayload(input: {
  order: Record<string, unknown>
  quickbooksCustomerId: string | null
  quickbooksItems: Record<string, unknown>[]
}) {
  const order = input.order
  const orderRecord = asRecord(order)

  const items = Array.isArray(orderRecord?.items) ? orderRecord.items : []
  const shippingMethods = Array.isArray(orderRecord?.shipping_methods)
    ? orderRecord.shipping_methods
    : []

  const summary = asRecord(orderRecord?.summary)
  const taxTotal = asNumber(summary?.tax_total) || 0
  const shippingTotal = asNumber(summary?.shipping_total) || 0
  const discountTotal = asNumber(summary?.discount_total) || 0

  const taxItem = input.quickbooksItems.find(
    (i) => i.Name === "Services" || i.Name === "Products" || i.FullyQualifiedName === "Services"
  ) || input.quickbooksItems[0]

  const lineItems = buildQuickbooksLineItems(items, input.quickbooksItems)

  if (shippingTotal > 0) {
    lineItems.push({
      Id: String(lineItems.length + 1),
      LineNum: lineItems.length + 1,
      Description: "Shipping",
      Amount: Math.round(shippingTotal * 100) / 100,
      DetailType: "SalesItemLineDetail",
      SalesItemLineDetail: {
        ItemRef: {
          value: "1",
          name: "Services",
        },
        Qty: 1,
        UnitPrice: Math.round(shippingTotal * 100) / 100,
      },
    })
  }

  if (discountTotal > 0) {
    lineItems.push({
      Id: String(lineItems.length + 1),
      LineNum: lineItems.length + 1,
      Description: "Discount",
      Amount: -Math.round(discountTotal * 100) / 100,
      DetailType: "SalesItemLineDetail",
      SalesItemLineDetail: {
        ItemRef: {
          value: "1",
          name: "Services",
        },
        Qty: 1,
        UnitPrice: -Math.round(discountTotal * 100) / 100,
      },
    })
  }

  // Add Item Tax Lines
  for (const item of items) {
    const itemRecord = asRecord(item)
    const itemUnitPrice = asNumber(itemRecord?.unit_price) || 0
    const itemQuantity = asNumber(itemRecord?.quantity) || 0
    const taxLines = Array.isArray(itemRecord?.tax_lines) ? itemRecord.tax_lines : []
    
    for (const taxLine of taxLines) {
      const taxRecord = asRecord(taxLine)
      let amount = asNumber(taxRecord?.total) || asNumber(taxRecord?.amount) || 0
      
      // Fallback: Compute from rate if amount is missing
      if (amount === 0) {
        const rate = asNumber(taxRecord?.rate) || 0
        if (rate > 0) {
          amount = (itemUnitPrice * itemQuantity * rate) / 100
        }
      }

      if (amount !== 0) {
        lineItems.push({
          Id: String(lineItems.length + 1),
          LineNum: lineItems.length + 1,
          Description: `Tax: ${asString(taxRecord?.description) || asString(taxRecord?.code) || "Tax"}`,
          Amount: Math.round(amount * 100) / 100,
          DetailType: "SalesItemLineDetail",
          SalesItemLineDetail: {
            ItemRef: {
              value: taxItem?.Id as string,
              name: (taxItem?.Name as string) || "Services",
            },
            Qty: 1,
            UnitPrice: Math.round(amount * 100) / 100,
          },
        })
      }
    }
  }

  // Add Shipping Tax Lines
  for (const method of shippingMethods) {
    const methodRecord = asRecord(method)
    const methodAmount = asNumber(methodRecord?.total) || asNumber(methodRecord?.amount) || 0
    const taxLines = Array.isArray(methodRecord?.tax_lines) ? methodRecord.tax_lines : []

    for (const taxLine of taxLines) {
      const taxRecord = asRecord(taxLine)
      let amount = asNumber(taxRecord?.total) || asNumber(taxRecord?.amount) || 0
      
      // Fallback: Compute from rate if amount is missing
      if (amount === 0) {
        const rate = asNumber(taxRecord?.rate) || 0
        if (rate > 0) {
          amount = (methodAmount * rate) / 100
        }
      }

      if (amount !== 0) {
        lineItems.push({
          Id: String(lineItems.length + 1),
          LineNum: lineItems.length + 1,
          Description: `Shipping Tax: ${asString(taxRecord?.description) || asString(taxRecord?.code) || "Tax"}`,
          Amount: Math.round(amount * 100) / 100,
          DetailType: "SalesItemLineDetail",
          SalesItemLineDetail: {
            ItemRef: {
              value: taxItem?.Id as string,
              name: (taxItem?.Name as string) || "Services",
            },
            Qty: 1,
            UnitPrice: Math.round(amount * 100) / 100,
          },
        })
      }
    }
  }

  const payload: Record<string, unknown> = {
    Line: lineItems,
    TxnDate: formatQuickbooksDate(new Date()),
    PrivateNote: `Medusa Order: ${asString(orderRecord?.id) || "unknown"}`,
    GlobalTaxCalculation: "TaxExcluded", // Use Medusa's tax amounts exactly
  }

  if (input.quickbooksCustomerId) {
    payload.CustomerRef = {
      value: input.quickbooksCustomerId,
    }
  }

  const email = asString(orderRecord?.email)
  if (email) {
    payload.BillEmail = {
      Address: email,
    }
  }

  const billingAddress = asRecord(orderRecord?.billing_address)
  if (billingAddress) {
    payload.BillAddr = buildQuickbooksAddress(billingAddress)
  }

  const shippingAddress = asRecord(orderRecord?.shipping_address)
  if (shippingAddress) {
    payload.ShipAddr = buildQuickbooksAddress(shippingAddress)
  }

  const totalAmount = lineItems.reduce((sum: number, item: Record<string, unknown>) => {
    return sum + (asNumber(item.Amount) || 0)
  }, 0)
  payload.TotalAmt = Math.round(totalAmount * 100) / 100

  return payload
}

async function getMedusaOrderById(scope: ScopeLike, orderId: string) {
  const query = scope.resolve(ContainerRegistrationKeys.QUERY) as {
    graph: (input: {
      entity: string
      fields: string[]
      filters?: Record<string, unknown>
    }) => Promise<{ data?: Record<string, unknown>[] }>
  }

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
        "items.tax_lines.*",
        "shipping_methods.*",
        "shipping_methods.tax_lines.*",
        "summary.*",
        "transactions.*",
        "item_total",
        "item_subtotal",
        "item_tax_total",
        "shipping_total",
        "shipping_subtotal",
        "shipping_tax_total",
        "tax_total",
        "total",
        "subtotal",
        "discount_total",
        "created_at",
      ],
      filters: {
        id: [orderId],
      },
    })

    return response.data?.[0] ?? null
  } catch (error) {
    console.error("[order-sync] failed to fetch order", { orderId, error })
    return null
  }
}

async function findQuickbooksCustomerByEmail(
  scope: ScopeLike,
  email: string
): Promise<string | null> {
  const { config, connection } = await getReadyQuickbooksConnection(scope)

  if (!connection) {
    return null
  }

  try {
    const customers = await findQuickbooksCustomers(connection, config, {
      PrimaryEmailAddr: email,
    })

    if (customers.length > 0 && customers[0].Id) {
      return asString(customers[0].Id)
    }
  } catch (error) {
    console.error("[order-sync] failed to find customer", { email, error })
  }

  return null
}

async function getQuickbooksCustomerIdByMedusaCustomerId(
  scope: ScopeLike,
  medusaCustomerId: string
): Promise<string | null> {
  const quickbooksService: QuickbooksModuleService = scope.resolve(QUICKBOOKS_MODULE)
  const customerLink = await quickbooksService.getCustomerLinkByMedusaCustomerId(
    medusaCustomerId
  )

  if (customerLink?.quickbooks_customer_id) {
    return customerLink.quickbooks_customer_id
  }

  return null
}

function computeOrderHash(order: Record<string, unknown>): string {
  const orderRecord = asRecord(order)
  const items = Array.isArray(orderRecord?.items) ? orderRecord.items : []
  const summary = asRecord(orderRecord?.summary)

  const hashData = {
    id: orderRecord?.id,
    display_id: orderRecord?.display_id,
    version: orderRecord?.version,
    status: orderRecord?.status,
    items: items.map((item) => ({
      id: asString(item?.id),
      quantity: item?.quantity,
      unit_price: item?.unit_price,
      total: item?.total,
    })),
    summary: {
      total: summary?.total,
      subtotal: summary?.subtotal,
      tax_total: summary?.tax_total,
      shipping_total: summary?.shipping_total,
      discount_total: summary?.discount_total,
    },
    updated_at: orderRecord?.updated_at,
  }

  return JSON.stringify(hashData)
}

async function createSalesReceipt(
  connection: {
    realm_id?: string | null
    access_token?: string | null
    refresh_token?: string | null
  },
  config: ReturnType<typeof getQuickbooksConfig>,
  payload: Record<string, unknown>
) {
  const client = createQuickbooksClient(connection, config)

  return await new Promise<Record<string, unknown> | null>((resolve, reject) => {
    client.createSalesReceipt(payload, (error: Error, salesReceipt: unknown, response: unknown) => {
      console.log("!!! [order-debug] QB SalesReceipt response:", JSON.stringify(salesReceipt, null, 2))
      if (error) {
        try {
          const safeResponse = { status: (response as { status?: number })?.status, data: (response as { data?: unknown })?.data }
          console.error("[quickbooks-order-sync] QB error response:", JSON.stringify(safeResponse, null, 2))
        } catch {
          console.error("[quickbooks-order-sync] QB error response: (circular)", error.message)
        }
        reject(error)
        return
      }

      resolve((salesReceipt as Record<string, unknown>) || null)
    })
  })
}

export async function syncMedusaOrderToQuickbooks(
  scope: ScopeLike,
  medusaOrderId: string
) {
  const { config, connection, quickbooksService } = await getReadyQuickbooksConnection(scope)

  if (!connection) {
    return { skipped: true, reason: "QuickBooks link not found or not connected." }
  }

  // Debug: Log all TaxRates to find the right IDs
  try {
    const taxRates = await findQuickbooksTaxRates(connection, config)
    console.log("!!! [order-debug] QB TaxRates:", JSON.stringify(taxRates.map(r => ({ Id: r.Id, Name: r.Name, RateValue: r.RateValue })), null, 2))
  } catch (err) {
    console.error("!!! [order-debug] Failed to fetch QB TaxRates:", err.message)
  }

  const order = await getMedusaOrderById(scope, medusaOrderId)

  if (!order) {
    return { skipped: true, reason: "Order not found in Medusa." }
  }

  console.log(`!!! [order-debug] Order ${order.display_id} total: ${order.total}, tax_total: ${order.tax_total}`)
  if (Array.isArray(order.items) && order.items.length > 0) {
     console.log(`!!! [order-debug] Item 0 tax_lines: ${JSON.stringify(order.items[0].tax_lines)}`)
  }

  const orderRecord = asRecord(order)
  const status = asString(orderRecord?.status)

  if (status !== "completed") {
    return {
      skipped: true,
      reason: `Order status is "${status}", only completed orders can be synced.`,
    }
  }

  // Fetch QuickBooks items for SKU matching
  let quickbooksItems: Record<string, unknown>[] = []
  try {
    quickbooksItems = await findQuickbooksItems(connection, config)
  } catch (error) {
    console.error("[order-sync] failed to fetch QuickBooks items", error)
    // Continue with empty list, will use fallback or fail gracefully
  }

  const customerId = asString(orderRecord?.customer_id)
  let quickbooksCustomerId: string | null = null

  if (customerId) {
    quickbooksCustomerId = await getQuickbooksCustomerIdByMedusaCustomerId(
      scope,
      customerId
    )
  }

  if (!quickbooksCustomerId) {
    console.log("[order-sync] no customer link found, will create sales receipt without customer reference")
  }

  const existingLink = await quickbooksService.getOrderLinkByMedusaOrderId(
    medusaOrderId
  )

  if (existingLink?.quickbooks_sales_receipt_id) {
    return {
      skipped: true,
      reason: "Order has already been synced to QuickBooks.",
      quickbooks_sales_receipt_id: existingLink.quickbooks_sales_receipt_id,
    }
  }

  const orderHash = computeOrderHash(order)

  if (existingLink?.last_synced_hash === orderHash) {
    return {
      skipped: true,
      reason: "Order has not changed since last sync.",
    }
  }

  const payload = buildQuickbooksSalesReceiptPayload({
    order,
    quickbooksCustomerId,
    quickbooksItems,
  })

  console.log("[quickbooks-order-sync] creating sales receipt", {
    medusa_order_id: medusaOrderId,
    display_id: orderRecord?.display_id,
    quickbooks_customer_id: quickbooksCustomerId,
    payload: JSON.stringify(payload),
  })

  try {
    const salesReceipt = await createSalesReceipt(connection, config, payload)

    if (!salesReceipt?.Id) {
      return {
        skipped: true,
        reason: "QuickBooks did not return a persisted sales receipt.",
      }
    }

    await quickbooksService.upsertOrderLink({
      medusa_order_id: medusaOrderId,
      quickbooks_sales_receipt_id: asString(salesReceipt.Id),
      quickbooks_sync_token: asString(salesReceipt.SyncToken),
      realm_id: connection.realm_id,
      sync_type: "sales_receipt",
      last_synced_hash: orderHash,
      last_synced_at: new Date(),
    })

    console.log("[quickbooks-order-sync] order synced", {
      medusa_order_id: medusaOrderId,
      display_id: orderRecord?.display_id,
      quickbooks_sales_receipt_id: salesReceipt.Id,
    })

    return {
      skipped: false,
      medusa_order_id: medusaOrderId,
      quickbooks_sales_receipt_id: asString(salesReceipt.Id),
      doc_number: asString(salesReceipt.DocNumber),
      txn_date: salesReceipt.TxnDate,
      direction: "medusa_to_quickbooks",
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error"
    console.error("[quickbooks-order-sync] failed to sync order", {
      medusa_order_id: medusaOrderId,
      error: errorMessage,
    })

    return {
      skipped: true,
      reason: `Failed to sync order: ${errorMessage}`,
    }
  }
}

export async function syncMedusaOrdersToQuickbooks(
  scope: ScopeLike,
  medusaOrderIds: string[]
) {
  const uniqueIds = [...new Set(medusaOrderIds.filter(Boolean))]
  const results: Record<string, unknown>[] = []
  let synced = 0
  let skipped = 0

  for (const orderId of uniqueIds) {
    const result = await syncMedusaOrderToQuickbooks(scope, orderId)

    results.push(result)

    if (result.skipped) {
      skipped += 1
    } else {
      synced += 1
    }

    console.log("[quickbooks-order-sync] sync result", {
      medusa_order_id: orderId,
      synced: !result.skipped,
      reason: result.reason || null,
    })
  }

  console.log("[quickbooks-order-sync] bulk sync summary", {
    count: uniqueIds.length,
    synced,
    skipped,
  })

  return {
    count: uniqueIds.length,
    synced,
    skipped,
    results,
    direction: "medusa_to_quickbooks",
  }
}

async function listAllMedusaCompletedOrderIds(scope: ScopeLike) {
  const orderModuleService = scope.resolve("order") as OrderModuleService
  const orderIds: string[] = []
  let skip = 0
  let total = 0

  do {
    const [orders, count] = await orderModuleService.listAndCountOrders(
      { status: ["completed"] },
      {
        take: ORDER_SYNC_BATCH_SIZE,
        skip,
        order: { created_at: "DESC" },
      }
    )

    total = count

    for (const order of orders) {
      const orderId = asString(order.id)

      if (orderId) {
        orderIds.push(orderId)
      }
    }

    skip += orders.length

    if (!orders.length) {
      break
    }
  } while (skip < total)

  return orderIds
}

export async function syncAllMedusaOrdersToQuickbooks(scope: ScopeLike) {
  const medusaOrderIds = await listAllMedusaCompletedOrderIds(scope)

  if (medusaOrderIds.length === 0) {
    return {
      count: 0,
      synced: 0,
      skipped: 0,
      results: [],
      message: "No completed orders found to sync.",
    }
  }

  return await syncMedusaOrdersToQuickbooks(scope, medusaOrderIds)
}