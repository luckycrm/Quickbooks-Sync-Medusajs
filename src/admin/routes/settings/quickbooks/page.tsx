import { defineRouteConfig } from "@medusajs/admin-sdk"

import QuickbooksSettingsPage from "../../../components/quickbooks-settings-page"

export const config = defineRouteConfig({
  label: "QuickBooks",
})

export default QuickbooksSettingsPage
