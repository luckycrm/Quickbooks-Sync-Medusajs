import {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { QUICKBOOKS_MODULE } from "../../../../modules/quickbooks";
import QuickbooksModuleService from "../../../../modules/quickbooks/service";

const VALID_TYPES = ["orders", "customers", "all"];

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
) {
  const { type } = (req.body as { type?: string }) || {};

  if (!type || !VALID_TYPES.includes(type)) {
    return res.status(400).json({
      success: false,
      message: `Invalid reset type. Use one of: ${VALID_TYPES.join(", ")}.`,
    });
  }

  const quickbooksService: QuickbooksModuleService =
    req.scope.resolve(QUICKBOOKS_MODULE);

  const cleared: string[] = [];

  if (type === "orders" || type === "all") {
    await quickbooksService.clearOrderLinks();
    cleared.push("order links");
  }

  if (type === "customers" || type === "all") {
    await quickbooksService.clearCustomerLinks();
    cleared.push("customer links");
  }

  if (type === "all") {
    await quickbooksService.clearConnection(req.auth_context?.actor_id || null);
    cleared.push("connection");
  }

  res.status(200).json({
    success: true,
    message: `Cleared ${cleared.join(", ")}.`,
  });
}
