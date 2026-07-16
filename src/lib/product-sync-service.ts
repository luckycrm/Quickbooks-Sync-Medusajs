import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import {
  batchQuickbooksRequests,
  createQuickbooksItem,
  findQuickbooksAccounts,
  findQuickbooksItems,
  getQuickbooksAccount,
  getQuickbooksConfig,
  getQuickbooksItem,
  safeUpdateQuickbooksItem,
} from "./quickbooks";
import { getReadyQuickbooksConnection } from "./connection";
import { shouldSkipQuickbooksItemWebhook } from "./product-sync";

type ScopeLike = {
  resolve: (name: string) => any;
};

const PRODUCT_SYNC_BATCH_SIZE = 100;

// QuickBooks Batch API allows 30 operations per request. Three requests in
// flight keeps well under the 500 requests/minute per-realm throttle while
// syncing large catalogs in minutes instead of hours.
const QUICKBOOKS_BATCH_SIZE = 30;
const QUICKBOOKS_BATCH_CONCURRENCY = 3;

// QuickBooks item names are capped at 100 characters and must be unique.
const QUICKBOOKS_ITEM_NAME_MAX_LENGTH = 100;

const extractQuickbooksItemFault = (value: unknown) => {
  const fault = asRecord(asRecord(value)?.Fault);
  const errors = Array.isArray(fault?.Error) ? fault.Error : [];
  const faultError = asRecord(errors[0]);

  if (!faultError) {
    return null;
  }

  const message =
    typeof faultError.Message === "string"
      ? faultError.Message
      : "QuickBooks request failed";
  const detail =
    typeof faultError.Detail === "string" ? `: ${faultError.Detail}` : "";

  return {
    code: String(faultError.code ?? ""),
    message: `${message}${detail}`,
  };
};

const isDuplicateQuickbooksNameError = (error: unknown) => {
  const fault = extractQuickbooksItemFault(
    (error as { response?: { data?: unknown } } | null)?.response?.data,
  );

  if (fault?.code === "6240") {
    return true;
  }

  const message =
    fault?.message || (error instanceof Error ? error.message : "");

  return message.toLowerCase().includes("duplicate name");
};

const truncateQuickbooksItemName = (name: string, suffix = "") =>
  `${name.slice(0, QUICKBOOKS_ITEM_NAME_MAX_LENGTH - suffix.length)}${suffix}`;

const asRecord = (value: unknown) => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return null;
};

const asString = (value: unknown) => (typeof value === "string" ? value : null);

const asNumber = (value: unknown) => (typeof value === "number" ? value : null);

const isPublishedProduct = (product: Record<string, unknown>) =>
  asString(product.status) === "published";

const formatQuickbooksDate = (value: Date) => value.toISOString().slice(0, 10);

const buildQuickbooksItemName = (input: {
  product: Record<string, unknown>;
  variant: Record<string, unknown>;
  variantCount: number;
}) => {
  const productTitle = asString(input.product.title) || "Untitled Product";
  const variantTitle = asString(input.variant.title);

  if (
    input.variantCount <= 1 ||
    !variantTitle ||
    variantTitle === "Default Variant"
  ) {
    return productTitle;
  }

  return `${productTitle} - ${variantTitle}`;
};

type QuickbooksProductSyncConfig = {
  incomeAccountId: string | null;
  incomeAccountName: string | null;
  expenseAccountId: string | null;
  expenseAccountName: string | null;
  assetAccountId: string | null;
  assetAccountName: string | null;
  priceCurrency: string;
};

const getQuickbooksProductSyncConfig = (): QuickbooksProductSyncConfig => {
  const expenseAccountId =
    process.env.QUICKBOOKS_PRODUCT_EXPENSE_ACCOUNT_ID?.trim() || null;
  const expenseAccountName =
    process.env.QUICKBOOKS_PRODUCT_EXPENSE_ACCOUNT_NAME?.trim() || null;
  const assetAccountId =
    process.env.QUICKBOOKS_PRODUCT_ASSET_ACCOUNT_ID?.trim() || null;
  const assetAccountName =
    process.env.QUICKBOOKS_PRODUCT_ASSET_ACCOUNT_NAME?.trim() || null;

  return {
    incomeAccountId: null,
    incomeAccountName: null,
    expenseAccountId,
    expenseAccountName,
    assetAccountId,
    assetAccountName,
    priceCurrency:
      process.env.QUICKBOOKS_PRICE_CURRENCY?.trim().toLowerCase() || "usd",
  };
};

