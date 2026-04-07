import { Module } from "@medusajs/framework/utils"

import QuickbooksModuleService from "./service"

export const QUICKBOOKS_MODULE = "quickbooks"

export default Module(QUICKBOOKS_MODULE, {
  service: QuickbooksModuleService,
})
