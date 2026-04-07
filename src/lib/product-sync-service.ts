import { QUICKBOOKS_MODULE } from "../modules/quickbooks"
import type QuickbooksModuleService from "../modules/quickbooks/service"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import {
  createQuickbooksItem,
  deleteQuickbooksAttachable,
  findQuickbooksAccounts,
  findQuickbooksAttachables,
  findQuickbooksItems,
  getQuickbooksAccount,
  getQuickbooksAttachable,
  getQuickbooksConfig,
  getQuickbooksItem,
  isConnectionExpired,
  refreshOauthToken,
  safeUpdateQuickbooksItem,
  toStoredConnection,
  updateQuickbooksAttachable,
  uploadQuickbooksFile,
} from "./quickbooks"
import {
  buildMedusaImageAttachableNote,
  isPluginManagedQuickbooksImageAttachable,
  isQuickbooksImageAttachable,
  shouldSkipQuickbooksItemWebhook,
} from "./product-sync"
import { Readable } from "stream"
import sharp from "sharp"

type ScopeLike = {
  resolve: (name: string) => any
}

type ProductModuleService = {
  listAndCountProducts: (
    filters?: Record<string, unknown>,
    config?: Record<string, unknown>
  ) => Promise<[Record<string, unknown>[], number]>
}

const PRODUCT_SYNC_BATCH_SIZE = 100

const asRecord = (value: unknown) => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }

  return null
}

const asString = (value: unknown) => (typeof value === "string" ? value : null)

const asNumber = (value: unknown) =>
  typeof value === "number" ? value : null

const isPublishedProduct = (product: Record<string, unknown>) =>
  asString(product.status) === "published"

const formatQuickbooksDate = (value: Date) => value.toISOString().slice(0, 10)

const buildQuickbooksItemName = (input: {
  product: Record<string, unknown>
  variant: Record<string, unknown>
  variantCount: number
}) => {
  const productTitle = asString(input.product.title) || "Untitled Product"
  const variantTitle = asString(input.variant.title)

  if (input.variantCount <= 1 || !variantTitle || variantTitle === "Default Variant") {
    return productTitle
  }

  return `${productTitle} - ${variantTitle}`
}

type QuickbooksProductSyncConfig = {
  incomeAccountId: string | null
  incomeAccountName: string | null
  expenseAccountId: string | null
  expenseAccountName: string | null
  assetAccountId: string | null
  assetAccountName: string | null
}

const getQuickbooksProductSyncConfig = (): QuickbooksProductSyncConfig => {
  const expenseAccountId = process.env.QUICKBOOKS_PRODUCT_EXPENSE_ACCOUNT_ID?.trim() || null
  const expenseAccountName =
    process.env.QUICKBOOKS_PRODUCT_EXPENSE_ACCOUNT_NAME?.trim() || null
  const assetAccountId = process.env.QUICKBOOKS_PRODUCT_ASSET_ACCOUNT_ID?.trim() || null
  const assetAccountName =
    process.env.QUICKBOOKS_PRODUCT_ASSET_ACCOUNT_NAME?.trim() || null

  return {
    incomeAccountId: null,
    incomeAccountName: null,
    expenseAccountId,
    expenseAccountName,
    assetAccountId,
    assetAccountName,
  }
}

