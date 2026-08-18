import type { MedusaContainer } from "@medusajs/framework/types";
import {
  createStep,
  createWorkflow,
  StepResponse,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk";

import { QUICKBOOKS_MODULE } from "../modules/quickbooks";
import QuickbooksModuleService from "../modules/quickbooks/service";
import { syncMedusaProductsToQuickbooks } from "../lib/product-sync-service";

type SyncQueuedProductInput = {
  queueId: string;
  productId: string;
};

const syncQueuedProductStep = createStep(
  "sync-queued-quickbooks-product",
  async (
    input: SyncQueuedProductInput,
    { container }: { container: MedusaContainer },
  ) => {
    const quickbooks = container.resolve<QuickbooksModuleService>(QUICKBOOKS_MODULE);
    const result = await syncMedusaProductsToQuickbooks(container, [
      input.productId,
    ]);

    if (result.failed > 0) {
      const delayMs = Math.min(
        60 * 60 * 1000,
        5 * 60 * 1000,
      );
      await quickbooks.retryProductSyncQueueItem(
        input.queueId,
        String(result.results[0]?.reason || "QuickBooks product sync failed"),
        delayMs,
      );

      return new StepResponse({ queuedForRetry: true, result });
    }

    await quickbooks.completeProductSyncQueueItem(input.queueId);
    return new StepResponse({ queuedForRetry: false, result });
  },
);

export const syncQueuedQuickbooksProductWorkflow = createWorkflow(
  "sync-queued-quickbooks-product",
  (input: SyncQueuedProductInput) => {
    const result = syncQueuedProductStep(input);
    return new WorkflowResponse(result);
  },
);

export default syncQueuedQuickbooksProductWorkflow;
