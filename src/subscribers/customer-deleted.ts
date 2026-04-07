import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"

import { deleteMedusaCustomerFromQuickbooks } from "../lib/customer-sync-service"

export default async function customerDeletedHandler({
  event: { data },
  container,
}: SubscriberArgs<{ id: string }>) {
  const result = await deleteMedusaCustomerFromQuickbooks(container, data.id)

  console.log("[quickbooks-customer-sync] medusa->quickbooks deleted", result)
}

export const config: SubscriberConfig = {
  event: "customer.deleted",
  context: {
    subscriberId: "quickbooks-sync-customer-deleted-handler",
  },
}