async function resolveQuickbooksProductSyncConfig(input: {
  connection: {
    realm_id?: string | null
    access_token?: string | null
    refresh_token?: string | null
    quickbooks_product_income_account_id?: string | null
    quickbooks_product_income_account_name?: string | null
  }
  config: ReturnType<typeof getQuickbooksConfig>
}) {
  const syncConfig = getQuickbooksProductSyncConfig()

  if (input.connection.quickbooks_product_income_account_id) {
    syncConfig.incomeAccountId = input.connection.quickbooks_product_income_account_id
  }

  if (input.connection.quickbooks_product_income_account_name) {
    syncConfig.incomeAccountName = input.connection.quickbooks_product_income_account_name
  }

  if (syncConfig.incomeAccountId) {
    const account = await getQuickbooksAccount(
      input.connection,
      input.config,
      syncConfig.incomeAccountId
    )

    if (!account?.Id) {
      throw new Error(
        `QuickBooks income account ${syncConfig.incomeAccountId} was not found.`
      )
    }

    syncConfig.incomeAccountName =
      asString(account.Name) || syncConfig.incomeAccountName

    return syncConfig
  }

  if (syncConfig.incomeAccountName) {
    const accounts = await findQuickbooksAccounts(input.connection, input.config, {
      Name: syncConfig.incomeAccountName,
    })
    const account = accounts[0] || null

    if (!account?.Id) {
      throw new Error(
        `QuickBooks income account named "${syncConfig.incomeAccountName}" was not found.`
      )
    }

    syncConfig.incomeAccountId = asString(account.Id)
    syncConfig.incomeAccountName = asString(account.Name) || syncConfig.incomeAccountName

    return syncConfig
  }

  const incomeAccounts = await findQuickbooksAccounts(input.connection, input.config, {
    AccountType: "Income",
    Active: true,
  })

  if (incomeAccounts.length === 1) {
    syncConfig.incomeAccountId = asString(incomeAccounts[0]?.Id)
    syncConfig.incomeAccountName = asString(incomeAccounts[0]?.Name)

    console.log("[quickbooks-sync] auto-selected income account", {
      quickbooks_account_id: syncConfig.incomeAccountId,
      quickbooks_account_name: syncConfig.incomeAccountName,
      direction: "medusa_to_quickbooks",
    })

    return syncConfig
  }

  return syncConfig
}

async function getMedusaProductById(scope: ScopeLike, productId: string) {
  const productModuleService = scope.resolve("product") as ProductModuleService
  const [products] = await productModuleService.listAndCountProducts(
    { id: [productId] },
    {
      take: 1,
      relations: [
        "variants",
        "variants.images",
        "images",
        "tags",
        "type",
        "collection",
      ],
    }
  )

  return products[0] ?? null
}

const uniqueImageUrls = (values: Array<string | null | undefined>) => {
  const seen = new Set<string>()
  const urls: string[] = []

  for (const value of values) {
    const normalized = typeof value === "string" ? value.trim() : ""

    if (!normalized || seen.has(normalized)) {
      continue
    }

    seen.add(normalized)
    urls.push(normalized)
  }

  return urls
}

const getImageUrlsFromCollection = (images: unknown) =>
  Array.isArray(images)
    ? images
        .map((image) => asString(asRecord(image)?.url))
        .filter((value): value is string => !!value)
    : []

function resolveVariantImageUrls(input: {
  product: Record<string, unknown>
  variant: Record<string, unknown>
}) {
  const variantImageUrls = getImageUrlsFromCollection(input.variant.images)
  const productImageUrls = getImageUrlsFromCollection(input.product.images)
  const variantThumbnail = asString(input.variant.thumbnail)
  const productThumbnail = asString(input.product.thumbnail)

  if (variantImageUrls.length) {
    return uniqueImageUrls([...variantImageUrls, variantThumbnail])
  }

  if (variantThumbnail) {
    return uniqueImageUrls([variantThumbnail, ...productImageUrls, productThumbnail])
  }

  if (productImageUrls.length) {
    return uniqueImageUrls([...productImageUrls, productThumbnail])
  }

  return uniqueImageUrls([productThumbnail])
}

async function listAllMedusaProductIds(scope: ScopeLike) {
  const productModuleService = scope.resolve("product") as ProductModuleService
  const productIds: string[] = []
  let skip = 0
  let total = 0

  do {
    const [products, count] = await productModuleService.listAndCountProducts(
      {},
      {
        take: PRODUCT_SYNC_BATCH_SIZE,
        skip,
        order: { created_at: "DESC" },
      }
    )

    total = count

    for (const product of products) {
      const productId = asString(product.id)

      if (productId) {
        productIds.push(productId)
      }
    }

    skip += products.length

    if (!products.length) {
      break
    }
  } while (skip < total)

  return productIds
}

