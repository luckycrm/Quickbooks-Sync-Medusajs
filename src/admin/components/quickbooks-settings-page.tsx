import type { FormEvent } from "react"
import { useEffect, useMemo, useState } from "react"
import {
  Alert,
  Badge,
  Button,
  Container,
  FocusModal,
  Heading,
  Input,
  InlineTip,
  Label,
  Tabs,
  Text,
} from "@medusajs/ui"
import { useSearchParams } from "react-router-dom"

type QuickbooksStatus = {
  configured: boolean
  connected: boolean
  missingKeys?: string[]
  environment?: string
  redirectUri?: string
  realmId?: string
  expiresAt?: string
  connectedAt?: string
  company?: Record<string, unknown> | null
  incomeAccounts?: Array<{
    id?: string | null
    name?: string | null
    fullyQualifiedName?: string | null
    accountType?: string | null
    accountSubType?: string | null
  }>
  selectedIncomeAccountId?: string | null
  selectedIncomeAccountName?: string | null
  companyError?: string
  error?: string
}

type CompanyAddressForm = {
  Line1: string
  City: string
  CountrySubDivisionCode: string
  PostalCode: string
  Country: string
}

type CompanyFormState = {
  CompanyName: string
  LegalName: string
  CompanyEmail: string
  PrimaryPhone: string
  Website: string
  CustomerCommunicationEmail: string
  CompanyAddr: CompanyAddressForm
  LegalAddr: CompanyAddressForm
  CustomerCommunicationAddr: CompanyAddressForm
}

const asRecord = (value: unknown) => {
  if (value && typeof value === "object") {
    return value as Record<string, unknown>
  }

  return null
}

const formatValue = (value: unknown) => {
  if (value === null || value === undefined || value === "") {
    return "-"
  }

  if (typeof value === "string") {
    return value
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value)
  }

  return JSON.stringify(value)
}

const formatAddress = (value: unknown) => {
  const address = asRecord(value)

  if (!address) {
    return "-"
  }

  const parts = [
    address.Line1,
    address.Line2,
    address.City,
    address.CountrySubDivisionCode,
    address.PostalCode,
    address.Country,
  ]
    .filter(Boolean)
    .map((part) => String(part))

  return parts.length ? parts.join(", ") : "-"
}

const addressToForm = (value: unknown): CompanyAddressForm => {
  const address = asRecord(value)

  return {
    Line1: String(address?.Line1 || ""),
    City: String(address?.City || ""),
    CountrySubDivisionCode: String(address?.CountrySubDivisionCode || ""),
    PostalCode: String(address?.PostalCode || ""),
    Country: String(address?.Country || ""),
  }
}

const companyToForm = (company: Record<string, unknown> | null): CompanyFormState => ({
  CompanyName: String(company?.CompanyName || ""),
  LegalName: String(company?.LegalName || ""),
  CompanyEmail: String(asRecord(company?.Email)?.Address || ""),
  PrimaryPhone: String(asRecord(company?.PrimaryPhone)?.FreeFormNumber || ""),
  Website: String(asRecord(company?.WebAddr)?.URI || ""),
  CustomerCommunicationEmail: String(
    asRecord(company?.CustomerCommunicationEmailAddr)?.Address || ""
  ),
  CompanyAddr: addressToForm(company?.CompanyAddr),
  LegalAddr: addressToForm(company?.LegalAddr),
  CustomerCommunicationAddr: addressToForm(company?.CustomerCommunicationAddr),
})

const Field = ({
  label,
  value,
  onChange,
  type = "text",
}: {
  label: string
  value: string
  onChange: (value: string) => void
  type?: string
}) => (
  <label className="flex flex-col gap-2">
    <Label size="small" weight="plus">
      {label}
    </Label>
    <Input
      value={value}
      type={type}
      className="w-full"
      onChange={(event) => onChange(event.target.value)}
    />
  </label>
)

const SummaryRow = ({
  label,
  value,
}: {
  label: string
  value: unknown
}) => (
  <div className="grid grid-cols-1 gap-1 border-b border-ui-border-base py-4 md:grid-cols-[220px_1fr] md:gap-4">
    <Text size="small" weight="plus" className="text-ui-fg-subtle">
      {label}
    </Text>
    <Text>{formatValue(value)}</Text>
  </div>
)

