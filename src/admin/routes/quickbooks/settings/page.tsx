import { defineRouteConfig } from "@medusajs/admin-sdk"

import QuickbooksSettingsPage from "../../../components/quickbooks-settings-page"

export const config = defineRouteConfig({
  label: "Settings",
  rank: 4,
})

export const handle = {
  breadcrumb: () => "Settings",
}

export default QuickbooksSettingsPage