async function getMedusaInventoryQuantityBySku(scope: ScopeLike, sku: string) {
  const query = scope.resolve(ContainerRegistrationKeys.QUERY) as {
    graph: (input: {
      entity: string
      fields: string[]
      filters?: Record<string, unknown>
    }) => Promise<{ data?: Record<string, unknown>[] }>
  }

  try {
    const response = await query.graph({
      entity: "inventory_item",
      fields: ["id", "sku"],
      filters: {
        sku,
      },
    })

    if (!response.data?.length) {
      return null
    }
  } catch {
    return null
  }

  return null
}

function buildQuickbooksItemPayload(input: {
  product: Record<string, unknown>
  variant: Record<string, unknown>
  variantCount: number
  existingItem: Record<string, unknown> | null
  inventoryQuantity: number | null
  syncConfig: QuickbooksProductSyncConfig
}) {
  const sku = asString(input.variant.sku)

  if (!sku) {
    return {
      skipped: true,
      reason: "Variant SKU is required for QuickBooks item sync.",
    }
  }

  const trackInventory = Boolean(input.variant.manage_inventory)
  const canCreateInventoryItem =
    !!input.syncConfig.incomeAccountId &&
    !!input.syncConfig.expenseAccountId &&
    !!input.syncConfig.assetAccountId
  const existingType = asString(input.existingItem?.Type)
  const shouldUseInventoryType =
    trackInventory && (canCreateInventoryItem || existingType === "Inventory")

  if (!input.existingItem && !input.syncConfig.incomeAccountId) {
    return {
      skipped: true,
      reason:
        "A QuickBooks income account is required to create new QuickBooks items. Select one in QuickBooks Settings or keep exactly one active Income account in QuickBooks.",
    }
  }

  const payload: Record<string, unknown> = {
    Name: buildQuickbooksItemName(input),
    Sku: sku,
    Active: isPublishedProduct(input.product),
    Type: shouldUseInventoryType ? "Inventory" : "NonInventory",
    Description: JSON.stringify({
      medusa_product_id: input.product.id || null,
      medusa_variant_id: input.variant.id || null,
      medusa_handle: input.product.handle || null,
    }),
  }

  const incomeAccountId =
    asString(asRecord(input.existingItem?.IncomeAccountRef)?.value) ||
    input.syncConfig.incomeAccountId
  const incomeAccountName =
    asString(asRecord(input.existingItem?.IncomeAccountRef)?.name) ||
    input.syncConfig.incomeAccountName

  if (incomeAccountId) {
    payload.IncomeAccountRef = {
      value: incomeAccountId,
      ...(incomeAccountName ? { name: incomeAccountName } : {}),
    }
  }

  if (shouldUseInventoryType) {
    const expenseAccountId =
      asString(asRecord(input.existingItem?.ExpenseAccountRef)?.value) ||
      input.syncConfig.expenseAccountId
    const expenseAccountName =
      asString(asRecord(input.existingItem?.ExpenseAccountRef)?.name) ||
      input.syncConfig.expenseAccountName
    const assetAccountId =
      asString(asRecord(input.existingItem?.AssetAccountRef)?.value) ||
      input.syncConfig.assetAccountId
    const assetAccountName =
      asString(asRecord(input.existingItem?.AssetAccountRef)?.name) ||
      input.syncConfig.assetAccountName

    payload.TrackQtyOnHand = true
    payload.QtyOnHand =
      input.inventoryQuantity ??
      asNumber(input.existingItem?.QtyOnHand) ??
      0
    payload.InvStartDate =
      asString(input.existingItem?.InvStartDate) || formatQuickbooksDate(new Date())

    if (expenseAccountId) {
      payload.ExpenseAccountRef = {
        value: expenseAccountId,
        ...(expenseAccountName ? { name: expenseAccountName } : {}),
      }
    }

    if (assetAccountId) {
      payload.AssetAccountRef = {
        value: assetAccountId,
        ...(assetAccountName ? { name: assetAccountName } : {}),
      }
    }
  }

  if (input.existingItem?.Id && input.existingItem?.SyncToken) {
    payload.Id = input.existingItem.Id
    payload.SyncToken = input.existingItem.SyncToken
    payload.sparse = true
  }

  return {
    skipped: false,
    payload,
  }
}

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

