import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"

import { QUICKBOOKS_MODULE } from "../../../../../modules/quickbooks"
import type QuickbooksModuleService from "../../../../../modules/quickbooks/service"
import {
  findQuickbooksAttachables,
  findQuickbooksItems,
  getBaseUrl,
  getQuickbooksConfig,
  isConnectionExpired,
  refreshOauthToken,
  toStoredConnection,
} from "../../../../../lib/quickbooks"
import { isQuickbooksImageAttachable } from "../../../../../lib/product-sync"

type ProductModuleService = {
  listAndCountProducts: (
    filters?: Record<string, unknown>,
    config?: Record<string, unknown>
  ) => Promise<[Record<string, unknown>[], number]>
}

type ProductVariantSummary = {
  id: string | null
  title: string | null
  sku: string | null
  manage_inventory: boolean
  quickbooks_item_id: string | null
  quickbooks_active: boolean | null
  quickbooks_type: string | null
  quickbooks_unit_price: number | null
  quickbooks_qty_on_hand: number | null
  quickbooks_image_count: number
  availability: string[]
}

type UnifiedProductRow = {
  id: string
  medusa_product_id: string | null
  quickbooks_item_ids: string[]
  title: string | null
  subtitle: string | null
  handle: string | null
  status: string | null
  thumbnail: string | null
  product_type: string | null
  collection: string | null
  source: "medusa" | "quickbooks"
  availability: string[]
  product_tags: string[]
  sales_channels: string[]
  image_count: number
  quickbooks_image_count: number
  variant_count: number
  matched_variant_count: number
  unmatched_variant_count: number
  variants: ProductVariantSummary[]
  quickbooks_name: string | null
  quickbooks_type: string | null
  quickbooks_active: boolean | null
  quickbooks_updated_at: string | null
}

const DEFAULT_LIMIT = 50

const asRecord = (value: unknown) => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }

  return null
}

const asString = (value: unknown) => (typeof value === "string" ? value : null)

const asBoolean = (value: unknown) =>
  typeof value === "boolean" ? value : null

const asNumber = (value: unknown) =>
  typeof value === "number" ? value : null

const uniqueStrings = (values: Array<string | null | undefined>) =>
  [...new Set(values.filter((value): value is string => !!value))]

const getQueryLimit = (req: AuthenticatedMedusaRequest) => {
  const raw = (req.query as Record<string, unknown> | undefined)?.limit

  if (typeof raw !== "string") {
    return DEFAULT_LIMIT
  }

  const parsed = Number.parseInt(raw, 10)

  if (Number.isNaN(parsed) || parsed <= 0) {
    return DEFAULT_LIMIT
  }

  return Math.min(parsed, 100)
}

const getAttachableEntityIds = (attachable: Record<string, unknown>) => {
  const refs = Array.isArray(attachable.AttachableRef) ? attachable.AttachableRef : []

  return refs
    .map((ref) => {
      const entityRef = asRecord(asRecord(ref)?.EntityRef)

      if (!entityRef || entityRef.Type !== "Item" || typeof entityRef.value !== "string") {
        return null
      }

      return entityRef.value
    })
    .filter((value): value is string => !!value)
}

const buildVariantAvailability = (input: {
  sku: string | null
  manageInventory: boolean
  quickbooksItem: Record<string, unknown> | null
  quickbooksImageCount: number
}) => {
  const tags = ["Medusa Variant"]

  if (input.sku) {
    tags.push("Has SKU")
  } else {
    tags.push("Missing SKU")
  }

  if (input.manageInventory) {
    tags.push("Inventory Tracked")
  }

  if (input.quickbooksItem) {
    tags.push("QuickBooks")

    if (input.quickbooksItem.Active === false) {
      tags.push("QuickBooks Inactive")
    } else {
      tags.push("QuickBooks Active")
    }

    if (input.quickbooksItem.Type === "Inventory") {
      tags.push("QuickBooks Inventory")
    }

    if (input.quickbooksImageCount > 0) {
      tags.push("QuickBooks Image")
    }
  } else {
    tags.push(input.sku ? "Missing in QuickBooks" : "Needs SKU for Sync")
  }

  return tags
}

