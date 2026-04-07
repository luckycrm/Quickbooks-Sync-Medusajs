import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"

import {
  syncAllMedusaProductsToQuickbooks,
  syncMedusaProductsToQuickbooks,
} from "../../../../../lib/product-sync-service"

const asRecord = (value: unknown) => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }

  return null
}

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const body = asRecord(req.body) || {}
  const syncAll = body.sync_all === true
  const productIds = Array.isArray(body.product_ids)
    ? body.product_ids.filter((value): value is string => typeof value === "string")
    : []

  if (!syncAll && !productIds.length) {
    return res.status(400).json({
      message: "product_ids is required unless sync_all is true.",
    })
  }

  const result = syncAll
    ? await syncAllMedusaProductsToQuickbooks(req.scope)
    : await syncMedusaProductsToQuickbooks(req.scope, productIds)

  res.status(200).json(result)
}
