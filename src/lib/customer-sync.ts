import { createHash } from "crypto"

const asRecord = (value: unknown) => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }

  return null
}

export const normalizeEmail = (value: unknown) =>
  typeof value === "string" ? value.trim().toLowerCase() : ""

export const normalizePhone = (value: unknown) =>
  typeof value === "string" ? value.replace(/\D/g, "") : ""

export const formatPhoneForQuickbooks = (value: unknown) => {
  const digits = normalizePhone(value)

  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`
  }

  return digits || null
}

export const parseQuickbooksNotes = (value: unknown) => {
  if (typeof value !== "string" || !value.trim()) {
    return null
  }

  try {
    const parsed = JSON.parse(value)
    return asRecord(parsed)
  } catch {
    return null
  }
}

export const buildQuickbooksNotes = (medusaCustomer: Record<string, unknown>) =>
  JSON.stringify({
    medusa_id: medusaCustomer.id || null,
    has_account: medusaCustomer.has_account ?? false,
    created_at: medusaCustomer.created_at || null,
    updated_at: medusaCustomer.updated_at || null,
    metadata: medusaCustomer.metadata || {},
  })

export const normalizeMedusaCustomerForSync = (
  customer: Record<string, unknown>
) => ({
  email: normalizeEmail(customer.email),
  first_name: typeof customer.first_name === "string" ? customer.first_name.trim() : "",
  last_name: typeof customer.last_name === "string" ? customer.last_name.trim() : "",
  company_name:
    typeof customer.company_name === "string" ? customer.company_name.trim() : "",
  phone: normalizePhone(customer.phone),
})

export const normalizeQuickbooksCustomerForSync = (
  customer: Record<string, unknown>
) => ({
  email: normalizeEmail(asRecord(customer.PrimaryEmailAddr)?.Address),
  first_name: typeof customer.GivenName === "string" ? customer.GivenName.trim() : "",
  last_name: typeof customer.FamilyName === "string" ? customer.FamilyName.trim() : "",
  company_name:
    typeof customer.CompanyName === "string" ? customer.CompanyName.trim() : "",
  phone: normalizePhone(asRecord(customer.PrimaryPhone)?.FreeFormNumber),
})

export const hashCustomerPayload = (value: Record<string, unknown>) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex")

export const toQuickbooksCustomerPayload = (
  medusaCustomer: Record<string, unknown>,
  existingQuickbooksCustomer?: Record<string, unknown> | null,
  options?: {
    metadataOnly?: boolean
  }
) => {
  const payload: Record<string, unknown> = {
    Notes: buildQuickbooksNotes(medusaCustomer),
  }

  if (!options?.metadataOnly) {
    const formattedPhone = formatPhoneForQuickbooks(medusaCustomer.phone)

    payload.GivenName = medusaCustomer.first_name || undefined
    payload.FamilyName = medusaCustomer.last_name || undefined
    payload.CompanyName = medusaCustomer.company_name || undefined
    payload.DisplayName =
      [medusaCustomer.first_name, medusaCustomer.last_name]
        .filter(Boolean)
        .join(" ") || medusaCustomer.email
    payload.PrimaryEmailAddr = medusaCustomer.email
      ? { Address: medusaCustomer.email }
      : undefined
    payload.PrimaryPhone = formattedPhone
      ? { FreeFormNumber: formattedPhone }
      : undefined
  }

  if (existingQuickbooksCustomer?.Id) {
    payload.Id = existingQuickbooksCustomer.Id
    payload.SyncToken = existingQuickbooksCustomer.SyncToken
    payload.sparse = true
  }

  return payload
}

export const toMedusaCustomerInput = (quickbooksCustomer: Record<string, unknown>) => ({
  email: normalizeEmail(asRecord(quickbooksCustomer.PrimaryEmailAddr)?.Address) || null,
  first_name:
    typeof quickbooksCustomer.GivenName === "string"
      ? quickbooksCustomer.GivenName.trim()
      : null,
  last_name:
    typeof quickbooksCustomer.FamilyName === "string"
      ? quickbooksCustomer.FamilyName.trim()
      : null,
  company_name:
    typeof quickbooksCustomer.CompanyName === "string"
      ? quickbooksCustomer.CompanyName.trim()
      : null,
  phone: normalizePhone(asRecord(quickbooksCustomer.PrimaryPhone)?.FreeFormNumber) || null,
})
