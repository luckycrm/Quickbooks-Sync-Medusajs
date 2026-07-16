import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { ContainerRegistrationKeys } from "@medusajs/framework/utils";

import { QUICKBOOKS_MODULE } from "../../../../modules/quickbooks";
import type QuickbooksModuleService from "../../../../modules/quickbooks/service";
import { getReadyQuickbooksConnection } from "../../../../lib/connection";
import {
  findQuickbooksAccounts,
  findQuickbooksTaxCodes,
  getBaseUrl,
  getCompanyInfo,
  getQuickbooksConfig,
} from "../../../../lib/quickbooks";

const asString = (value: unknown) => (typeof value === "string" ? value : null);

async function listStoreCurrencies(scope: AuthenticatedMedusaRequest["scope"]) {
  try {
    const query = scope.resolve(ContainerRegistrationKeys.QUERY) as {
      graph: (input: {
        entity: string;
        fields: string[];
      }) => Promise<{ data?: Record<string, unknown>[] }>;
    };

    const response = await query.graph({
      entity: "store",
      fields: [
        "supported_currencies.currency_code",
        "supported_currencies.is_default",
      ],
    });

    const store = response.data?.[0];
    const supported = Array.isArray(store?.supported_currencies)
      ? (store.supported_currencies as Record<string, unknown>[])
      : [];

    return supported
      .map((currency) => ({
        code: asString(currency.currency_code),
        isDefault: currency.is_default === true,
      }))
      .filter((currency): currency is { code: string; isDefault: boolean } =>
        Boolean(currency.code),
      );
  } catch {
    return [];
  }
}

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
) {
  const config = getQuickbooksConfig(getBaseUrl(req));
  const quickbooksService: QuickbooksModuleService =
    req.scope.resolve(QUICKBOOKS_MODULE);

  if (!config.configured) {
    return res.status(200).json({
      configured: false,
      connected: false,
      missingKeys: config.missingKeys,
      environment: config.environment,
      redirectUri: config.redirectUri,
    });
  }

  let connection: Awaited<
    ReturnType<QuickbooksModuleService["getConnection"]>
  > | null = null;

  try {
    ({ connection } = await getReadyQuickbooksConnection(
      req.scope,
      req.auth_context?.actor_id,
      config,
    ));
  } catch (e) {
    return res.status(200).json({
      configured: true,
      connected: false,
      environment: config.environment,
      redirectUri: config.redirectUri,
      error:
        e instanceof Error ? e.message : "Unable to refresh QuickBooks token.",
    });
  }

  if (!connection?.access_token || !connection?.realm_id) {
    return res.status(200).json({
      configured: true,
      connected: false,
      environment: config.environment,
      redirectUri: config.redirectUri,
    });
  }

  let company: Record<string, unknown> | null = null;
  let incomeAccounts: Record<string, unknown>[] = [];
  let taxCodes: Record<string, unknown>[] = [];

  try {
    company = await getCompanyInfo(connection, config);
    incomeAccounts = await findQuickbooksAccounts(connection, config, {
      AccountType: "Income",
      Active: true,
    });
    taxCodes = await findQuickbooksTaxCodes(connection, config);
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
      selectedIncomeAccountName:
        connection.quickbooks_product_income_account_name,
      companyError:
        e instanceof Error
          ? e.message
          : "Unable to fetch QuickBooks company information.",
    });
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
    selectedIncomeAccountName:
      connection.quickbooks_product_income_account_name,
    selectedPriceCurrency: connection.quickbooks_price_currency || null,
    availableCurrencies: await listStoreCurrencies(req.scope),
    selectedOrderTaxTreatment:
      connection.quickbooks_order_tax_treatment || null,
    selectedOrderTaxCodeId: connection.quickbooks_order_tax_code_id || null,
    selectedOrderTaxCodeName: connection.quickbooks_order_tax_code_name || null,
    taxCodes: taxCodes
      .filter((code) => code.Active !== false)
      .map((code) => ({
        id: asString(code.Id),
        name: asString(code.Name),
        description: asString(code.Description),
      })),
  });
}