async function resolveQuickbooksProductSyncConfig(input: {
  connection: {
    realm_id?: string | null;
    access_token?: string | null;
    refresh_token?: string | null;
    quickbooks_product_income_account_id?: string | null;
    quickbooks_product_income_account_name?: string | null;
    quickbooks_price_currency?: string | null;
  };
  config: ReturnType<typeof getQuickbooksConfig>;
}) {
  const syncConfig = getQuickbooksProductSyncConfig();

  if (input.connection.quickbooks_price_currency) {
    syncConfig.priceCurrency =
      input.connection.quickbooks_price_currency.toLowerCase();
  }

  if (input.connection.quickbooks_product_income_account_id) {
    syncConfig.incomeAccountId =
      input.connection.quickbooks_product_income_account_id;
  }

  if (input.connection.quickbooks_product_income_account_name) {
    syncConfig.incomeAccountName =
      input.connection.quickbooks_product_income_account_name;
  }

  if (syncConfig.incomeAccountId) {
    const account = await getQuickbooksAccount(
      input.connection,
      input.config,
      syncConfig.incomeAccountId,
    );

    if (!account?.Id) {
      throw new Error(
        `QuickBooks income account ${syncConfig.incomeAccountId} was not found.`,
      );
    }

    syncConfig.incomeAccountName =
      asString(account.Name) || syncConfig.incomeAccountName;

    return syncConfig;
  }

  if (syncConfig.incomeAccountName) {
    const accounts = await findQuickbooksAccounts(
      input.connection,
      input.config,
      {
        Name: syncConfig.incomeAccountName,
      },
    );
    const account = accounts[0] || null;

    if (!account?.Id) {
      throw new Error(
        `QuickBooks income account named "${syncConfig.incomeAccountName}" was not found.`,
      );
    }

    syncConfig.incomeAccountId = asString(account.Id);
    syncConfig.incomeAccountName =
      asString(account.Name) || syncConfig.incomeAccountName;

    return syncConfig;
  }

  const incomeAccounts = await findQuickbooksAccounts(
    input.connection,
    input.config,
    {
      AccountType: "Income",
      Active: true,
    },
  );

  // Single active income account, or the QuickBooks default product income
  // account — otherwise the user must pick one in the settings page.
  const autoSelected =
    incomeAccounts.length === 1
      ? incomeAccounts[0]
      : incomeAccounts.find(
          (account) => asString(account.Name) === "Sales of Product Income",
        );

  if (autoSelected) {
    syncConfig.incomeAccountId = asString(autoSelected.Id);
    syncConfig.incomeAccountName = asString(autoSelected.Name);

    console.log("[quickbooks-sync] auto-selected income account", {
      quickbooks_account_id: syncConfig.incomeAccountId,
      quickbooks_account_name: syncConfig.incomeAccountName,
      direction: "medusa_to_quickbooks",
    });
  }

  return syncConfig;
}

type ProductQuery = {
  graph: (input: {
    entity: string;
    fields: string[];
    filters?: Record<string, unknown>;
    pagination?: { skip?: number; take?: number };
  }) => Promise<{ data?: Record<string, unknown>[] }>;
};

// Variant prices live in the pricing module, so products must be fetched via
// query.graph — the product module service cannot see them.
const PRODUCT_SYNC_FIELDS = [
  "id",
  "title",
  "handle",
  "status",
  "variants.id",
  "variants.title",
  "variants.sku",
  "variants.upc",
  "variants.ean",
  "variants.barcode",
  "variants.manage_inventory",
  "variants.prices.amount",
  "variants.prices.currency_code",
];

async function getMedusaProductById(scope: ScopeLike, productId: string) {
  const query = scope.resolve(ContainerRegistrationKeys.QUERY) as ProductQuery;
  const response = await query.graph({
    entity: "product",
    fields: PRODUCT_SYNC_FIELDS,
    filters: { id: [productId] },
  });

  return response.data?.[0] ?? null;
}

async function listAllMedusaProducts(scope: ScopeLike) {
  const query = scope.resolve(ContainerRegistrationKeys.QUERY) as ProductQuery;
  const products: Record<string, unknown>[] = [];
  let skip = 0;

  while (true) {
    const response = await query.graph({
      entity: "product",
      fields: PRODUCT_SYNC_FIELDS,
      pagination: { skip, take: PRODUCT_SYNC_BATCH_SIZE },
    });

    const batch = response.data ?? [];
    products.push(...batch);

    if (batch.length < PRODUCT_SYNC_BATCH_SIZE) {
      break;
    }

    skip += batch.length;
  }

  return products;
}

