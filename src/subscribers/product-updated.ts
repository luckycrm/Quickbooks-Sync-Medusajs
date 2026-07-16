import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework";

import { syncMedusaProductToQuickbooks } from "../lib/product-sync-service";

export default async function productUpdatedHandler({
  event: { data },
  container,
}: SubscriberArgs<{ id: string }>) {
  const result = await syncMedusaProductToQuickbooks(container, data.id);

  console.log("[quickbooks-product-sync] medusa->quickbooks updated", result);
}

export const config: SubscriberConfig = {
  event: "product.updated",
};
