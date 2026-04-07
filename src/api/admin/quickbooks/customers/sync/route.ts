import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"

import { 
  syncQuickbooksCustomersToMedusa,
  syncMedusaCustomersToQuickbooks
} from "../../../../../lib/customer-sync-service"

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const { direction } = (req.body as { direction?: string }) || {}
  
  if (direction === "medusa_to_quickbooks") {
    const result = await syncMedusaCustomersToQuickbooks(req.scope)
    return res.status(200).json(result)
  }

  const result = await syncQuickbooksCustomersToMedusa(req.scope)

  res.status(200).json(result)
}
