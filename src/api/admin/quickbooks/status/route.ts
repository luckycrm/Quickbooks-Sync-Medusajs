import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"

import { QUICKBOOKS_MODULE } from "../../../../modules/quickbooks"
import type QuickbooksModuleService from "../../../../modules/quickbooks/service"
import {
  findQuickbooksAccounts,
  getBaseUrl,
  getCompanyInfo,
  getQuickbooksConfig,
  isConnectionExpired,
  refreshOauthToken,
  toStoredConnection,
} from "../../../../lib/quickbooks"

const asString = (value: unknown) => (typeof value === "string" ? value : null)

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const config = getQuickbooksConfig(getBaseUrl(req))
  const quickbooksService: QuickbooksModuleService = req.scope.resolve(
    QUICKBOOKS_MODULE
  )

  if (!config.configured) {
    return res.status(200).json({
      configured: false,
      connected: false,
      missingKeys: config.missingKeys,
      environment: config.environment,
      redirectUri: config.redirectUri,
    })
  }

  let connection = await quickbooksService.getConnection()

  if (connection && connection.refresh_token && isConnectionExpired(connection)) {
    try {
      const refreshedToken = await refreshOauthToken(connection, config)

      connection = await quickbooksService.upsertConnection(
        toStoredConnection(refreshedToken, req.auth_context?.actor_id)
      )
    } catch (e) {
      return res.status(200).json({
        configured: true,
        connected: false,
        environment: config.environment,
        redirectUri: config.redirectUri,
        error: e instanceof Error ? e.message : "Unable to refresh QuickBooks token.",
      })
    }
  }

  if (!connection?.access_token || !connection?.realm_id) {
    return res.status(200).json({
      configured: true,
      connected: false,
      environment: config.environment,
      redirectUri: config.redirectUri,
    })
  }

  let company: Record<string, unknown> | null = null
  let incomeAccounts: Record<string, unknown>[] = []

  try {
    company = await getCompanyInfo(connection, config)
    incomeAccounts = await findQuickbooksAccounts(connection, config, {
      AccountType: "Income",
      Active: true,
    })
  } catch (e) {
    return res.status(200).json({
      configured: true,
      connected: true,
      environment: connection.environment,
      redirectUri: config.redirectUri,
      realmId: connection.realm_id,
      expiresAt: connection.expires_at,
      connectedAt: connection.connected_at,
      company: null,
      incomeAccounts: [],
      selectedIncomeAccountId: connection.quickbooks_product_income_account_id,
      selectedIncomeAccountName: connection.quickbooks_product_income_account_name,
      companyError:
        e instanceof Error
          ? e.message
          : "Unable to fetch QuickBooks company information.",
    })
  }

  return res.status(200).json({
    configured: true,
    connected: true,
    environment: connection.environment,
    redirectUri: config.redirectUri,
    realmId: connection.realm_id,
    expiresAt: connection.expires_at,
    connectedAt: connection.connected_at,
    company,
    incomeAccounts: incomeAccounts.map((account) => ({
      id: asString(account.Id),
      name: asString(account.Name),
      fullyQualifiedName: asString(account.FullyQualifiedName),
      accountType: asString(account.AccountType),
      accountSubType: asString(account.AccountSubType),
    })),
    selectedIncomeAccountId: connection.quickbooks_product_income_account_id,
    selectedIncomeAccountName: connection.quickbooks_product_income_account_name,
  })
}
