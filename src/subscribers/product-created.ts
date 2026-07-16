import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework";

import { syncMedusaProductToQuickbooks } from "../lib/product-sync-service";

export default async function productCreatedHandler({
  event: { data },
  container,
}: SubscriberArgs<{ id: string }>) {
  const result = await syncMedusaProductToQuickbooks(container, data.id);

  console.log("[quickbooks-product-sync] medusa->quickbooks created", result);
}

export const config: SubscriberConfig = {
  event: "product.created",
  context: {
    subscriberId: "quickbooks-product-created",
  },
};