export async function syncQuickbooksItemToMedusaById(
  scope: ScopeLike,
  quickbooksItemId: string
) {
  const { config, connection } = await getReadyQuickbooksConnection(scope)

  if (!connection) {
    return { skipped: true, reason: "QuickBooks is not connected." }
  }

  const syncConfig = await resolveQuickbooksProductSyncConfig({
    connection,
    config,
  })

  const quickbooksItem = await getQuickbooksItem(connection, config, quickbooksItemId)

  if (!quickbooksItem) {
    return { skipped: true, reason: "QuickBooks item not found." }
  }

  const inventoryDecision = shouldSkipQuickbooksItemWebhook(quickbooksItem)

  if (inventoryDecision.skipped) {
    return {
      ...inventoryDecision,
      quickbooks_item_id: quickbooksItemId,
    }
  }

  return {
    skipped: true,
    quickbooks_item_id: quickbooksItemId,
    reason:
      "QuickBooks item webhook received, but inbound product field syncing is not implemented yet.",
    source_of_truth: "medusa",
  }
}

const inferImageContentType = (url: string, responseContentType?: string | null) => {
  const normalized = responseContentType?.split(";")[0]?.trim().toLowerCase()

  if (normalized?.startsWith("image/")) {
    return normalized
  }

  if (url.match(/\.png(\?|$)/i)) {
    return "image/png"
  }

  if (url.match(/\.svg(\?|$)/i)) {
    return "image/svg+xml"
  }

  if (url.match(/\.webp(\?|$)/i)) {
    return "image/webp"
  }

  if (url.match(/\.avif(\?|$)/i)) {
    return "image/avif"
  }

  if (url.match(/\.gif(\?|$)/i)) {
    return "image/gif"
  }

  if (url.match(/\.tif(f)?(\?|$)/i)) {
    return "image/tiff"
  }

  return "image/jpeg"
}

const inferImageExtension = (contentType: string) => {
  switch (contentType) {
    case "image/png":
      return "png"
    case "image/gif":
      return "gif"
    case "image/svg+xml":
      return "svg"
    case "image/webp":
      return "webp"
    case "image/avif":
      return "avif"
    case "image/tiff":
      return "tiff"
    case "image/jpg":
      return "jpg"
    default:
      return "jpg"
  }
}

const toQuickbooksSafeImageName = (baseName: string, extension: string) =>
  `${baseName}.${extension}`

async function normalizeImageForQuickbooks(input: {
  bytes: Buffer
  contentType: string
  filenameBase: string
}) {
  const normalizedContentType = input.contentType.toLowerCase()

  const convertedBytes = await sharp(input.bytes, {
    density: normalizedContentType === "image/svg+xml" ? 300 : undefined,
    pages: 1,
  })
    .rotate()
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer()

  return {
    bytes: convertedBytes,
    contentType: "image/jpeg",
    filename: toQuickbooksSafeImageName(input.filenameBase, "jpg"),
    converted: normalizedContentType !== "image/jpeg" && normalizedContentType !== "image/jpg",
    original_content_type: normalizedContentType,
  }
}

