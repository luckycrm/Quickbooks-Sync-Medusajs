import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { getReadyQuickbooksConnection } from "../../../../lib/connection";
import {
  findQuickbooksAccounts,
  findQuickbooksTaxCodes,
  getBaseUrl,
  getQuickbooksConfig,
} from "../../../../lib/quickbooks";

const asRecord = (value: unknown) => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return null;
};

const asString = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
) {
  const config = getQuickbooksConfig(getBaseUrl(req));

  if (!config.configured) {
    return res.status(400).json({
      message: "QuickBooks backend is not configured.",
      missingKeys: config.missingKeys,
    });
  }

  const { quickbooksService, connection } = await getReadyQuickbooksConnection(
    req.scope,
    req.auth_context?.actor_id,
    config,
  );

  if (!connection?.access_token || !connection?.realm_id) {
    return res.status(400).json({
      message: "QuickBooks is not connected.",
    });
  }

  const body = asRecord(req.body) || {};
  const incomeAccountId = asString(body.quickbooks_product_income_account_id);
  const priceCurrency = asString(body.quickbooks_price_currency).toLowerCase();
  const hasOrderTaxFields =
    !!asString(body.quickbooks_order_tax_treatment) ||
    !!asString(body.quickbooks_order_tax_code_id);

  if (!incomeAccountId && !priceCurrency && !hasOrderTaxFields) {
    return res.status(400).json({
      message:
        "Provide at least one setting: quickbooks_product_income_account_id, quickbooks_price_currency, quickbooks_order_tax_treatment or quickbooks_order_tax_code_id.",
    });
  }

  if (priceCurrency && !/^[a-z]{3}$/.test(priceCurrency)) {
    return res.status(400).json({
      message: "quickbooks_price_currency must be a 3-letter currency code.",
    });
  }

  const orderTaxTreatment = asString(
    body.quickbooks_order_tax_treatment,
  ).toLowerCase();
  const orderTaxCodeId = asString(body.quickbooks_order_tax_code_id);

  if (
    orderTaxTreatment &&
    !["out_of_scope", "inclusive", "exclusive"].includes(orderTaxTreatment)
  ) {
    return res.status(400).json({
      message:
        "quickbooks_order_tax_treatment must be one of: out_of_scope, inclusive, exclusive.",
    });
  }

  let taxCode: Record<string, unknown> | null = null;

  if (orderTaxCodeId) {
    const taxCodes = await findQuickbooksTaxCodes(connection, config);
    taxCode =
      taxCodes.find((code) => String(code.Id) === orderTaxCodeId) || null;

    if (!taxCode?.Id) {
      return res.status(400).json({
        message: "Selected QuickBooks sales tax code was not found.",
      });
    }
  }

  let account: Record<string, unknown> | null = null;

  if (incomeAccountId) {
    const accounts = await findQuickbooksAccounts(connection, config, {
      Id: incomeAccountId,
      AccountType: "Income",
      Active: true,
    });
    account = accounts[0] || null;

    if (!account?.Id) {
      return res.status(400).json({
        message: "Selected QuickBooks income account was not found.",
      });
    }
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
    connected_at: connection.connected_at
      ? new Date(connection.connected_at)
      : null,
    disconnected_at: connection.disconnected_at
      ? new Date(connection.disconnected_at)
      : null,
    quickbooks_product_income_account_id: account?.Id
      ? String(account.Id)
      : connection.quickbooks_product_income_account_id || null,
    quickbooks_product_income_account_name: account?.Id
      ? typeof account.Name === "string"
        ? account.Name
        : null
      : connection.quickbooks_product_income_account_name || null,
    quickbooks_price_currency:
      priceCurrency || connection.quickbooks_price_currency || null,
    quickbooks_order_tax_treatment:
      orderTaxTreatment || connection.quickbooks_order_tax_treatment || null,
    quickbooks_order_tax_code_id: taxCode?.Id
      ? String(taxCode.Id)
      : connection.quickbooks_order_tax_code_id || null,
    quickbooks_order_tax_code_name: taxCode?.Id
      ? typeof taxCode.Name === "string"
        ? taxCode.Name
        : null
      : connection.quickbooks_order_tax_code_name || null,
    updated_by: req.auth_context?.actor_id ?? null,
  });

  return res.status(200).json({
    quickbooks_product_income_account_id:
      updatedConnection.quickbooks_product_income_account_id,
    quickbooks_product_income_account_name:
      updatedConnection.quickbooks_product_income_account_name,
    quickbooks_price_currency: updatedConnection.quickbooks_price_currency,
    quickbooks_order_tax_treatment:
      updatedConnection.quickbooks_order_tax_treatment,
    quickbooks_order_tax_code_id:
      updatedConnection.quickbooks_order_tax_code_id,
    quickbooks_order_tax_code_name:
      updatedConnection.quickbooks_order_tax_code_name,
  });
}
