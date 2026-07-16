import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import {
  isFullProductSyncRunning,
  syncAllMedusaProductsToQuickbooks,
  syncMedusaProductsToQuickbooks,
} from "../../../../../lib/product-sync-service";

const asRecord = (value: unknown) => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return null;
};

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
) {
  const body = asRecord(req.body) || {};
  const syncAll = body.sync_all === true;
  const productIds = Array.isArray(body.product_ids)
    ? body.product_ids.filter(
        (value): value is string => typeof value === "string",
      )
    : [];

  if (!syncAll && !productIds.length) {
    return res.status(400).json({
      message: "product_ids is required unless sync_all is true.",
    });
  }

  if (syncAll) {
    if (isFullProductSyncRunning()) {
      return res.status(409).json({
        message: "A full product sync is already running.",
      });
    }

    // A paced full-catalog sync can take 15+ minutes — far longer than an
    // HTTP request should live. Kick it off and report progress via logs and
    // the products status endpoint.
    void syncAllMedusaProductsToQuickbooks(req.scope).catch((error) => {
      console.error("[quickbooks-sync] background full sync failed", {
        error: error instanceof Error ? error.message : error,
      });
    });

    return res.status(202).json({
      started: true,
      message:
        "Full product sync started in the background. Progress is logged on the server; refresh the products page to see results.",
    });
  }

  const result = await syncMedusaProductsToQuickbooks(req.scope, productIds);

  res.status(200).json(result);
}
