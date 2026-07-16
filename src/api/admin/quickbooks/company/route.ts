import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { getReadyQuickbooksConnection } from "../../../../lib/connection";
import {
  getBaseUrl,
  getCompanyInfo,
  getQuickbooksConfig,
  updateCompanyInfo,
} from "../../../../lib/quickbooks";

const asRecord = (value: unknown) => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return null;
};

const stringOrUndefined = (value: unknown) => {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
};

const addressFromInput = (value: unknown) => {
  const address = asRecord(value);

  if (!address) {
    return undefined;
  }

  const result = {
    Line1: stringOrUndefined(address.Line1),
    City: stringOrUndefined(address.City),
    CountrySubDivisionCode: stringOrUndefined(address.CountrySubDivisionCode),
    PostalCode: stringOrUndefined(address.PostalCode),
    Country: stringOrUndefined(address.Country),
  };

  return Object.values(result).some(Boolean) ? result : undefined;
};

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

  const { connection } = await getReadyQuickbooksConnection(
    req.scope,
    req.auth_context?.actor_id,
    config,
  );

  if (!connection?.access_token || !connection?.realm_id) {
    return res.status(400).json({
      message: "QuickBooks is not connected.",
    });
  }

  const currentCompany = asRecord(await getCompanyInfo(connection, config));

  if (!currentCompany?.Id || !currentCompany?.SyncToken) {
    return res.status(400).json({
      message: "Unable to load the current QuickBooks company information.",
    });
  }

  const body = asRecord(req.body) || {};

  const updatePayload: Record<string, unknown> = {
    Id: currentCompany.Id,
    SyncToken: currentCompany.SyncToken,
    sparse: true,
  };

  const companyName = stringOrUndefined(body.CompanyName);
  const legalName = stringOrUndefined(body.LegalName);
  const companyEmail = stringOrUndefined(body.CompanyEmail);
  const primaryPhone = stringOrUndefined(body.PrimaryPhone);
  const website = stringOrUndefined(body.Website);
  const customerCommunicationEmail = stringOrUndefined(
    body.CustomerCommunicationEmail,
  );
  const companyAddr = addressFromInput(body.CompanyAddr);
  const legalAddr = addressFromInput(body.LegalAddr);
  const customerCommunicationAddr = addressFromInput(
    body.CustomerCommunicationAddr,
  );

  if (companyName) {
    updatePayload.CompanyName = companyName;
  }

  if (legalName) {
    updatePayload.LegalName = legalName;
  }

  if (companyEmail) {
    updatePayload.Email = {
      Address: companyEmail,
    };
  }

  if (primaryPhone) {
    updatePayload.PrimaryPhone = {
      FreeFormNumber: primaryPhone,
    };
  }

  if (website) {
    updatePayload.WebAddr = {
      URI: website,
    };
  }

  if (customerCommunicationEmail) {
    updatePayload.CustomerCommunicationEmailAddr = {
      Address: customerCommunicationEmail,
    };
  }

  if (companyAddr) {
    updatePayload.CompanyAddr = companyAddr;
  }

  if (legalAddr) {
    updatePayload.LegalAddr = legalAddr;
  }

  if (customerCommunicationAddr) {
    updatePayload.CustomerCommunicationAddr = customerCommunicationAddr;
  }

  if (Object.keys(updatePayload).length <= 3) {
    return res.status(400).json({
      message: "No company fields were provided to update.",
    });
  }

  const company = await updateCompanyInfo(connection, config, updatePayload);

  return res.status(200).json({
    company,
  });
}
