import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

import {
  deleteQuickbooksCustomerInMedusa,
  syncQuickbooksCustomerToMedusaById,
} from "../../../lib/customer-sync-service"
import { syncQuickbooksItemToMedusaById } from "../../../lib/product-sync-service"
import { verifyQuickbooksWebhookSignature } from "../../../lib/quickbooks"

export const AUTHENTICATE = false

type QuickbooksWebhookEntity = {
  name?: string
  id?: string
  operation?: string
  lastUpdated?: string
}

type QuickbooksWebhookPayload = {
  eventNotifications?: Array<{
    realmId?: string
    dataChangeEvent?: {
      entities?: QuickbooksWebhookEntity[]
    }
  }>
}

const parsePayload = (req: MedusaRequest): QuickbooksWebhookPayload => {
  if (req.body && typeof req.body === "object") {
    return req.body as QuickbooksWebhookPayload
  }

  if (typeof req.rawBody === "string" && req.rawBody.trim()) {
    return JSON.parse(req.rawBody) as QuickbooksWebhookPayload
  }

  if (Buffer.isBuffer(req.rawBody) && req.rawBody.length) {
    return JSON.parse(req.rawBody.toString("utf8")) as QuickbooksWebhookPayload
  }

  return {}
}

const getSignature = (req: MedusaRequest) => {
  const header =
    req.get?.("intuit-signature") ??
    req.get?.("Intuit-Signature") ??
    (typeof req.headers?.["intuit-signature"] === "string"
      ? req.headers["intuit-signature"]
      : Array.isArray(req.headers?.["intuit-signature"])
        ? req.headers["intuit-signature"][0]
        : null)

  return header
}

const processWebhookPayload = async (
  scope: MedusaRequest["scope"],
  payload: QuickbooksWebhookPayload
) => {
  const entities =
    payload.eventNotifications?.flatMap(
      (notification) => notification.dataChangeEvent?.entities || []
    ) || []

  for (const entity of entities) {
    const entityName = entity.name?.toLowerCase()

    if (!entityName || !entity.id) {
      continue
    }

    if (entityName === "item") {
      try {
        const result = await syncQuickbooksItemToMedusaById(scope, entity.id)
        console.log("[quickbooks-webhook] processed item", {
          entity,
          result,
        })
      } catch (error) {
        console.error("[quickbooks-webhook] failed to process item", {
          entity,
          error: error instanceof Error ? error.message : error,
        })
      }

      continue
    }

    if (entityName !== "customer") {
      continue
    }

    if (entity.operation?.toLowerCase() === "delete") {
      try {
        const result = await deleteQuickbooksCustomerInMedusa(scope, entity.id)
        console.log("[quickbooks-webhook] deleted customer", {
          entity,
          result,
        })
      } catch (error) {
        console.error("[quickbooks-webhook] failed to delete customer", {
          entity,
          error: error instanceof Error ? error.message : error,
        })
      }
      continue
    }

    try {
      const result = await syncQuickbooksCustomerToMedusaById(scope, entity.id)
      console.log("[quickbooks-webhook] synced customer", {
        entity,
        result,
      })
    } catch (error) {
      console.error("[quickbooks-webhook] failed to sync customer", {
        entity,
        error: error instanceof Error ? error.message : error,
      })
    }
  }
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const rawBody = req.rawBody || ""
  const signature = getSignature(req)

  try {
    const isValid = verifyQuickbooksWebhookSignature({
      rawBody: Buffer.isBuffer(rawBody) ? rawBody : String(rawBody),
      signature,
    })

    if (!isValid) {
      return res.status(401).json({
        message: "Invalid QuickBooks webhook signature.",
      })
    }
  } catch (error) {
    return res.status(500).json({
      message:
        error instanceof Error
          ? error.message
          : "Unable to validate QuickBooks webhook signature.",
    })
  }

  const payload = parsePayload(req)

  res.status(200).json({
    received: true,
  })

  void processWebhookPayload(req.scope, payload)
}