const SectionTitle = ({
  title,
  subtitle,
}: {
  title: string
  subtitle: string
}) => (
  <div>
    <Heading level="h2">{title}</Heading>
    <Text className="text-ui-fg-subtle" size="small">
      {subtitle}
    </Text>
  </div>
)

const EmptyState = ({ message }: { message: string }) => (
  <Text className="text-ui-fg-subtle" size="small">
    {message}
  </Text>
)

const AddressEditor = ({
  title,
  value,
  onChange,
}: {
  title: string
  value: CompanyAddressForm
  onChange: (field: keyof CompanyAddressForm, value: string) => void
}) => (
  <div className="rounded-md border border-ui-border-base p-4">
    <Heading level="h3">{title}</Heading>
    <div className="mt-4 grid grid-cols-1 gap-4">
      <Field
        label="Line 1"
        value={value.Line1}
        onChange={(nextValue) => onChange("Line1", nextValue)}
      />
      <Field
        label="City"
        value={value.City}
        onChange={(nextValue) => onChange("City", nextValue)}
      />
      <Field
        label="State / Province"
        value={value.CountrySubDivisionCode}
        onChange={(nextValue) => onChange("CountrySubDivisionCode", nextValue)}
      />
      <Field
        label="Postal code"
        value={value.PostalCode}
        onChange={(nextValue) => onChange("PostalCode", nextValue)}
      />
      <Field
        label="Country"
        value={value.Country}
        onChange={(nextValue) => onChange("Country", nextValue)}
      />
    </div>
  </div>
)

