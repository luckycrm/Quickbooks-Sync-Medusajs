import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework";

import { syncMedusaOrderToQuickbooks } from "../lib/order-sync-service";

export default async function orderUpdatedHandler({
  event: { data },
  container,
}: SubscriberArgs<{ id: string }>) {
  const result = await syncMedusaOrderToQuickbooks(container, data.id);

  console.log("[quickbooks-order-sync] medusa->quickbooks updated", result);
}

export const config: SubscriberConfig = {
  event: "order.updated",
  context: {
    subscriberId: "quickbooks-order-updated",
  },
};
