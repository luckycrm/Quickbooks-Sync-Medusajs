import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"

import {
  syncAllMedusaOrdersToQuickbooks,
  syncMedusaOrdersToQuickbooks,
  syncMedusaOrderToQuickbooks,
} from "../../../../../lib/order-sync-service"

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
  res.status(200).json({
    message: "QuickBooks Order Sync API",
    endpoints: {
      GET: "Get order sync status and info",
      POST: "Sync orders to QuickBooks",
      body: {
        order_ids: "Array of Medusa order IDs to sync",
        sync_all: "Boolean to sync all completed orders",
      },
    },
  })
}

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const body = asRecord(req.body) || {}
  const syncAll = body.sync_all === true
  const orderIds = Array.isArray(body.order_ids)
    ? body.order_ids.filter((value): value is string => typeof value === "string")
    : []

  if (!syncAll && !orderIds.length) {
    return res.status(400).json({
      message: "order_ids is required unless sync_all is true.",
    })
  }

  let result

  if (syncAll) {
    result = await syncAllMedusaOrdersToQuickbooks(req.scope)
  } else if (orderIds.length === 1) {
    result = await syncMedusaOrderToQuickbooks(req.scope, orderIds[0])
  } else {
    result = await syncMedusaOrdersToQuickbooks(req.scope, orderIds)
  }

  res.status(200).json(result)
}