// The QuickBooks sales price comes from the variant price in the configured
// currency (settings page selection, falling back to QUICKBOOKS_PRICE_CURRENCY
// env, then "usd"); falls back to the variant's first price. Medusa stores
// prices as-is ($49.99 = 49.99).
const resolveVariantUnitPrice = (
  variant: Record<string, unknown>,
  preferredCurrency: string,
) => {
  const prices = Array.isArray(variant.prices) ? variant.prices : [];

  const preferred = prices.find(
    (price) =>
      asString(asRecord(price)?.currency_code)?.toLowerCase() ===
      preferredCurrency,
  );

  return asNumber(asRecord(preferred ?? prices[0])?.amount);
};

async function getMedusaInventoryQuantityBySku(scope: ScopeLike, sku: string) {
  const query = scope.resolve(ContainerRegistrationKeys.QUERY) as {
    graph: (input: {
      entity: string;
      fields: string[];
      filters?: Record<string, unknown>;
    }) => Promise<{ data?: Record<string, unknown>[] }>;
  };

  try {
    const response = await query.graph({
      entity: "inventory_item",
      fields: ["id", "sku"],
      filters: {
        sku,
      },
    });

    if (!response.data?.length) {
      return null;
    }
  } catch {
    return null;
  }

  return null;
}

function buildQuickbooksItemPayload(input: {
  product: Record<string, unknown>;
  variant: Record<string, unknown>;
  variantCount: number;
  existingItem: Record<string, unknown> | null;
  inventoryQuantity: number | null;
  syncConfig: QuickbooksProductSyncConfig;
}) {
  const sku = asString(input.variant.sku);

  if (!sku) {
    return {
      skipped: true,
      reason: "Variant SKU is required for QuickBooks item sync.",
    };
  }

  const trackInventory = Boolean(input.variant.manage_inventory);
  const canCreateInventoryItem =
    !!input.syncConfig.incomeAccountId &&
    !!input.syncConfig.expenseAccountId &&
    !!input.syncConfig.assetAccountId;
  const existingType = asString(input.existingItem?.Type);
  const shouldUseInventoryType =
    trackInventory && (canCreateInventoryItem || existingType === "Inventory");

  if (!input.existingItem && !input.syncConfig.incomeAccountId) {
    return {
      skipped: true,
      reason:
        "A QuickBooks income account is required to create new QuickBooks items. Select one in QuickBooks Settings or keep exactly one active Income account in QuickBooks.",
    };
  }

  const unitPrice = resolveVariantUnitPrice(
    input.variant,
    input.syncConfig.priceCurrency,
  );

  const payload: Record<string, unknown> = {
    Name: buildQuickbooksItemName(input),
    Sku: sku,
    Active: isPublishedProduct(input.product),
    Type: shouldUseInventoryType ? "Inventory" : "NonInventory",
    ...(unitPrice !== null ? { UnitPrice: unitPrice } : {}),
    Description: JSON.stringify({
      medusa_product_id: input.product.id || null,
      medusa_variant_id: input.variant.id || null,
      medusa_handle: input.product.handle || null,
      // QuickBooks items have no dedicated UPC/barcode field, so identifiers
      // are preserved in the description metadata.
      upc: asString(input.variant.upc) || null,
      ean: asString(input.variant.ean) || null,
      barcode: asString(input.variant.barcode) || null,
    }),
  };

  const incomeAccountId =
    asString(asRecord(input.existingItem?.IncomeAccountRef)?.value) ||
    input.syncConfig.incomeAccountId;
  const incomeAccountName =
    asString(asRecord(input.existingItem?.IncomeAccountRef)?.name) ||
    input.syncConfig.incomeAccountName;

  if (incomeAccountId) {
    payload.IncomeAccountRef = {
      value: incomeAccountId,
      ...(incomeAccountName ? { name: incomeAccountName } : {}),
    };
  }

  if (shouldUseInventoryType) {
    const expenseAccountId =
      asString(asRecord(input.existingItem?.ExpenseAccountRef)?.value) ||
      input.syncConfig.expenseAccountId;
    const expenseAccountName =
      asString(asRecord(input.existingItem?.ExpenseAccountRef)?.name) ||
      input.syncConfig.expenseAccountName;
    const assetAccountId =
      asString(asRecord(input.existingItem?.AssetAccountRef)?.value) ||
      input.syncConfig.assetAccountId;
    const assetAccountName =
      asString(asRecord(input.existingItem?.AssetAccountRef)?.name) ||
      input.syncConfig.assetAccountName;

    payload.TrackQtyOnHand = true;
    payload.QtyOnHand =
      input.inventoryQuantity ?? asNumber(input.existingItem?.QtyOnHand) ?? 0;
    payload.InvStartDate =
      asString(input.existingItem?.InvStartDate) ||
      formatQuickbooksDate(new Date());

    if (expenseAccountId) {
      payload.ExpenseAccountRef = {
        value: expenseAccountId,
        ...(expenseAccountName ? { name: expenseAccountName } : {}),
      };
    }

    if (assetAccountId) {
      payload.AssetAccountRef = {
        value: assetAccountId,
        ...(assetAccountName ? { name: assetAccountName } : {}),
      };
    }
  }

  if (input.existingItem?.Id && input.existingItem?.SyncToken) {
    payload.Id = input.existingItem.Id;
    payload.SyncToken = input.existingItem.SyncToken;
    payload.sparse = true;
  }

  return {
    skipped: false,
    payload,
  };
}