function debugQuickbooksAttachableSnapshot(attachable: Record<string, unknown>) {
  return {
    id: typeof attachable.Id === "string" ? attachable.Id : null,
    sync_token:
      typeof attachable.SyncToken === "string" ? attachable.SyncToken : null,
    file_name:
      typeof attachable.FileName === "string" ? attachable.FileName : null,
    content_type:
      typeof attachable.ContentType === "string" ? attachable.ContentType : null,
    note: typeof attachable.Note === "string" ? attachable.Note : null,
    size: typeof attachable.Size === "number" ? attachable.Size : null,
    temp_download_uri:
      typeof attachable.TempDownloadUri === "string"
        ? attachable.TempDownloadUri
        : null,
    thumbnail_file_access_uri:
      typeof attachable.ThumbnailFileAccessUri === "string"
        ? attachable.ThumbnailFileAccessUri
        : null,
    file_access_uri:
      typeof attachable.FileAccessUri === "string"
        ? attachable.FileAccessUri
        : null,
    attachable_ref: Array.isArray(attachable.AttachableRef)
      ? attachable.AttachableRef
      : [],
  }
}

async function logQuickbooksSkuDebugSnapshot(input: {
  scope: ScopeLike
  sku: string
  quickbooksItemId: string
}) {
  if (input.sku !== "SHORTS-L") {
    return
  }

  const { config, connection } = await getReadyQuickbooksConnection(input.scope)

  if (!connection) {
    return
  }

  const quickbooksItem = await getQuickbooksItem(
    connection,
    config,
    input.quickbooksItemId
  )
  const attachables = await listQuickbooksItemAttachablesByItemId(
    input.scope,
    input.quickbooksItemId
  )

  console.log("[quickbooks-debug] sku snapshot", {
    sku: input.sku,
    quickbooks_item_id: input.quickbooksItemId,
    item: quickbooksItem
      ? {
          id: typeof quickbooksItem.Id === "string" ? quickbooksItem.Id : null,
          name:
            typeof quickbooksItem.Name === "string" ? quickbooksItem.Name : null,
          sku: typeof quickbooksItem.Sku === "string" ? quickbooksItem.Sku : null,
          type:
            typeof quickbooksItem.Type === "string" ? quickbooksItem.Type : null,
          active:
            typeof quickbooksItem.Active === "boolean"
              ? quickbooksItem.Active
              : null,
          fully_qualified_name:
            typeof quickbooksItem.FullyQualifiedName === "string"
              ? quickbooksItem.FullyQualifiedName
              : null,
          image: quickbooksItem.Image ?? null,
        }
      : null,
    attachable_count: attachables.length,
    attachables: attachables.map(debugQuickbooksAttachableSnapshot),
  })
}

export async function listQuickbooksItemAttachablesByItemId(
  scope: ScopeLike,
  quickbooksItemId: string
) {
  const { config, connection } = await getReadyQuickbooksConnection(scope)

  if (!connection) {
    return []
  }

  return await findQuickbooksAttachables(connection, config, [
    { field: "AttachableRef.EntityRef.Type", value: "Item", operator: "=" },
    { field: "AttachableRef.EntityRef.value", value: quickbooksItemId, operator: "=" },
  ])
}

