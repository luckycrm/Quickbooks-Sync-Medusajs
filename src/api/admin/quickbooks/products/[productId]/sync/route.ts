import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"

import { syncMedusaProductToQuickbooks } from "../../../../../../lib/product-sync-service"

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const productId = req.params.productId

  if (!productId) {
    return res.status(400).json({
      message: "productId is required.",
    })
  }

  const result = await syncMedusaProductToQuickbooks(req.scope, productId)

  res.status(200).json(result)
}
