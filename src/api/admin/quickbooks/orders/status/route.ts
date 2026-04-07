import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"

import { QUICKBOOKS_MODULE } from "../../../../../modules/quickbooks"
import type QuickbooksModuleService from "../../../../../modules/quickbooks/service"

const asRecord = (value: unknown) => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return null
}

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const quickbooksService: QuickbooksModuleService =
    req.scope.resolve(QUICKBOOKS_MODULE)

  const page = asRecord(req.query?.page) || {}
  const limit = Number(page?.limit) || 20
  const offset = Number(page?.offset) || 0

  const filters: Record<string, unknown> = {}
  const medusaOrderId = asRecord(req.query)?.medusa_order_id
  if (medusaOrderId) {
    filters.medusa_order_id = String(medusaOrderId)
  }

  try {
    const [links, count] = await quickbooksService.listAndCountQuickbooksOrderLinks(
      filters,
      {
        take: limit,
        skip: offset,
        order: { last_synced_at: "DESC" },
      }
    )

    return res.status(200).json({
      order_links: links,
      count,
      limit,
      offset,
      has_more: offset + links.length < count,
    })
  } catch (error) {
    console.error("[quickbooks-orders-status] failed to fetch", { error })
    return res.status(500).json({
      message: "Failed to fetch order sync status.",
    })
  }
}