export async function syncMedusaImagesToQuickbooksItem(input: {
  scope: ScopeLike
  quickbooksItemId: string
  medusaProductId: string
  imageUrls: string[]
}) {
  const { config, connection } = await getReadyQuickbooksConnection(input.scope)

  if (!connection) {
    return { skipped: true, reason: "QuickBooks is not connected." }
  }

  const existingAttachables = await listQuickbooksItemAttachablesByItemId(
    input.scope,
    input.quickbooksItemId
  )

  const pluginManagedImages = existingAttachables.filter(
    (attachable) =>
      isQuickbooksImageAttachable(attachable) &&
      isPluginManagedQuickbooksImageAttachable(attachable, input.medusaProductId)
  )

  for (const attachable of pluginManagedImages) {
    if (typeof attachable.Id === "string") {
      await deleteQuickbooksAttachable(connection, config, attachable.Id)
    }
  }

  const uploaded: Record<string, unknown>[] = []

  for (const [index, imageUrl] of input.imageUrls.entries()) {
    const response = await fetch(imageUrl)

    if (!response.ok) {
      throw new Error(`Unable to download Medusa image: ${imageUrl}`)
    }

    const bytes = Buffer.from(await response.arrayBuffer())
    const sourceContentType = inferImageContentType(
      imageUrl,
      response.headers.get("content-type")
    )
    const normalizedAsset = await normalizeImageForQuickbooks({
      bytes,
      contentType: sourceContentType,
      filenameBase: `medusa-product-${input.medusaProductId}-${index + 1}`,
    })

    const uploadedAttachable = await uploadQuickbooksFile(connection, config, {
      filename: normalizedAsset.filename,
      contentType: normalizedAsset.contentType,
      stream: Readable.from(normalizedAsset.bytes),
      entityType: "Item",
      entityId: input.quickbooksItemId,
    })

    const attachableId =
      uploadedAttachable && typeof uploadedAttachable.Id === "string"
        ? uploadedAttachable.Id
        : null

    if (!attachableId) {
      continue
    }

    const persistentAttachable = await getQuickbooksAttachable(
      connection,
      config,
      attachableId
    )

    if (!persistentAttachable?.Id || !persistentAttachable.SyncToken) {
      if (uploadedAttachable) {
        uploaded.push(uploadedAttachable)
      }
      continue
    }

    const updatedAttachable = await updateQuickbooksAttachable(connection, config, {
      ...persistentAttachable,
      Id: persistentAttachable.Id,
      SyncToken: persistentAttachable.SyncToken,
      Note: buildMedusaImageAttachableNote({
        medusa_product_id: input.medusaProductId,
        medusa_image_url: imageUrl,
      }),
    })

    const finalAttachable = updatedAttachable || uploadedAttachable

    if (finalAttachable) {
      uploaded.push(finalAttachable)
    }
  }

  return {
    skipped: false,
    quickbooks_item_id: input.quickbooksItemId,
    medusa_product_id: input.medusaProductId,
    deleted: pluginManagedImages.length,
    uploaded: uploaded.length,
    source_of_truth: "medusa",
  }
}