export async function syncQuickbooksItemToMedusaById(
  scope: ScopeLike,
  quickbooksItemId: string,
) {
  const { config, connection } = await getReadyQuickbooksConnection(scope);

  if (!connection) {
    return { skipped: true, reason: "QuickBooks is not connected." };
  }

  const syncConfig = await resolveQuickbooksProductSyncConfig({
    connection,
    config,
  });

  const quickbooksItem = await getQuickbooksItem(
    connection,
    config,
    quickbooksItemId,
  );

  if (!quickbooksItem) {
    return { skipped: true, reason: "QuickBooks item not found." };
  }

  const inventoryDecision = shouldSkipQuickbooksItemWebhook(quickbooksItem);

  if (inventoryDecision.skipped) {
    return {
      ...inventoryDecision,
      quickbooks_item_id: quickbooksItemId,
    };
  }

  return {
    skipped: true,
    quickbooks_item_id: quickbooksItemId,
    reason:
      "QuickBooks item webhook received, but inbound product field syncing is not implemented yet.",
    source_of_truth: "medusa",
  };
}

export async function syncMedusaProductToQuickbooks(
  scope: ScopeLike,
  medusaProductId: string,
) {
  const product = await getMedusaProductById(scope, medusaProductId);

  if (!product) {
    return { skipped: true, reason: "Product not found in Medusa." };
  }

  const variants = Array.isArray(product.variants) ? product.variants : [];

  if (!variants.length) {
    return { skipped: true, reason: "Product has no variants to sync." };
  }

  const { config, connection } = await getReadyQuickbooksConnection(scope);

  if (!connection) {
    return { skipped: true, reason: "QuickBooks is not connected." };
  }

  const syncConfig = await resolveQuickbooksProductSyncConfig({
    connection,
    config,
  });

  const results: Array<Record<string, unknown>> = [];
  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const variant of variants) {
    const sku = asString(variant.sku)?.trim() || null;

    if (!sku) {
      skipped += 1;
      console.log("[quickbooks-sync] variant skipped", {
        medusa_product_id: medusaProductId,
        variant_id: variant.id || null,
        sku: null,
        reason: "Variant SKU is required for QuickBooks item sync.",
        direction: "medusa_to_quickbooks",
      });
      results.push({
        variant_id: variant.id || null,
        sku: null,
        skipped: true,
        reason: "Variant SKU is required for QuickBooks item sync.",
      });
      continue;
    }

    const existingItem =
      (
        await findQuickbooksItems(connection, config, {
          Sku: sku,
        })
      )[0] || null;

    const inventoryQuantity = await getMedusaInventoryQuantityBySku(scope, sku);
    const payloadDecision = buildQuickbooksItemPayload({
      product,
      variant,
      variantCount: variants.length,
      existingItem,
      inventoryQuantity,
      syncConfig,
    });

    if (payloadDecision.skipped) {
      skipped += 1;
      console.log("[quickbooks-sync] variant skipped", {
        medusa_product_id: medusaProductId,
        variant_id: variant.id || null,
        sku,
        reason: payloadDecision.reason,
        direction: "medusa_to_quickbooks",
      });
      results.push({
        variant_id: variant.id || null,
        sku,
        skipped: true,
        reason: payloadDecision.reason,
      });
      continue;
    }

    const quickbooksPayload = payloadDecision.payload as Record<
      string,
      unknown
    >;

    let syncedItem: Record<string, unknown> | null = null;

    if (existingItem) {
      syncedItem = await safeUpdateQuickbooksItem(
        connection,
        config,
        existingItem,
        quickbooksPayload,
      );
    } else {
      try {
        syncedItem = await createQuickbooksItem(
          connection,
          config,
          quickbooksPayload,
        );
      } catch (error) {
        if (!isDuplicateQuickbooksNameError(error)) {
          throw error;
        }

        // Another item already uses this name — make it unique with the SKU.
        syncedItem = await createQuickbooksItem(connection, config, {
          ...quickbooksPayload,
          Name: truncateQuickbooksItemName(
            String(quickbooksPayload.Name || "Item"),
            ` (${sku})`,
          ),
        });
      }
    }

    if (!syncedItem?.Id) {
      skipped += 1;
      console.log("[quickbooks-sync] variant skipped", {
        medusa_product_id: medusaProductId,
        variant_id: variant.id || null,
        sku,
        reason: "QuickBooks did not return a persisted item.",
        direction: "medusa_to_quickbooks",
      });
      results.push({
        variant_id: variant.id || null,
        sku,
        skipped: true,
        reason: "QuickBooks did not return a persisted item.",
      });
      continue;
    }

    if (existingItem) {
      updated += 1;
    } else {
      created += 1;
    }

    console.log("[quickbooks-sync] variant synced", {
      medusa_product_id: medusaProductId,
      variant_id: variant.id || null,
      sku,
      action: existingItem ? "updated" : "created",
      quickbooks_item_id: String(syncedItem.Id),
      direction: "medusa_to_quickbooks",
    });

    results.push({
      variant_id: variant.id || null,
      sku,
      skipped: false,
      action: existingItem ? "updated" : "created",
      quickbooks_item_id: String(syncedItem.Id),
    });
  }

  return {
    skipped: false,
    medusa_product_id: medusaProductId,
    created,
    updated,
    skipped_variants: skipped,
    results,
    direction: "medusa_to_quickbooks",
  };
}

