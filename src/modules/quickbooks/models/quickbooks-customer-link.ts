import { model } from "@medusajs/framework/utils"

const QuickbooksCustomerLink = model.define("quickbooks_customer_link", {
  id: model.id().primaryKey(),
  medusa_customer_id: model.text(),
  quickbooks_customer_id: model.text(),
  quickbooks_sync_token: model.text().nullable(),
  realm_id: model.text().nullable(),
  last_synced_hash: model.text().nullable(),
  last_direction: model.text().nullable(),
  last_synced_at: model.dateTime().nullable(),
  metadata: model.json().nullable(),
})

export default QuickbooksCustomerLink
