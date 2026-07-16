import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework";

import { syncMedusaOrderToQuickbooks } from "../lib/order-sync-service";

export default async function orderCompletedHandler({
  event: { data },
  container,
}: SubscriberArgs<{ id: string }>) {
  const result = await syncMedusaOrderToQuickbooks(container, data.id);

  console.log("[quickbooks-order-sync] medusa->quickbooks completed", result);
}

export const config: SubscriberConfig = {
  event: "order.completed",
  context: {
    subscriberId: "quickbooks-order-completed",
  },
};
