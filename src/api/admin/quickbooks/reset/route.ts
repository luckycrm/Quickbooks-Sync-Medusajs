import { 
  AuthenticatedMedusaRequest, 
  MedusaResponse 
} from "@medusajs/framework/http"
import { QUICKBOOKS_MODULE } from "../../../../modules/quickbooks"
import QuickbooksModuleService from "../../../../modules/quickbooks/service"

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const { type } = (req.body as { type?: string }) || {}
  const quickbooksService: QuickbooksModuleService = req.scope.resolve(QUICKBOOKS_MODULE)

  if (type === "orders" || type === "all") {
    await quickbooksService.clearOrderLinks()
  }

  if (type === "customers" || type === "all") {
    await quickbooksService.clearCustomerLinks()
  }

  res.status(200).json({ 
    success: true, 
    message: `Sync history for ${type || "all"} cleared successfully.` 
  })
}
