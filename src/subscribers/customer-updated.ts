import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"

import { syncMedusaCustomerToQuickbooks } from "../lib/customer-sync-service"

export default async function customerUpdatedHandler({
  event: { data },
  container,
}: SubscriberArgs<{ id: string }>) {
  const result = await syncMedusaCustomerToQuickbooks(container, data.id)

  console.log("[quickbooks-customer-sync] medusa->quickbooks updated", result)
}

export const config: SubscriberConfig = {
  event: "customer.updated",
}