export async function syncMedusaProductsToQuickbooks(
  scope: ScopeLike,
  medusaProductIds: string[],
) {
  const uniqueIds = [...new Set(medusaProductIds.filter(Boolean))];
  const results: Record<string, unknown>[] = [];
  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const productId of uniqueIds) {
    const result = await syncMedusaProductToQuickbooks(scope, productId);
    results.push(result);
    created += Number(result.created || 0);
    updated += Number(result.updated || 0);
    skipped += Number(result.skipped_variants || (result.skipped ? 1 : 0));

    console.log("[quickbooks-sync] product sync result", {
      medusa_product_id: productId,
      created: Number(result.created || 0),
      updated: Number(result.updated || 0),
      skipped_variants: Number(
        result.skipped_variants || (result.skipped ? 1 : 0),
      ),
      reason: result.reason || null,
      direction: "medusa_to_quickbooks",
    });
  }

  console.log("[quickbooks-sync] bulk sync summary", {
    count: uniqueIds.length,
    created,
    updated,
    skipped,
    direction: "medusa_to_quickbooks",
  });

  return {
    count: uniqueIds.length,
    created,
    updated,
    skipped,
    results,
    direction: "medusa_to_quickbooks",
  };
}

type BatchOperation = {
  payload: Record<string, unknown>;
  operation: "create" | "update";
  sku: string;
  medusa_product_id: string | null;
  variant_id: string | null;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// QuickBooks throttles at ~500 requests/minute per realm and batch payloads
// count individually, so batches are paced to ~400 operations per minute.
const BATCH_DISPATCH_INTERVAL_MS = Math.ceil(
  (60_000 * QUICKBOOKS_BATCH_SIZE) / 400,
);
const THROTTLE_MAX_RETRIES = 5;
const THROTTLE_DEFAULT_WAIT_MS = 60_000;

const isQuickbooksThrottleError = (error: unknown) => {
  const status = (error as { response?: { status?: number } } | null)?.response
    ?.status;

  if (status === 429) {
    return true;
  }

  const message = error instanceof Error ? error.message.toLowerCase() : "";

  return message.includes("429") || message.includes("throttle");
};

const getThrottleWaitMs = (error: unknown) => {
  const retryAfter = Number(
    (error as { response?: { headers?: Record<string, unknown> } } | null)
      ?.response?.headers?.["retry-after"],
  );

  return Number.isFinite(retryAfter) && retryAfter > 0
    ? retryAfter * 1000
    : THROTTLE_DEFAULT_WAIT_MS;
};

// Existing items whose synced fields already match are skipped entirely, so
// repeat runs cost almost no API operations.
const quickbooksItemNeedsUpdate = (
  existingItem: Record<string, unknown>,
  payload: Record<string, unknown>,
) => {
  const comparisons: Array<[unknown, unknown]> = [
    [asString(existingItem.Name)?.trim(), asString(payload.Name)?.trim()],
    [asString(existingItem.Sku)?.trim(), asString(payload.Sku)?.trim()],
    [existingItem.Active !== false, payload.Active !== false],
    [asString(existingItem.Type), asString(payload.Type)],
    [asString(existingItem.Description), asString(payload.Description)],
    [asNumber(existingItem.UnitPrice), asNumber(payload.UnitPrice)],
  ];

  return comparisons.some(
    ([current, next]) => (current ?? null) !== (next ?? null),
  );
};

// Only one full-catalog sync may run at a time — the route kicks it off in the
// background, so guard against double-clicks.
let fullSyncInProgress = false;

export const isFullProductSyncRunning = () => fullSyncInProgress;

// Full-catalog sync via the QuickBooks Batch API: one paginated item fetch,
// in-memory SKU matching, then 30 operations per request with limited
// concurrency, paced under the QuickBooks per-realm throttle.
export async function syncAllMedusaProductsToQuickbooks(scope: ScopeLike) {
  if (fullSyncInProgress) {
    return {
      count: 0,
      created: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      results: [],
      reason: "A full product sync is already running.",
    };
  }

  fullSyncInProgress = true;

  try {
    return await runFullProductSync(scope);
  } finally {
    fullSyncInProgress = false;
  }
}

async function runFullProductSync(scope: ScopeLike) {
  const { config, connection } = await getReadyQuickbooksConnection(scope);

  if (!connection) {
    return {
      count: 0,
      created: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      results: [],
      reason: "QuickBooks is not connected.",
    };
  }

  const syncConfig = await resolveQuickbooksProductSyncConfig({
    connection,
    config,
  });

  const [products, existingItems] = await Promise.all([
    listAllMedusaProducts(scope),
    findQuickbooksItems(connection, config),
  ]);

  const itemsBySku = new Map<string, Record<string, unknown>>();
  const usedNames = new Set<string>();

  for (const item of existingItems) {
    const sku = asString(item.Sku)?.trim();

    if (sku && !itemsBySku.has(sku)) {
      itemsBySku.set(sku, item);
    }

    const name = asString(item.Name)?.trim();

    if (name) {
      usedNames.add(name);
    }
  }

  const operations: BatchOperation[] = [];
  const failures: Record<string, unknown>[] = [];
  const skipReasons: Record<string, number> = {};
  let skipped = 0;

  const recordSkip = (reason: string) => {
    skipped += 1;
    skipReasons[reason] = (skipReasons[reason] || 0) + 1;
  };

  for (const product of products) {
    const variants = Array.isArray(product.variants) ? product.variants : [];
    const medusaProductId = asString(product.id);

    for (const variant of variants as Record<string, unknown>[]) {
      const sku = asString(variant.sku)?.trim() || null;

      if (!sku) {
        recordSkip("Variant SKU is required for QuickBooks item sync.");
        continue;
      }

      const existingItem = itemsBySku.get(sku) || null;
      const payloadDecision = buildQuickbooksItemPayload({
        product,
        variant,
        variantCount: variants.length,
        existingItem,
        inventoryQuantity: null,
        syncConfig,
      });

      if (payloadDecision.skipped) {
        recordSkip(String(payloadDecision.reason || "Skipped"));
        continue;
      }

      const payload = payloadDecision.payload as Record<string, unknown>;

      // Item names must be unique in QuickBooks; different products can share
      // a title, so deduplicate up-front with the SKU.
      const baseName = truncateQuickbooksItemName(
        String(payload.Name || "Item"),
      );
      const existingName = asString(existingItem?.Name)?.trim();
      const nameTakenByOther =
        usedNames.has(baseName) && existingName !== baseName;
      const finalName = nameTakenByOther
        ? truncateQuickbooksItemName(baseName, ` (${sku})`)
        : baseName;

      payload.Name = finalName;
      usedNames.add(finalName);

      if (existingItem && !quickbooksItemNeedsUpdate(existingItem, payload)) {
        recordSkip("Already up to date in QuickBooks.");
        continue;
      }

      operations.push({
        payload,
        operation: existingItem ? "update" : "create",
        sku,
        medusa_product_id: medusaProductId,
        variant_id: asString(variant.id),
      });
    }
  }

  const chunks: BatchOperation[][] = [];

  for (let i = 0; i < operations.length; i += QUICKBOOKS_BATCH_SIZE) {
    chunks.push(operations.slice(i, i + QUICKBOOKS_BATCH_SIZE));
  }

  let created = 0;
  let updated = 0;
  let failed = 0;
  let nextChunk = 0;
  let nextDispatchAt = 0;

  // Shared pacer: workers wait for a dispatch slot so combined request volume
  // stays under the QuickBooks throttle. The read-compare-set is synchronous,
  // so concurrent workers cannot claim the same slot.
  const acquireDispatchSlot = async () => {
    while (true) {
      const now = Date.now();

      if (now >= nextDispatchAt) {
        nextDispatchAt = now + BATCH_DISPATCH_INTERVAL_MS;
        return;
      }

      await sleep(nextDispatchAt - now);
    }
  };

  const sendBatchWithRetry = async (requests: Record<string, unknown>[]) => {
    let attempts = 0;

    while (true) {
      await acquireDispatchSlot();

      try {
        return await batchQuickbooksRequests(connection, config, requests);
      } catch (error) {
        attempts += 1;

        if (
          !isQuickbooksThrottleError(error) ||
          attempts > THROTTLE_MAX_RETRIES
        ) {
          throw error;
        }

        const waitMs = getThrottleWaitMs(error);

        console.log("[quickbooks-sync] throttled by QuickBooks, backing off", {
          wait_ms: waitMs,
          attempt: attempts,
        });

        await sleep(waitMs);
      }
    }
  };

  const runWorker = async () => {
    while (nextChunk < chunks.length) {
      const chunkIndex = nextChunk++;
      const chunk = chunks[chunkIndex];
      const requests = chunk.map((op, index) => ({
        bId: `${chunkIndex}-${index}`,
        operation: op.operation,
        Item: op.payload,
      }));

      try {
        const responses = await sendBatchWithRetry(requests);
        const responsesByBid = new Map(
          responses.map((response) => [String(response.bId), response]),
        );

        chunk.forEach((op, index) => {
          const response = responsesByBid.get(`${chunkIndex}-${index}`);
          const item = asRecord(response?.Item);

          if (item?.Id) {
            if (op.operation === "create") {
              created += 1;
            } else {
              updated += 1;
            }
            return;
          }

          failed += 1;
          const fault = extractQuickbooksItemFault(response);
          failures.push({
            sku: op.sku,
            medusa_product_id: op.medusa_product_id,
            variant_id: op.variant_id,
            reason: fault?.message || "QuickBooks did not return an item.",
          });
        });
      } catch (error) {
        failed += chunk.length;
        const reason =
          error instanceof Error ? error.message : "QuickBooks batch failed.";

        for (const op of chunk) {
          failures.push({
            sku: op.sku,
            medusa_product_id: op.medusa_product_id,
            variant_id: op.variant_id,
            reason,
          });
        }
      }

      console.log("[quickbooks-sync] batch progress", {
        chunk: chunkIndex + 1,
        chunks: chunks.length,
        created,
        updated,
        failed,
        direction: "medusa_to_quickbooks",
      });
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(QUICKBOOKS_BATCH_CONCURRENCY, chunks.length) },
      runWorker,
    ),
  );

  console.log("[quickbooks-sync] bulk batch sync summary", {
    variants: operations.length,
    created,
    updated,
    skipped,
    skip_reasons: skipReasons,
    failed,
    direction: "medusa_to_quickbooks",
  });

  return {
    count: operations.length + skipped,
    created,
    updated,
    skipped,
    skip_reasons: skipReasons,
    failed,
    // Only failures are returned in detail — success rows for thousands of
    // variants would make the response enormous.
    results: failures,
    direction: "medusa_to_quickbooks",
  };
}
