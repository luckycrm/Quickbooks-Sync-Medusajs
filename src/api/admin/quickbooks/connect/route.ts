import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"

import {
  createAuthorizationUrl,
  createOauthClient,
  getBaseUrl,
  getQuickbooksConfig,
  signState,
} from "../../../../lib/quickbooks"

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const config = getQuickbooksConfig(getBaseUrl(req))

  if (!config.configured) {
    return res.status(400).json({
      configured: false,
      missingKeys: config.missingKeys,
    })
  }

  const oauthClient = createOauthClient(config)
  const state = signState({
    actorId: req.auth_context?.actor_id || null,
    returnTo: "/app/settings/quickbooks",
    ts: Date.now(),
  })

  const url = createAuthorizationUrl(oauthClient, state)

  return res.status(200).json({
    configured: true,
    url,
  })
}
