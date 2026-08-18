import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework";

import { QUICKBOOKS_MODULE } from "../modules/quickbooks";
import QuickbooksModuleService from "../modules/quickbooks/service";

export default async function productUpdatedHandler({
  event: { data },
  container,
}: SubscriberArgs<{ id: string }>) {
  const logger = container.resolve("logger");
  const quickbooks = container.resolve<QuickbooksModuleService>(QUICKBOOKS_MODULE);
  await quickbooks.enqueueProductSync(data.id);
  logger.info(`[quickbooks-product-sync] Queued product ${data.id} for background sync`);
}

export const config: SubscriberConfig = {
  event: "product.updated",
  context: {
    subscriberId: "quickbooks-product-updated",
  },
};
