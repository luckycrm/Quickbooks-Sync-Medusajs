import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

import { QUICKBOOKS_MODULE } from "../../../../modules/quickbooks"
import type QuickbooksModuleService from "../../../../modules/quickbooks/service"
import {
  createOauthClient,
  getBaseUrl,
  getQuickbooksConfig,
  toStoredConnection,
  verifyState,
} from "../../../../lib/quickbooks"

export const AUTHENTICATE = false

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const config = getQuickbooksConfig(getBaseUrl(req))
  const redirectTarget = "/app/settings/quickbooks"

  if (!config.configured) {
    return res.redirect(
      `${redirectTarget}?quickbooks=error&message=${encodeURIComponent(
        "QuickBooks is not configured on the backend."
      )}`
    )
  }

  const error = typeof req.query.error === "string" ? req.query.error : null
  const errorDescription =
    typeof req.query.error_description === "string"
      ? req.query.error_description
      : null

  if (error) {
    return res.redirect(
      `${redirectTarget}?quickbooks=error&message=${encodeURIComponent(
        errorDescription || error
      )}`
    )
  }

  try {
    const state = typeof req.query.state === "string" ? req.query.state : ""
    const payload = verifyState(state)
    const oauthClient = createOauthClient(config)
    const callbackUrl = `${getBaseUrl(req)}${req.originalUrl || req.url}`
    const authResponse = await oauthClient.createToken(callbackUrl)
    const token = authResponse.getToken()
    const quickbooksService: QuickbooksModuleService = req.scope.resolve(
      QUICKBOOKS_MODULE
    )

    await quickbooksService.upsertConnection(
      toStoredConnection(token, payload.actorId)
    )

    return res.redirect(`${payload.returnTo}?quickbooks=connected`)
  } catch (e) {
    const message = e instanceof Error ? e.message : "QuickBooks connection failed."

    return res.redirect(
      `${redirectTarget}?quickbooks=error&message=${encodeURIComponent(message)}`
    )
  }
}
