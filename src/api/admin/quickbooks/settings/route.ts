import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"

import { QUICKBOOKS_MODULE } from "../../../../modules/quickbooks"
import type QuickbooksModuleService from "../../../../modules/quickbooks/service"
import {
  findQuickbooksAccounts,
  getBaseUrl,
  getQuickbooksConfig,
  isConnectionExpired,
  refreshOauthToken,
  toStoredConnection,
} from "../../../../lib/quickbooks"

const asRecord = (value: unknown) => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }

  return null
}

const asString = (value: unknown) => (typeof value === "string" ? value.trim() : "")

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const config = getQuickbooksConfig(getBaseUrl(req))
  const quickbooksService: QuickbooksModuleService = req.scope.resolve(
    QUICKBOOKS_MODULE
  )

  if (!config.configured) {
    return res.status(400).json({
      message: "QuickBooks backend is not configured.",
      missingKeys: config.missingKeys,
    })
  }

  let connection = await quickbooksService.getConnection()

  if (connection && connection.refresh_token && isConnectionExpired(connection)) {
    const refreshedToken = await refreshOauthToken(connection, config)

    connection = await quickbooksService.upsertConnection(
      toStoredConnection(refreshedToken, req.auth_context?.actor_id)
    )
  }

  if (!connection?.access_token || !connection?.realm_id) {
    return res.status(400).json({
      message: "QuickBooks is not connected.",
    })
  }

  const body = asRecord(req.body) || {}
  const incomeAccountId = asString(body.quickbooks_product_income_account_id)

  if (!incomeAccountId) {
    return res.status(400).json({
      message: "quickbooks_product_income_account_id is required.",
    })
  }

  const accounts = await findQuickbooksAccounts(connection, config, {
    Id: incomeAccountId,
    AccountType: "Income",
    Active: true,
  })
  const account = accounts[0]

  if (!account?.Id) {
    return res.status(400).json({
      message: "Selected QuickBooks income account was not found.",
    })
  }

  const updatedConnection = await quickbooksService.upsertConnection({
    environment: connection.environment,
    realm_id: connection.realm_id,
    access_token: connection.access_token,
    refresh_token: connection.refresh_token,
    token_type: connection.token_type,
    scope: (connection.scope as Record<string, unknown> | null) || null,
    expires_at: connection.expires_at ? new Date(connection.expires_at) : null,
    refresh_token_expires_at: connection.refresh_token_expires_at
      ? new Date(connection.refresh_token_expires_at)
      : null,
    raw_token: (connection.raw_token as Record<string, unknown> | null) || null,
    connected_at: connection.connected_at ? new Date(connection.connected_at) : null,
    disconnected_at: connection.disconnected_at
      ? new Date(connection.disconnected_at)
      : null,
    quickbooks_product_income_account_id: String(account.Id),
    quickbooks_product_income_account_name:
      typeof account.Name === "string" ? account.Name : null,
    updated_by: req.auth_context?.actor_id ?? null,
  })

  return res.status(200).json({
    quickbooks_product_income_account_id:
      updatedConnection.quickbooks_product_income_account_id,
    quickbooks_product_income_account_name:
      updatedConnection.quickbooks_product_income_account_name,
  })
}
