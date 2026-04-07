export const QUICKBOOKS_INVENTORY_SOURCE_OF_TRUTH = "medusa"

const asRecord = (value: unknown) => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }

  return null
}

export const QUICKBOOKS_ITEM_INVENTORY_FIELDS = [
  "QtyOnHand",
  "TrackQtyOnHand",
  "InvStartDate",
  "AssetAccountRef",
  "ExpenseAccountRef",
  "IncomeAccountRef",
  "PurchaseCost",
  "Type",
] as const

export const MEDUSA_QUICKBOOKS_IMAGE_NOTE_PREFIX = "medusa-image-sync:"

export function quickbooksItemHasInventoryFields(item: Record<string, unknown>) {
  return QUICKBOOKS_ITEM_INVENTORY_FIELDS.some((field) => field in item)
}

export function quickbooksItemInventorySnapshot(item: Record<string, unknown>) {
  return {
    type: item.Type ?? null,
    track_qty_on_hand: item.TrackQtyOnHand ?? null,
    qty_on_hand: item.QtyOnHand ?? null,
    inv_start_date: item.InvStartDate ?? null,
    purchase_cost: item.PurchaseCost ?? null,
    income_account_ref: asRecord(item.IncomeAccountRef) ?? null,
    expense_account_ref: asRecord(item.ExpenseAccountRef) ?? null,
    asset_account_ref: asRecord(item.AssetAccountRef) ?? null,
  }
}

export function isQuickbooksImageAttachable(attachable: Record<string, unknown>) {
  const contentType =
    typeof attachable.ContentType === "string"
      ? attachable.ContentType.toLowerCase()
      : ""
  const fileName =
    typeof attachable.FileName === "string"
      ? attachable.FileName.toLowerCase()
      : ""

  return (
    contentType.startsWith("image/") ||
    /\.(jpg|jpeg|png|gif|tif|tiff)$/i.test(fileName)
  )
}

export function buildMedusaImageAttachableNote(input: {
  medusa_product_id: string
  medusa_image_url: string
}) {
  return `${MEDUSA_QUICKBOOKS_IMAGE_NOTE_PREFIX}${JSON.stringify(input)}`
}

export function isPluginManagedQuickbooksImageAttachable(
  attachable: Record<string, unknown>,
  medusaProductId?: string
) {
  const note = typeof attachable.Note === "string" ? attachable.Note : ""

  if (!note.startsWith(MEDUSA_QUICKBOOKS_IMAGE_NOTE_PREFIX)) {
    return false
  }

  if (!medusaProductId) {
    return true
  }

  return note.includes(`"medusa_product_id":"${medusaProductId}"`)
}

export function shouldSkipQuickbooksItemWebhook(item: Record<string, unknown>) {
  if (quickbooksItemHasInventoryFields(item)) {
    return {
      skipped: true,
      reason:
        "Ignored QuickBooks item webhook inventory fields because Medusa is the inventory source of truth.",
      source_of_truth: QUICKBOOKS_INVENTORY_SOURCE_OF_TRUTH,
      inventory: quickbooksItemInventorySnapshot(item),
    }
  }

  return {
    skipped: false,
    reason: null,
    source_of_truth: QUICKBOOKS_INVENTORY_SOURCE_OF_TRUTH,
    inventory: null,
  }
}
