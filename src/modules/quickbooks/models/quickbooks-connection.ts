import { model } from "@medusajs/framework/utils"

const QuickbooksConnection = model.define("quickbooks_connection", {
  id: model.id().primaryKey(),
  provider: model.text().default("quickbooks"),
  environment: model.text().default("sandbox"),
  realm_id: model.text().nullable(),
  access_token: model.text().nullable(),
  refresh_token: model.text().nullable(),
  token_type: model.text().nullable(),
  scope: model.json().nullable(),
  expires_at: model.dateTime().nullable(),
  refresh_token_expires_at: model.dateTime().nullable(),
  raw_token: model.json().nullable(),
  connected_at: model.dateTime().nullable(),
  disconnected_at: model.dateTime().nullable(),
  quickbooks_product_income_account_id: model.text().nullable(),
  quickbooks_product_income_account_name: model.text().nullable(),
  updated_by: model.text().nullable(),
})

export default QuickbooksConnection
