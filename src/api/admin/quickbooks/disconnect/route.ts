import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"

import { QUICKBOOKS_MODULE } from "../../../../modules/quickbooks"
import type QuickbooksModuleService from "../../../../modules/quickbooks/service"
import {
  createOauthClient,
  getBaseUrl,
  getQuickbooksConfig,
} from "../../../../lib/quickbooks"

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const config = getQuickbooksConfig(getBaseUrl(req))
  const quickbooksService: QuickbooksModuleService = req.scope.resolve(
    QUICKBOOKS_MODULE
  )
  const connection = await quickbooksService.getConnection()

  if (!connection) {
    return res.status(200).json({
      connected: false,
    })
  }

  if (config.configured && (connection.access_token || connection.refresh_token)) {
    try {
      const oauthClient = createOauthClient(config)

      oauthClient.setToken({
        ...(connection.raw_token || {}),
        access_token: connection.access_token || undefined,
        refresh_token: connection.refresh_token || undefined,
        token_type: connection.token_type || undefined,
      })

      await oauthClient.revoke()
    } catch {
      // Revocation failures shouldn't block local cleanup.
    }
  }

  await quickbooksService.clearConnection(req.auth_context?.actor_id)

  return res.status(200).json({
    connected: false,
  })
}
