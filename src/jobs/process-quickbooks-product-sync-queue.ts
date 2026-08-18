import type { MedusaContainer } from "@medusajs/framework/types";

import syncQueuedQuickbooksProductWorkflow from "../workflows/sync-queued-quickbooks-product";
import { QUICKBOOKS_MODULE } from "../modules/quickbooks";
import QuickbooksModuleService from "../modules/quickbooks/service";

let running = false;

const maxProductsPerRun = 10;
const productIntervalMs = Number(
  process.env.QUICKBOOKS_SYNC_PRODUCT_INTERVAL_MS || 3000,
);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export default async function processQuickbooksProductSyncQueue(
  container: MedusaContainer,
) {
  if (running) return;
  running = true;

  try {
    const quickbooks = container.resolve<QuickbooksModuleService>(QUICKBOOKS_MODULE);
    await quickbooks.releaseStaleProductSyncQueueItems();

    for (let index = 0; index < maxProductsPerRun; index += 1) {
      const item = await quickbooks.getNextProductSyncQueueItem();
      if (!item) break;

      try {
        await syncQueuedQuickbooksProductWorkflow(container).run({
          input: {
            queueId: item.id,
            productId: item.product_id,
          },
        });
      } catch (error) {
        await quickbooks.retryProductSyncQueueItem(
          item.id,
          error instanceof Error ? error.message : String(error),
          5 * 60 * 1000,
        );
      }

      if (index < maxProductsPerRun - 1) {
        await sleep(productIntervalMs);
      }
    }
  } finally {
    running = false;
  }
}

export const config = {
  name: "process-quickbooks-product-sync-queue",
  schedule: "* * * * *",
};