const QuickbooksSettingsPage = () => {
  const [searchParams, setSearchParams] = useSearchParams()
  const [status, setStatus] = useState<QuickbooksStatus | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isConnecting, setIsConnecting] = useState(false)
  const [isDisconnecting, setIsDisconnecting] = useState(false)
  const [isSavingCompany, setIsSavingCompany] = useState(false)
  const [isSavingSyncSettings, setIsSavingSyncSettings] = useState(false)
  const [isEditorOpen, setIsEditorOpen] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [selectedIncomeAccountId, setSelectedIncomeAccountId] = useState("")
  const [companyForm, setCompanyForm] = useState<CompanyFormState>(() =>
    companyToForm(null)
  )

  const callbackMessage = useMemo(() => {
    const state = searchParams.get("quickbooks")
    const errorMessage = searchParams.get("message")

    if (state === "connected") {
      return "QuickBooks connected successfully."
    }

    if (state === "error") {
      return errorMessage || "QuickBooks connection failed."
    }

    return null
  }, [searchParams])

  const loadStatus = async () => {
    setIsLoading(true)

    try {
      const response = await fetch("/admin/quickbooks/status")
      const json = (await response.json()) as QuickbooksStatus
      setStatus(json)
    } catch (e) {
      setMessage(
        e instanceof Error ? e.message : "Unable to load QuickBooks status."
      )
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    void loadStatus()
  }, [])

  useEffect(() => {
    if (callbackMessage) {
      setMessage(callbackMessage)

      const next = new URLSearchParams(searchParams)
      next.delete("quickbooks")
      next.delete("message")
      setSearchParams(next, { replace: true })
    }
  }, [callbackMessage, searchParams, setSearchParams])

  useEffect(() => {
    setCompanyForm(companyToForm(asRecord(status?.company)))
  }, [status?.company])

  useEffect(() => {
    setSelectedIncomeAccountId(status?.selectedIncomeAccountId || "")
  }, [status?.selectedIncomeAccountId])

  const handleConnect = async () => {
    setIsConnecting(true)
    setMessage(null)

    try {
      const response = await fetch("/admin/quickbooks/connect")
      const json = (await response.json()) as {
        url?: string
        missingKeys?: string[]
      }

      if (!response.ok || !json.url) {
        throw new Error(
          json.missingKeys?.length
            ? `Missing backend configuration: ${json.missingKeys.join(", ")}`
            : "Unable to start the QuickBooks connection flow."
        )
      }

      window.location.href = json.url
    } catch (e) {
      setMessage(
        e instanceof Error ? e.message : "Unable to start QuickBooks OAuth."
      )
      setIsConnecting(false)
    }
  }

  const handleDisconnect = async () => {
    setIsDisconnecting(true)
    setMessage(null)

    try {
      const response = await fetch("/admin/quickbooks/disconnect", {
        method: "POST",
      })

      if (!response.ok) {
        throw new Error("Unable to disconnect QuickBooks.")
      }

      setMessage("QuickBooks disconnected.")
      setIsEditorOpen(false)
      await loadStatus()
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Unable to disconnect.")
    } finally {
      setIsDisconnecting(false)
    }
  }

  const updateAddressField = (
    key: keyof Pick<
      CompanyFormState,
      "CompanyAddr" | "LegalAddr" | "CustomerCommunicationAddr"
    >,
    field: keyof CompanyAddressForm,
    value: string
  ) => {
    setCompanyForm((current) => ({
      ...current,
      [key]: {
        ...current[key],
        [field]: value,
      },
    }))
  }

  const handleSaveCompany = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setIsSavingCompany(true)
    setMessage(null)

    try {
      const response = await fetch("/admin/quickbooks/company", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(companyForm),
      })

      const json = (await response.json()) as { message?: string }

      if (!response.ok) {
        throw new Error(json.message || "Unable to update QuickBooks company info.")
      }

      setMessage("QuickBooks company info updated.")
      setIsEditorOpen(false)
      await loadStatus()
    } catch (e) {
      setMessage(
        e instanceof Error ? e.message : "Unable to update company info."
      )
    } finally {
      setIsSavingCompany(false)
    }
  }

  const handleSaveSyncSettings = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setIsSavingSyncSettings(true)
    setMessage(null)

    try {
      const response = await fetch("/admin/quickbooks/settings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          quickbooks_product_income_account_id: selectedIncomeAccountId,
        }),
      })

      const json = (await response.json()) as { message?: string }

      if (!response.ok) {
        throw new Error(json.message || "Unable to update QuickBooks sync settings.")
      }

      setMessage("QuickBooks product sync settings updated.")
      await loadStatus()
    } catch (e) {
      setMessage(
        e instanceof Error ? e.message : "Unable to update QuickBooks sync settings."
      )
    } finally {
      setIsSavingSyncSettings(false)
    }
  }

  const companyInfo = asRecord(status?.company)
  const companyName = String(
    companyInfo?.CompanyName || companyInfo?.LegalName || "QuickBooks company"
  )
  const needsReconnect =
    !!status?.error || (!!status?.connected && !!status?.companyError)
  const environmentLabel =
    status?.environment === "production" ? "Production" : "Sandbox"
  const topTipVariant = !status?.configured
    ? "warning"
    : status?.error || status?.companyError
      ? "error"
      : status?.connected
        ? "success"
        : "info"
  const topTipLabel = !status?.configured
    ? "QuickBooks setup incomplete"
    : status?.error || status?.companyError
      ? "QuickBooks needs attention"
      : status?.connected
        ? "QuickBooks connected"
        : "QuickBooks not connected"

  return (
    <div className="flex flex-col gap-y-4">
      <div className="flex flex-col gap-4 px-1 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <Heading level="h1">QuickBooks Settings</Heading>
          <Text className="text-ui-fg-subtle" size="small">
            Manage your QuickBooks connection and company details.
          </Text>
        </div>

        <div className="flex flex-wrap items-center gap-2 lg:justify-end">
          <Badge color={status?.connected ? "green" : "grey"} size="2xsmall">
            {status?.connected ? "Connected" : "Disconnected"}
          </Badge>
          {needsReconnect && (
            <Badge color="orange" size="2xsmall">
              Needs reconnect
            </Badge>
          )}
          <Button
            size="small"
            variant={
              needsReconnect || !status?.connected ? "primary" : "secondary"
            }
            onClick={handleConnect}
            isLoading={isConnecting}
            disabled={isLoading}
          >
            {needsReconnect
              ? "Reconnect"
              : status?.connected
                ? "Connect again"
                : "Connect"}
          </Button>
          <Button
            size="small"
            variant="secondary"
            onClick={handleDisconnect}
            isLoading={isDisconnecting}
            disabled={!status?.connected || isLoading}
          >
            Disconnect
          </Button>
        </div>
      </div>

      <InlineTip
        label={topTipLabel}
        variant={topTipVariant}
      >
        {!status?.configured
          ? `Missing backend configuration${status?.missingKeys?.length ? `: ${status.missingKeys.join(", ")}` : "."}`
          : status?.error || status?.companyError
            ? `${status?.companyError || status?.error}. `
            : status?.connected
              ? `${companyName} is connected. `
              : "Start the connection flow to link QuickBooks. "}
        {environmentLabel} environment.
        {status?.redirectUri ? ` Callback URL: ${status.redirectUri}` : ""}
      </InlineTip>

      <Tabs
        defaultValue="company"
        orientation="vertical"
        className="flex flex-col gap-4 md:flex-row md:items-start"
      >
        <div className="shrink-0 md:w-56">
          <Tabs.List className="flex flex-row gap-2 md:flex-col md:gap-1">
            <Tabs.Trigger
              value="sync"
              className="w-full justify-start rounded-md bg-transparent text-left"
            >
              Product Sync
            </Tabs.Trigger>
            <Tabs.Trigger
              value="company"
              className="w-full justify-start rounded-md bg-transparent text-left"
            >
              Company Info
            </Tabs.Trigger>
          </Tabs.List>
        </div>

        <Container className="flex-1 p-0">
          <div className="p-6">
            <Tabs.Content value="sync" className="m-0">
              <div className="flex flex-col gap-6">
                <SectionTitle
                  title="Product Sync"
                  subtitle="Choose which QuickBooks income account to use when creating product items."
                />

                {!status?.connected ? (
                  <Alert variant="warning">
                    <Text size="small">
                      Connect QuickBooks first to choose the product income account.
                    </Text>
                  </Alert>
                ) : (
                  <form className="flex flex-col gap-4" onSubmit={handleSaveSyncSettings}>
                    <label className="flex flex-col gap-2">
                      <Label size="small" weight="plus">
                        Income account
                      </Label>
                      <select
                        value={selectedIncomeAccountId}
                        onChange={(event) => setSelectedIncomeAccountId(event.target.value)}
                        className="h-10 rounded-md border border-ui-border-base bg-ui-bg-field px-3 text-sm"
                      >
                        <option value="">Select an income account</option>
                        {(status?.incomeAccounts || []).map((account) => (
                          <option key={account.id || account.name} value={account.id || ""}>
                            {account.fullyQualifiedName || account.name || account.id}
                          </option>
                        ))}
                      </select>
                    </label>

                    <Text size="small" className="text-ui-fg-subtle">
                      Selected: {status?.selectedIncomeAccountName || "Not set"}
                    </Text>

                    <div className="flex justify-start">
                      <Button
                        type="submit"
                        size="small"
                        isLoading={isSavingSyncSettings}
                        disabled={!selectedIncomeAccountId}
                      >
                        Save Product Sync Settings
                      </Button>
                    </div>
                  </form>
                )}
              </div>
            </Tabs.Content>

            <Tabs.Content value="company" className="m-0">
              <div className="flex flex-col gap-6">
                <div className="flex items-start justify-between gap-4">
                  <SectionTitle
                    title="Company Info"
                    subtitle="View and edit the connected QuickBooks company details."
                  />

                  <FocusModal open={isEditorOpen} onOpenChange={setIsEditorOpen}>
                    <FocusModal.Trigger asChild>
                      <Button
                        size="small"
                        variant="secondary"
                        disabled={!status?.connected}
                      >
                        Edit
                      </Button>
                    </FocusModal.Trigger>

                    <FocusModal.Content>
                      <form
                        onSubmit={handleSaveCompany}
                        className="flex h-full flex-col overflow-hidden"
                      >
                        <FocusModal.Header>
                          <div className="flex items-center justify-end gap-2">
                            <FocusModal.Close asChild>
                              <Button size="small" variant="secondary">
                                Cancel
                              </Button>
                            </FocusModal.Close>
                            <Button
                              type="submit"
                              size="small"
                              isLoading={isSavingCompany}
                            >
                              Save
                            </Button>
                          </div>
                        </FocusModal.Header>

                        <FocusModal.Body className="flex flex-1 overflow-y-auto">
                          <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-2 py-10">
                            <div>
                              <Heading level="h1">Edit Company Info</Heading>
                              <Text className="mt-1 text-ui-fg-subtle" size="small">
                                Update the company details synced from QuickBooks.
                              </Text>
                            </div>

                            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                              <Field
                                label="Company name"
                                value={companyForm.CompanyName}
                                onChange={(value) =>
                                  setCompanyForm((current) => ({
                                    ...current,
                                    CompanyName: value,
                                  }))
                                }
                              />
                              <Field
                                label="Legal name"
                                value={companyForm.LegalName}
                                onChange={(value) =>
                                  setCompanyForm((current) => ({
                                    ...current,
                                    LegalName: value,
                                  }))
                                }
                              />
                              <Field
                                label="Company email"
                                type="email"
                                value={companyForm.CompanyEmail}
                                onChange={(value) =>
                                  setCompanyForm((current) => ({
                                    ...current,
                                    CompanyEmail: value,
                                  }))
                                }
                              />
                              <Field
                                label="Primary phone"
                                value={companyForm.PrimaryPhone}
                                onChange={(value) =>
                                  setCompanyForm((current) => ({
                                    ...current,
                                    PrimaryPhone: value,
                                  }))
                                }
                              />
                              <Field
                                label="Website"
                                type="url"
                                value={companyForm.Website}
                                onChange={(value) =>
                                  setCompanyForm((current) => ({
                                    ...current,
                                    Website: value,
                                  }))
                                }
                              />
                              <Field
                                label="Customer communication email"
                                type="email"
                                value={companyForm.CustomerCommunicationEmail}
                                onChange={(value) =>
                                  setCompanyForm((current) => ({
                                    ...current,
                                    CustomerCommunicationEmail: value,
                                  }))
                                }
                              />
                            </div>

                            <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
                              <AddressEditor
                                title="Company address"
                                value={companyForm.CompanyAddr}
                                onChange={(field, value) =>
                                  updateAddressField("CompanyAddr", field, value)
                                }
                              />
                              <AddressEditor
                                title="Legal address"
                                value={companyForm.LegalAddr}
                                onChange={(field, value) =>
                                  updateAddressField("LegalAddr", field, value)
                                }
                              />
                              <AddressEditor
                                title="Customer communication address"
                                value={companyForm.CustomerCommunicationAddr}
                                onChange={(field, value) =>
                                  updateAddressField(
                                    "CustomerCommunicationAddr",
                                    field,
                                    value
                                  )
                                }
                              />
                            </div>
                          </div>
                        </FocusModal.Body>
                      </form>
                    </FocusModal.Content>
                  </FocusModal>
                </div>

                {!status?.connected ? (
                  <Alert variant="warning">
                    <Text size="small">
                      Connect QuickBooks first to load and edit company details.
                    </Text>
                  </Alert>
                ) : (
                  <div className="divide-y divide-ui-border-base">
                    <SummaryRow label="Company name" value={companyInfo?.CompanyName} />
                    <SummaryRow label="Legal name" value={companyInfo?.LegalName} />
                    <SummaryRow
                      label="Company email"
                      value={asRecord(companyInfo?.Email)?.Address}
                    />
                    <SummaryRow
                      label="Primary phone"
                      value={asRecord(companyInfo?.PrimaryPhone)?.FreeFormNumber}
                    />
                    <SummaryRow
                      label="Website"
                      value={asRecord(companyInfo?.WebAddr)?.URI}
                    />
                    <SummaryRow
                      label="Customer communication email"
                      value={
                        asRecord(companyInfo?.CustomerCommunicationEmailAddr)?.Address
                      }
                    />
                    <SummaryRow
                      label="Company address"
                      value={formatAddress(companyInfo?.CompanyAddr)}
                    />
                    <SummaryRow
                      label="Legal address"
                      value={formatAddress(companyInfo?.LegalAddr)}
                    />
                    <SummaryRow
                      label="Customer communication address"
                      value={formatAddress(companyInfo?.CustomerCommunicationAddr)}
                    />
                  </div>
                )}
              </div>
            </Tabs.Content>

          </div>
        </Container>
      </Tabs>
    </div>
  )
}

export default QuickbooksSettingsPage
