import { model } from "@medusajs/framework/utils"

const QuickbooksOrderLink = model.define("quickbooks_order_link", {
  id: model.id().primaryKey(),
  medusa_order_id: model.text(),
  quickbooks_sales_receipt_id: model.text().nullable(),
  quickbooks_invoice_id: model.text().nullable(),
  quickbooks_sync_token: model.text().nullable(),
  realm_id: model.text().nullable(),
  sync_type: model.text().nullable(),
  last_synced_hash: model.text().nullable(),
  last_synced_at: model.dateTime().nullable(),
  metadata: model.json().nullable(),
})

export default QuickbooksOrderLink