const buildProductAvailability = (input: {
  status: string | null
  variantCount: number
  matchedVariantCount: number
  medusaImageCount: number
  quickbooksImageCount: number
  salesChannels: string[]
}) => {
  const tags = ["Medusa"]

  if (input.status === "published") {
    tags.push("Published")
  } else if (input.status) {
    tags.push(String(input.status))
  }

  if (input.variantCount === 0) {
    tags.push("No Variants")
  } else if (input.matchedVariantCount === 0) {
    tags.push("Not in QuickBooks")
  } else if (input.matchedVariantCount === input.variantCount) {
    tags.push("Synced to QuickBooks")
  } else {
    tags.push("Partially in QuickBooks")
  }

  if (input.medusaImageCount > 0) {
    tags.push("Has Medusa Images")
  }

  if (input.quickbooksImageCount > 0) {
    tags.push("Has QuickBooks Images")
  }

  if (input.salesChannels.length > 0) {
    tags.push("Has Sales Channels")
  }

  return tags
}

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const limit = getQueryLimit(req)
  const config = getQuickbooksConfig(getBaseUrl(req))
  const quickbooksService: QuickbooksModuleService = req.scope.resolve(
    QUICKBOOKS_MODULE
  )
  const productModuleService = req.scope.resolve("product") as unknown as ProductModuleService

  const [medusaProducts, medusaCount] = await productModuleService.listAndCountProducts(
    {},
    {
      take: limit,
      order: { created_at: "DESC" },
      relations: ["variants", "images", "tags", "type", "collection"],
    }
  )

  const medusaRowsBase = medusaProducts.map((product) => {
    const variants = Array.isArray(product.variants) ? product.variants : []
    const images = Array.isArray(product.images) ? product.images : []
    const tags = Array.isArray(product.tags) ? product.tags : []
    const salesChannels = Array.isArray(product.sales_channels)
      ? product.sales_channels
      : []

    return {
      product,
      variants,
      images,
      medusaImageCount: images.length,
      medusaTags: uniqueStrings(
        tags.map((tag) => asString(asRecord(tag)?.value) || asString(asRecord(tag)?.name))
      ),
      salesChannelNames: uniqueStrings(
        salesChannels.map((channel) => asString(asRecord(channel)?.name))
      ),
    }
  })

  if (!config.configured) {
    const rows: UnifiedProductRow[] = medusaRowsBase.map((entry) => {
      const variants: ProductVariantSummary[] = entry.variants.map((variant) => ({
        id: asString(variant.id),
        title: asString(variant.title),
        sku: asString(variant.sku),
        manage_inventory: Boolean(variant.manage_inventory),
        quickbooks_item_id: null,
        quickbooks_active: null,
        quickbooks_type: null,
        quickbooks_unit_price: null,
        quickbooks_qty_on_hand: null,
        quickbooks_image_count: 0,
        availability: buildVariantAvailability({
          sku: asString(variant.sku),
          manageInventory: Boolean(variant.manage_inventory),
          quickbooksItem: null,
          quickbooksImageCount: 0,
        }),
      }))

      return {
        id: asString(entry.product.id) || crypto.randomUUID(),
        medusa_product_id: asString(entry.product.id),
        quickbooks_item_ids: [],
        title: asString(entry.product.title),
        subtitle: asString(entry.product.subtitle),
        handle: asString(entry.product.handle),
        status: asString(entry.product.status),
        thumbnail:
          asString(entry.product.thumbnail) ||
          asString(asRecord(entry.images[0])?.url),
        product_type: asString(asRecord(entry.product.type)?.value),
        collection: asString(asRecord(entry.product.collection)?.title),
        source: "medusa",
        availability: buildProductAvailability({
          status: asString(entry.product.status),
          variantCount: variants.length,
          matchedVariantCount: 0,
          medusaImageCount: entry.medusaImageCount,
          quickbooksImageCount: 0,
          salesChannels: entry.salesChannelNames,
        }),
        product_tags: entry.medusaTags,
        sales_channels: entry.salesChannelNames,
        image_count: entry.medusaImageCount,
        quickbooks_image_count: 0,
        variant_count: variants.length,
        matched_variant_count: 0,
        unmatched_variant_count: variants.length,
        variants,
        quickbooks_name: null,
        quickbooks_type: null,
        quickbooks_active: null,
        quickbooks_updated_at: null,
      }
    })

    return res.status(200).json({
      configured: false,
      connected: false,
      missingKeys: config.missingKeys,
      environment: config.environment,
      limit,
      summary: {
        medusa_products: medusaCount,
        quickbooks_items: 0,
        matched_variants: 0,
        missing_variants: rows.reduce((sum, row) => sum + row.unmatched_variant_count, 0),
        quickbooks_only_items: 0,
      },
      rows,
    })
  }

  let connection = await quickbooksService.getConnection()

  if (connection && connection.refresh_token && isConnectionExpired(connection)) {
    try {
      const refreshedToken = await refreshOauthToken(connection, config)

      connection = await quickbooksService.upsertConnection(
        toStoredConnection(refreshedToken, req.auth_context?.actor_id)
      )
    } catch (e) {
      return res.status(200).json({
        configured: true,
        connected: false,
        environment: config.environment,
        limit,
        summary: {
          medusa_products: medusaCount,
          quickbooks_items: 0,
          matched_variants: 0,
          missing_variants: medusaRowsBase.reduce(
            (sum, row) => sum + row.variants.length,
            0
          ),
          quickbooks_only_items: 0,
        },
        rows: [],
        quickbooks: {
          error:
            e instanceof Error
              ? e.message
              : "Unable to refresh QuickBooks token for products.",
        },
      })
    }
  }

  if (!connection?.access_token || !connection?.realm_id) {
    return res.status(200).json({
      configured: true,
      connected: false,
      environment: config.environment,
      limit,
      summary: {
        medusa_products: medusaCount,
        quickbooks_items: 0,
        matched_variants: 0,
        missing_variants: medusaRowsBase.reduce(
          (sum, row) => sum + row.variants.length,
          0
        ),
        quickbooks_only_items: 0,
      },
      rows: [],
    })
  }

  try {
    const [quickbooksItems, quickbooksAttachables] = await Promise.all([
      findQuickbooksItems(connection, config),
      findQuickbooksAttachables(connection, config),
    ])

    const quickbooksImageCounts = new Map<string, number>()

    for (const attachable of quickbooksAttachables) {
      if (!isQuickbooksImageAttachable(attachable)) {
        continue
      }

      for (const entityId of getAttachableEntityIds(attachable)) {
        quickbooksImageCounts.set(entityId, (quickbooksImageCounts.get(entityId) || 0) + 1)
      }
    }

    const quickbooksItemsBySku = new Map<string, Record<string, unknown>>()
    const matchedQuickbooksItemIds = new Set<string>()

    for (const item of quickbooksItems) {
      const sku = asString(item.Sku)?.trim()

      if (!sku || quickbooksItemsBySku.has(sku)) {
        continue
      }

      quickbooksItemsBySku.set(sku, item)
    }

    const rows: UnifiedProductRow[] = medusaRowsBase.map((entry) => {
      const variants: ProductVariantSummary[] = entry.variants.map((variant) => {
        const sku = asString(variant.sku)?.trim() || null
        const quickbooksItem = sku ? quickbooksItemsBySku.get(sku) || null : null
        const quickbooksItemId = asString(quickbooksItem?.Id)
        const quickbooksImageCount = quickbooksItemId
          ? quickbooksImageCounts.get(quickbooksItemId) || 0
          : 0

        if (quickbooksItemId) {
          matchedQuickbooksItemIds.add(quickbooksItemId)
        }

        return {
          id: asString(variant.id),
          title: asString(variant.title),
          sku,
          manage_inventory: Boolean(variant.manage_inventory),
          quickbooks_item_id: quickbooksItemId,
          quickbooks_active: asBoolean(quickbooksItem?.Active),
          quickbooks_type: asString(quickbooksItem?.Type),
          quickbooks_unit_price: asNumber(quickbooksItem?.UnitPrice),
          quickbooks_qty_on_hand: asNumber(quickbooksItem?.QtyOnHand),
          quickbooks_image_count: quickbooksImageCount,
          availability: buildVariantAvailability({
            sku,
            manageInventory: Boolean(variant.manage_inventory),
            quickbooksItem,
            quickbooksImageCount,
          }),
        }
      })

      const matchedVariants = variants.filter((variant) => !!variant.quickbooks_item_id)
      const quickbooksItemsForProduct = matchedVariants
        .map((variant) => variant.quickbooks_item_id)
        .filter((id): id is string => !!id)

      const firstQuickbooksItem =
        matchedVariants.length > 0 && matchedVariants[0].quickbooks_item_id
          ? quickbooksItems.find(
              (item) => asString(item.Id) === matchedVariants[0].quickbooks_item_id
            ) || null
          : null

      const quickbooksImageCount = matchedVariants.reduce(
        (sum, variant) => sum + variant.quickbooks_image_count,
        0
      )

      return {
        id: asString(entry.product.id) || crypto.randomUUID(),
        medusa_product_id: asString(entry.product.id),
        quickbooks_item_ids: quickbooksItemsForProduct,
        title: asString(entry.product.title),
        subtitle: asString(entry.product.subtitle),
        handle: asString(entry.product.handle),
        status: asString(entry.product.status),
        thumbnail:
          asString(entry.product.thumbnail) ||
          asString(asRecord(entry.images[0])?.url),
        product_type: asString(asRecord(entry.product.type)?.value),
        collection: asString(asRecord(entry.product.collection)?.title),
        source: "medusa",
        availability: buildProductAvailability({
          status: asString(entry.product.status),
          variantCount: variants.length,
          matchedVariantCount: matchedVariants.length,
          medusaImageCount: entry.medusaImageCount,
          quickbooksImageCount,
          salesChannels: entry.salesChannelNames,
        }),
        product_tags: entry.medusaTags,
        sales_channels: entry.salesChannelNames,
        image_count: entry.medusaImageCount,
        quickbooks_image_count: quickbooksImageCount,
        variant_count: variants.length,
        matched_variant_count: matchedVariants.length,
        unmatched_variant_count: variants.length - matchedVariants.length,
        variants,
        quickbooks_name: asString(firstQuickbooksItem?.Name),
        quickbooks_type: asString(firstQuickbooksItem?.Type),
        quickbooks_active: asBoolean(firstQuickbooksItem?.Active),
        quickbooks_updated_at: asString(asRecord(firstQuickbooksItem?.MetaData)?.LastUpdatedTime),
      }
    })

    const quickbooksOnlyRows: UnifiedProductRow[] = quickbooksItems
      .filter((item) => {
        const id = asString(item.Id)
        return !!id && !matchedQuickbooksItemIds.has(id)
      })
      .map((item) => {
        const quickbooksItemId = asString(item.Id)
        const quickbooksImageCount = quickbooksItemId
          ? quickbooksImageCounts.get(quickbooksItemId) || 0
          : 0

        return {
          id: `quickbooks-only-${quickbooksItemId || crypto.randomUUID()}`,
          medusa_product_id: null,
          quickbooks_item_ids: quickbooksItemId ? [quickbooksItemId] : [],
          title: asString(item.Name),
          subtitle: null,
          handle: null,
          status: null,
          thumbnail: null,
          product_type: null,
          collection: null,
          source: "quickbooks",
          availability: [
            "QuickBooks Only",
            item.Active === false ? "QuickBooks Inactive" : "QuickBooks Active",
            quickbooksImageCount > 0 ? "Has QuickBooks Images" : "No QuickBooks Images",
          ],
          product_tags: [],
          sales_channels: [],
          image_count: 0,
          quickbooks_image_count: quickbooksImageCount,
          variant_count: 1,
          matched_variant_count: 0,
          unmatched_variant_count: 0,
          variants: [
            {
              id: null,
              title: asString(item.Name),
              sku: asString(item.Sku),
              manage_inventory: item.TrackQtyOnHand === true,
              quickbooks_item_id: quickbooksItemId,
              quickbooks_active: asBoolean(item.Active),
              quickbooks_type: asString(item.Type),
              quickbooks_unit_price: asNumber(item.UnitPrice),
              quickbooks_qty_on_hand: asNumber(item.QtyOnHand),
              quickbooks_image_count: quickbooksImageCount,
              availability: [
                "QuickBooks",
                asString(item.Sku) ? "Has SKU" : "Missing SKU",
                item.Type === "Inventory" ? "QuickBooks Inventory" : "QuickBooks Item",
              ],
            },
          ],
          quickbooks_name: asString(item.Name),
          quickbooks_type: asString(item.Type),
          quickbooks_active: asBoolean(item.Active),
          quickbooks_updated_at: asString(asRecord(item.MetaData)?.LastUpdatedTime),
        }
      })

    const combinedRows = [...rows, ...quickbooksOnlyRows]
    const matchedVariants = rows.reduce((sum, row) => sum + row.matched_variant_count, 0)
    const missingVariants = rows.reduce((sum, row) => sum + row.unmatched_variant_count, 0)

    return res.status(200).json({
      configured: true,
      connected: true,
      environment: connection.environment,
      realmId: connection.realm_id,
      limit,
      summary: {
        medusa_products: medusaCount,
        quickbooks_items: quickbooksItems.length,
        matched_variants: matchedVariants,
        missing_variants: missingVariants,
        quickbooks_only_items: quickbooksOnlyRows.length,
      },
      rows: combinedRows,
    })
  } catch (e) {
    return res.status(200).json({
      configured: true,
      connected: true,
      environment: connection.environment,
      realmId: connection.realm_id,
      limit,
      summary: {
        medusa_products: medusaCount,
        quickbooks_items: 0,
        matched_variants: 0,
        missing_variants: medusaRowsBase.reduce((sum, row) => sum + row.variants.length, 0),
        quickbooks_only_items: 0,
      },
      rows: [],
      quickbooks: {
        error:
          e instanceof Error ? e.message : "Unable to load QuickBooks products.",
      },
    })
  }
}