export async function syncMedusaProductToQuickbooks(
  scope: ScopeLike,
  medusaProductId: string
) {
  const product = await getMedusaProductById(scope, medusaProductId)

  if (!product) {
    return { skipped: true, reason: "Product not found in Medusa." }
  }

  const variants = Array.isArray(product.variants) ? product.variants : []

  if (!variants.length) {
    return { skipped: true, reason: "Product has no variants to sync." }
  }

  const { config, connection } = await getReadyQuickbooksConnection(scope)

  if (!connection) {
    return { skipped: true, reason: "QuickBooks is not connected." }
  }

  const syncConfig = await resolveQuickbooksProductSyncConfig({
    connection,
    config,
  })

  const results: Array<Record<string, unknown>> = []
  let created = 0
  let updated = 0
  let skipped = 0

  for (const variant of variants) {
    const sku = asString(variant.sku)?.trim() || null

    if (!sku) {
      skipped += 1
      console.log("[quickbooks-sync] variant skipped", {
        medusa_product_id: medusaProductId,
        variant_id: variant.id || null,
        sku: null,
        reason: "Variant SKU is required for QuickBooks item sync.",
        direction: "medusa_to_quickbooks",
      })
      results.push({
        variant_id: variant.id || null,
        sku: null,
        skipped: true,
        reason: "Variant SKU is required for QuickBooks item sync.",
      })
      continue
    }

    const existingItem =
      (await findQuickbooksItems(connection, config, {
        Sku: sku,
      }))[0] || null

    const inventoryQuantity = await getMedusaInventoryQuantityBySku(scope, sku)
    const payloadDecision = buildQuickbooksItemPayload({
      product,
      variant,
      variantCount: variants.length,
      existingItem,
      inventoryQuantity,
      syncConfig,
    })

    if (payloadDecision.skipped) {
      skipped += 1
      console.log("[quickbooks-sync] variant skipped", {
        medusa_product_id: medusaProductId,
        variant_id: variant.id || null,
        sku,
        reason: payloadDecision.reason,
        direction: "medusa_to_quickbooks",
      })
      results.push({
        variant_id: variant.id || null,
        sku,
        skipped: true,
        reason: payloadDecision.reason,
      })
      continue
    }

    const quickbooksPayload = payloadDecision.payload as Record<string, unknown>
    const imageUrls = resolveVariantImageUrls({ product, variant })

    const syncedItem = existingItem
      ? await safeUpdateQuickbooksItem(
          connection,
          config,
          existingItem,
          quickbooksPayload
        )
      : await createQuickbooksItem(connection, config, quickbooksPayload)

    if (!syncedItem?.Id) {
      skipped += 1
      console.log("[quickbooks-sync] variant skipped", {
        medusa_product_id: medusaProductId,
        variant_id: variant.id || null,
        sku,
        reason: "QuickBooks did not return a persisted item.",
        direction: "medusa_to_quickbooks",
      })
      results.push({
        variant_id: variant.id || null,
        sku,
        skipped: true,
        reason: "QuickBooks did not return a persisted item.",
      })
      continue
    }

    if (imageUrls.length) {
      await syncMedusaImagesToQuickbooksItem({
        scope,
        quickbooksItemId: String(syncedItem.Id),
        medusaProductId,
        imageUrls,
      })
    }

    await logQuickbooksSkuDebugSnapshot({
      scope,
      sku,
      quickbooksItemId: String(syncedItem.Id),
    })

    if (existingItem) {
      updated += 1
    } else {
      created += 1
    }

    console.log("[quickbooks-sync] variant synced", {
      medusa_product_id: medusaProductId,
      variant_id: variant.id || null,
      sku,
      action: existingItem ? "updated" : "created",
      quickbooks_item_id: String(syncedItem.Id),
      direction: "medusa_to_quickbooks",
    })

    results.push({
      variant_id: variant.id || null,
      sku,
      skipped: false,
      action: existingItem ? "updated" : "created",
      quickbooks_item_id: String(syncedItem.Id),
    })
  }

  return {
    skipped: false,
    medusa_product_id: medusaProductId,
    created,
    updated,
    skipped_variants: skipped,
    results,
    direction: "medusa_to_quickbooks",
  }
}

export async function syncMedusaProductsToQuickbooks(
  scope: ScopeLike,
  medusaProductIds: string[]
) {
  const uniqueIds = [...new Set(medusaProductIds.filter(Boolean))]
  const results: Record<string, unknown>[] = []
  let created = 0
  let updated = 0
  let skipped = 0

  for (const productId of uniqueIds) {
    const result = await syncMedusaProductToQuickbooks(scope, productId)
    results.push(result)
    created += Number(result.created || 0)
    updated += Number(result.updated || 0)
    skipped += Number(result.skipped_variants || (result.skipped ? 1 : 0))

    console.log("[quickbooks-sync] product sync result", {
      medusa_product_id: productId,
      created: Number(result.created || 0),
      updated: Number(result.updated || 0),
      skipped_variants: Number(result.skipped_variants || (result.skipped ? 1 : 0)),
      reason: result.reason || null,
      direction: "medusa_to_quickbooks",
    })
  }

  console.log("[quickbooks-sync] bulk sync summary", {
    count: uniqueIds.length,
    created,
    updated,
    skipped,
    direction: "medusa_to_quickbooks",
  })

  return {
    count: uniqueIds.length,
    created,
    updated,
    skipped,
    results,
    direction: "medusa_to_quickbooks",
  }
}

export async function syncAllMedusaProductsToQuickbooks(scope: ScopeLike) {
  const medusaProductIds = await listAllMedusaProductIds(scope)

  return await syncMedusaProductsToQuickbooks(scope, medusaProductIds)
}
