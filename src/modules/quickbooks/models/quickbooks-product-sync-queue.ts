import { model } from "@medusajs/framework/utils";

const QuickbooksProductSyncQueue = model.define("quickbooks_product_sync_queue", {
  id: model.id().primaryKey(),
  product_id: model.text().unique(),
  status: model.text().default("pending"),
  attempts: model.number().default(0),
  available_at: model.dateTime(),
  locked_at: model.dateTime().nullable(),
  last_error: model.text().nullable(),
});

export default QuickbooksProductSyncQueue;
