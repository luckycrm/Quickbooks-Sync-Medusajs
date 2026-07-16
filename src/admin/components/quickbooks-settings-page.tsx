import type { FormEvent } from "react";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Button,
  Container,
  FocusModal,
  Heading,
  Input,
  InlineTip,
  Label,
  Select,
  StatusBadge,
  Tabs,
  Text,
  toast,
  usePrompt,
} from "@medusajs/ui";
import { useSearchParams } from "react-router-dom";

import { sdk } from "../lib/client";
import { SectionHeader } from "./quickbooks-ui";

type QuickbooksStatus = {
  configured: boolean;
  connected: boolean;
  missingKeys?: string[];
  environment?: string;
  redirectUri?: string;
  realmId?: string;
  expiresAt?: string;
  connectedAt?: string;
  company?: Record<string, unknown> | null;
  incomeAccounts?: Array<{
    id?: string | null;
    name?: string | null;
    fullyQualifiedName?: string | null;
    accountType?: string | null;
    accountSubType?: string | null;
  }>;
  selectedIncomeAccountId?: string | null;
  selectedIncomeAccountName?: string | null;
  selectedPriceCurrency?: string | null;
  availableCurrencies?: Array<{ code: string; isDefault: boolean }>;
  selectedOrderTaxTreatment?: string | null;
  selectedOrderTaxCodeId?: string | null;
  selectedOrderTaxCodeName?: string | null;
  taxCodes?: Array<{
    id?: string | null;
    name?: string | null;
    description?: string | null;
  }>;
  companyError?: string;
  error?: string;
};

const ORDER_TAX_TREATMENTS = [
  { value: "out_of_scope", label: "Out of scope" },
  { value: "inclusive", label: "Inclusive of tax" },
  { value: "exclusive", label: "Exclusive of tax" },
];

type CompanyAddressForm = {
  Line1: string;
  City: string;
  CountrySubDivisionCode: string;
  PostalCode: string;
  Country: string;
};

type CompanyFormState = {
  CompanyName: string;
  LegalName: string;
  CompanyEmail: string;
  PrimaryPhone: string;
  Website: string;
  CustomerCommunicationEmail: string;
  CompanyAddr: CompanyAddressForm;
  LegalAddr: CompanyAddressForm;
  CustomerCommunicationAddr: CompanyAddressForm;
};

const asRecord = (value: unknown) => {
  if (value && typeof value === "object") {
    return value as Record<string, unknown>;
  }

  return null;
};

const formatValue = (value: unknown) => {
  if (value === null || value === undefined || value === "") {
    return "-";
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return JSON.stringify(value);
};

const formatAddress = (value: unknown) => {
  const address = asRecord(value);

  if (!address) {
    return "-";
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
    .map((part) => String(part));

  return parts.length ? parts.join(", ") : "-";
};

const addressToForm = (value: unknown): CompanyAddressForm => {
  const address = asRecord(value);

  return {
    Line1: String(address?.Line1 || ""),
    City: String(address?.City || ""),
    CountrySubDivisionCode: String(address?.CountrySubDivisionCode || ""),
    PostalCode: String(address?.PostalCode || ""),
    Country: String(address?.Country || ""),
  };
};

const companyToForm = (
  company: Record<string, unknown> | null,
): CompanyFormState => ({
  CompanyName: String(company?.CompanyName || ""),
  LegalName: String(company?.LegalName || ""),
  CompanyEmail: String(asRecord(company?.Email)?.Address || ""),
  PrimaryPhone: String(asRecord(company?.PrimaryPhone)?.FreeFormNumber || ""),
  Website: String(asRecord(company?.WebAddr)?.URI || ""),
  CustomerCommunicationEmail: String(
    asRecord(company?.CustomerCommunicationEmailAddr)?.Address || "",
  ),
  CompanyAddr: addressToForm(company?.CompanyAddr),
  LegalAddr: addressToForm(company?.LegalAddr),
  CustomerCommunicationAddr: addressToForm(company?.CustomerCommunicationAddr),
});

const Field = ({
  label,
  value,
  onChange,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
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
);

const SummaryRow = ({ label, value }: { label: string; value: unknown }) => (
  <div className="grid grid-cols-1 gap-1 py-4 md:grid-cols-[220px_1fr] md:gap-4">
    <Text
      size="small"
      leading="compact"
      weight="plus"
      className="text-ui-fg-subtle"
    >
      {label}
    </Text>
    <Text size="small" leading="compact">
      {formatValue(value)}
    </Text>
  </div>
);

const AddressEditor = ({
  title,
  value,
  onChange,
}: {
  title: string;
  value: CompanyAddressForm;
  onChange: (field: keyof CompanyAddressForm, value: string) => void;
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
);

const QuickbooksSettingsPage = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const prompt = usePrompt();
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [selectedIncomeAccountId, setSelectedIncomeAccountId] = useState("");
  const [selectedPriceCurrency, setSelectedPriceCurrency] = useState("");
  const [selectedOrderTaxTreatment, setSelectedOrderTaxTreatment] =
    useState("");
  const [selectedOrderTaxCodeId, setSelectedOrderTaxCodeId] = useState("");
  const [companyForm, setCompanyForm] = useState<CompanyFormState>(() =>
    companyToForm(null),
  );

  const statusQuery = useQuery({
    queryKey: ["quickbooks-status"],
    queryFn: () =>
      sdk.client.fetch<QuickbooksStatus>("/admin/quickbooks/status"),
  });

  const status = statusQuery.data;

  const refreshStatus = () =>
    queryClient.invalidateQueries({ queryKey: ["quickbooks-status"] });

  const refreshAllQuickbooksData = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["quickbooks-status"] }),
      queryClient.invalidateQueries({ queryKey: ["quickbooks-dashboard"] }),
      queryClient.invalidateQueries({ queryKey: ["quickbooks-products"] }),
      queryClient.invalidateQueries({ queryKey: ["quickbooks-orders"] }),
      queryClient.invalidateQueries({ queryKey: ["quickbooks-customers"] }),
    ]);

  const resetMutation = useMutation({
    mutationFn: (type: "customers" | "orders" | "all") =>
      sdk.client.fetch<{ success: boolean; message: string }>(
        "/admin/quickbooks/reset",
        {
          method: "POST",
          body: { type },
        },
      ),
    onSuccess: async (result) => {
      toast.success(result.message || "QuickBooks data cleared.");
      await refreshAllQuickbooksData();
    },
    onError: (e: any) => {
      toast.error(e?.message || "Unable to clear QuickBooks data.");
    },
  });

  const handleClear = async (input: {
    type: "customers" | "orders" | "all";
    title: string;
    description: string;
  }) => {
    const confirmed = await prompt({
      title: input.title,
      description: input.description,
      confirmText: "Clear",
      cancelText: "Cancel",
    });

    if (confirmed) {
      resetMutation.mutate(input.type);
    }
  };

  useEffect(() => {
    const state = searchParams.get("quickbooks");
    const errorMessage = searchParams.get("message");

    if (!state) {
      return;
    }

    if (state === "connected") {
      toast.success("QuickBooks connected successfully.");
    } else if (state === "error") {
      toast.error(errorMessage || "QuickBooks connection failed.");
    }

    const next = new URLSearchParams(searchParams);
    next.delete("quickbooks");
    next.delete("message");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    setCompanyForm(companyToForm(asRecord(status?.company)));
  }, [status?.company]);

  useEffect(() => {
    setSelectedIncomeAccountId(status?.selectedIncomeAccountId || "");
  }, [status?.selectedIncomeAccountId]);

  useEffect(() => {
    setSelectedPriceCurrency(status?.selectedPriceCurrency || "");
  }, [status?.selectedPriceCurrency]);

  useEffect(() => {
    setSelectedOrderTaxTreatment(status?.selectedOrderTaxTreatment || "");
  }, [status?.selectedOrderTaxTreatment]);

  useEffect(() => {
    setSelectedOrderTaxCodeId(status?.selectedOrderTaxCodeId || "");
  }, [status?.selectedOrderTaxCodeId]);

  const connectMutation = useMutation({
    mutationFn: () =>
      sdk.client.fetch<{ url?: string; missingKeys?: string[] }>(
        "/admin/quickbooks/connect",
      ),
    onSuccess: (result) => {
      if (!result.url) {
        toast.error(
          result.missingKeys?.length
            ? `Missing backend configuration: ${result.missingKeys.join(", ")}`
            : "Unable to start the QuickBooks connection flow.",
        );
        return;
      }

      window.location.href = result.url;
    },
    onError: (e: any) => {
      toast.error(e?.message || "Unable to start QuickBooks OAuth.");
    },
  });

  const disconnectMutation = useMutation({
    mutationFn: () =>
      sdk.client.fetch("/admin/quickbooks/disconnect", {
        method: "POST",
      }),
    onSuccess: async () => {
      toast.success("QuickBooks disconnected.");
      setIsEditorOpen(false);
      await refreshStatus();
    },
    onError: (e: any) => {
      toast.error(e?.message || "Unable to disconnect QuickBooks.");
    },
  });

  const saveCompanyMutation = useMutation({
    mutationFn: (form: CompanyFormState) =>
      sdk.client.fetch<{ message?: string }>("/admin/quickbooks/company", {
        method: "POST",
        body: form,
      }),
    onSuccess: async () => {
      toast.success("QuickBooks company info updated.");
      setIsEditorOpen(false);
      await refreshStatus();
    },
    onError: (e: any) => {
      toast.error(e?.message || "Unable to update QuickBooks company info.");
    },
  });

  const saveSyncSettingsMutation = useMutation({
    mutationFn: (input: {
      incomeAccountId: string;
      priceCurrency: string;
      orderTaxTreatment: string;
      orderTaxCodeId: string;
    }) =>
      sdk.client.fetch<{ message?: string }>("/admin/quickbooks/settings", {
        method: "POST",
        body: {
          ...(input.incomeAccountId
            ? { quickbooks_product_income_account_id: input.incomeAccountId }
            : {}),
          ...(input.priceCurrency
            ? { quickbooks_price_currency: input.priceCurrency }
            : {}),
          ...(input.orderTaxTreatment
            ? { quickbooks_order_tax_treatment: input.orderTaxTreatment }
            : {}),
          ...(input.orderTaxCodeId
            ? { quickbooks_order_tax_code_id: input.orderTaxCodeId }
            : {}),
        },
      }),
    onSuccess: async () => {
      toast.success("QuickBooks product sync settings updated.");
      await refreshStatus();
    },
    onError: (e: any) => {
      toast.error(e?.message || "Unable to update QuickBooks sync settings.");
    },
  });

  const updateAddressField = (
    key: keyof Pick<
      CompanyFormState,
      "CompanyAddr" | "LegalAddr" | "CustomerCommunicationAddr"
    >,
    field: keyof CompanyAddressForm,
    value: string,
  ) => {
    setCompanyForm((current) => ({
      ...current,
      [key]: {
        ...current[key],
        [field]: value,
      },
    }));
  };

  const handleSaveCompany = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    saveCompanyMutation.mutate(companyForm);
  };

  const handleSaveSyncSettings = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    saveSyncSettingsMutation.mutate({
      incomeAccountId: selectedIncomeAccountId,
      priceCurrency: selectedPriceCurrency,
      orderTaxTreatment: selectedOrderTaxTreatment,
      orderTaxCodeId:
        selectedOrderTaxTreatment === "exclusive" ? selectedOrderTaxCodeId : "",
    });
  };

  const companyInfo = asRecord(status?.company);
  const companyName = String(
    companyInfo?.CompanyName || companyInfo?.LegalName || "QuickBooks company",
  );
  const needsReconnect =
    !!status?.error || (!!status?.connected && !!status?.companyError);
  const environmentLabel =
    status?.environment === "production" ? "Production" : "Sandbox";
  const topTipVariant = !status?.configured
    ? "warning"
    : status?.error || status?.companyError
      ? "error"
      : status?.connected
        ? "success"
        : "info";
  const topTipLabel = !status?.configured
    ? "QuickBooks setup incomplete"
    : status?.error || status?.companyError
      ? "QuickBooks needs attention"
      : status?.connected
        ? "QuickBooks connected"
        : "QuickBooks not connected";

  const incomeAccounts = useMemo(
    () =>
      (status?.incomeAccounts || []).filter(
        (account) => account.id || account.name,
      ),
    [status?.incomeAccounts],
  );

  return (
    <div className="flex flex-col gap-y-4">
      <Container className="p-0 overflow-hidden">
        <div className="flex flex-col gap-4 px-6 py-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex flex-col gap-y-1">
            <Heading level="h1">QuickBooks Settings</Heading>
            <Text size="small" leading="compact" className="text-ui-fg-subtle">
              Manage your QuickBooks connection and company details.
            </Text>
          </div>

          <div className="flex flex-wrap items-center gap-2 lg:justify-end">
            <StatusBadge color={status?.connected ? "green" : "grey"}>
              {status?.connected ? "Connected" : "Disconnected"}
            </StatusBadge>
            {needsReconnect ? (
              <StatusBadge color="orange">Needs reconnect</StatusBadge>
            ) : null}
            <Button
              size="small"
              variant={
                needsReconnect || !status?.connected ? "primary" : "secondary"
              }
              onClick={() => connectMutation.mutate()}
              isLoading={connectMutation.isPending}
              disabled={statusQuery.isLoading}
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
              onClick={() => disconnectMutation.mutate()}
              isLoading={disconnectMutation.isPending}
              disabled={!status?.connected || statusQuery.isLoading}
            >
              Disconnect
            </Button>
          </div>
        </div>
      </Container>

      {statusQuery.isError ? (
        <Alert variant="error">
          {(statusQuery.error as Error)?.message ||
            "Unable to load QuickBooks status."}
        </Alert>
      ) : null}

      <InlineTip label={topTipLabel} variant={topTipVariant}>
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
              Sync Settings
            </Tabs.Trigger>
            <Tabs.Trigger
              value="company"
              className="w-full justify-start rounded-md bg-transparent text-left"
            >
              Company Info
            </Tabs.Trigger>
            <Tabs.Trigger
              value="data"
              className="w-full justify-start rounded-md bg-transparent text-left"
            >
              Data Management
            </Tabs.Trigger>
          </Tabs.List>
        </div>

        <Container className="flex-1 p-0 overflow-hidden">
          <div className="px-6 py-4">
            <Tabs.Content value="sync" className="m-0">
              <div className="flex flex-col gap-6">
                <SectionHeader
                  title="Product Sync"
                  description="Choose which QuickBooks income account to use when creating product items."
                />

                {!status?.connected ? (
                  <Alert variant="warning">
                    Connect QuickBooks first to choose the product income
                    account.
                  </Alert>
                ) : (
                  <form
                    className="flex flex-col gap-4"
                    onSubmit={handleSaveSyncSettings}
                  >
                    <div className="flex max-w-md flex-col gap-2">
                      <Label size="small" weight="plus">
                        Income account
                      </Label>
                      <Select
                        value={selectedIncomeAccountId}
                        onValueChange={setSelectedIncomeAccountId}
                      >
                        <Select.Trigger>
                          <Select.Value placeholder="Select an income account" />
                        </Select.Trigger>
                        <Select.Content>
                          {incomeAccounts.map((account) => (
                            <Select.Item
                              key={account.id || account.name || ""}
                              value={account.id || ""}
                            >
                              {account.fullyQualifiedName ||
                                account.name ||
                                account.id}
                            </Select.Item>
                          ))}
                        </Select.Content>
                      </Select>
                      <Text
                        size="xsmall"
                        leading="compact"
                        className="text-ui-fg-subtle"
                      >
                        Currently selected:{" "}
                        {status?.selectedIncomeAccountName || "Not set"}
                      </Text>
                    </div>

                    <div className="flex max-w-md flex-col gap-2">
                      <Label size="small" weight="plus">
                        Price currency
                      </Label>
                      <Select
                        value={selectedPriceCurrency}
                        onValueChange={setSelectedPriceCurrency}
                      >
                        <Select.Trigger>
                          <Select.Value placeholder="Select a currency" />
                        </Select.Trigger>
                        <Select.Content>
                          {(status?.availableCurrencies || []).map(
                            (currency) => (
                              <Select.Item
                                key={currency.code}
                                value={currency.code}
                              >
                                {currency.code.toUpperCase()}
                                {currency.isDefault ? " (store default)" : ""}
                              </Select.Item>
                            ),
                          )}
                        </Select.Content>
                      </Select>
                      <Text
                        size="xsmall"
                        leading="compact"
                        className="text-ui-fg-subtle"
                      >
                        Variant prices in this currency are sent to QuickBooks
                        as the item sales price. Currently:{" "}
                        {status?.selectedPriceCurrency?.toUpperCase() ||
                          "USD (default)"}
                      </Text>
                    </div>

                    <div className="border-t border-ui-border-base pt-4">
                      <SectionHeader
                        title="Order Sync"
                        description="Control how order amounts and taxes are sent to QuickBooks."
                      />
                    </div>

                    <div className="flex max-w-md flex-col gap-2">
                      <Label size="small" weight="plus">
                        Order amounts are
                      </Label>
                      <Select
                        value={selectedOrderTaxTreatment}
                        onValueChange={setSelectedOrderTaxTreatment}
                      >
                        <Select.Trigger>
                          <Select.Value placeholder="Select tax treatment" />
                        </Select.Trigger>
                        <Select.Content>
                          {ORDER_TAX_TREATMENTS.map((treatment) => (
                            <Select.Item
                              key={treatment.value}
                              value={treatment.value}
                            >
                              {treatment.label}
                            </Select.Item>
                          ))}
                        </Select.Content>
                      </Select>
                      <Text
                        size="xsmall"
                        leading="compact"
                        className="text-ui-fg-subtle"
                      >
                        Out of scope: no tax. Inclusive: amounts already contain
                        tax. Exclusive: QuickBooks adds tax on top using the
                        sales tax code below.
                      </Text>
                    </div>

                    {selectedOrderTaxTreatment === "exclusive" ? (
                      <div className="flex max-w-md flex-col gap-2">
                        <Label size="small" weight="plus">
                          Sales tax code
                        </Label>
                        <Select
                          value={selectedOrderTaxCodeId}
                          onValueChange={setSelectedOrderTaxCodeId}
                        >
                          <Select.Trigger>
                            <Select.Value placeholder="Select a sales tax code" />
                          </Select.Trigger>
                          <Select.Content>
                            {(status?.taxCodes || [])
                              .filter((code) => code.id)
                              .map((code) => (
                                <Select.Item
                                  key={code.id || ""}
                                  value={code.id || ""}
                                >
                                  {code.name || code.id}
                                  {code.description
                                    ? ` — ${code.description}`
                                    : ""}
                                </Select.Item>
                              ))}
                          </Select.Content>
                        </Select>
                        <Text
                          size="xsmall"
                          leading="compact"
                          className="text-ui-fg-subtle"
                        >
                          Applied to every invoice line item. Currently:{" "}
                          {status?.selectedOrderTaxCodeName || "Not set"}
                        </Text>
                      </div>
                    ) : null}

                    <div className="flex justify-start">
                      <Button
                        type="submit"
                        size="small"
                        isLoading={saveSyncSettingsMutation.isPending}
                        disabled={
                          !selectedIncomeAccountId &&
                          !selectedPriceCurrency &&
                          !selectedOrderTaxTreatment
                        }
                      >
                        Save Sync Settings
                      </Button>
                    </div>
                  </form>
                )}
              </div>
            </Tabs.Content>

            <Tabs.Content value="company" className="m-0">
              <div className="flex flex-col gap-6">
                <div className="flex items-start justify-between gap-4">
                  <SectionHeader
                    title="Company Info"
                    description="View and edit the connected QuickBooks company details."
                  />

                  <FocusModal
                    open={isEditorOpen}
                    onOpenChange={setIsEditorOpen}
                  >
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
                              isLoading={saveCompanyMutation.isPending}
                            >
                              Save
                            </Button>
                          </div>
                        </FocusModal.Header>

                        <FocusModal.Body className="flex flex-1 overflow-y-auto">
                          <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-2 py-10">
                            <div>
                              <Heading level="h1">Edit Company Info</Heading>
                              <Text
                                size="small"
                                leading="compact"
                                className="mt-1 text-ui-fg-subtle"
                              >
                                Update the company details synced from
                                QuickBooks.
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
                                  updateAddressField(
                                    "CompanyAddr",
                                    field,
                                    value,
                                  )
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
                                    value,
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
                    Connect QuickBooks first to load and edit company details.
                  </Alert>
                ) : (
                  <div className="divide-y divide-ui-border-base">
                    <SummaryRow
                      label="Company name"
                      value={companyInfo?.CompanyName}
                    />
                    <SummaryRow
                      label="Legal name"
                      value={companyInfo?.LegalName}
                    />
                    <SummaryRow
                      label="Company email"
                      value={asRecord(companyInfo?.Email)?.Address}
                    />
                    <SummaryRow
                      label="Primary phone"
                      value={
                        asRecord(companyInfo?.PrimaryPhone)?.FreeFormNumber
                      }
                    />
                    <SummaryRow
                      label="Website"
                      value={asRecord(companyInfo?.WebAddr)?.URI}
                    />
                    <SummaryRow
                      label="Customer communication email"
                      value={
                        asRecord(companyInfo?.CustomerCommunicationEmailAddr)
                          ?.Address
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
                      value={formatAddress(
                        companyInfo?.CustomerCommunicationAddr,
                      )}
                    />
                  </div>
                )}
              </div>
            </Tabs.Content>

            <Tabs.Content value="data" className="m-0">
              <div className="flex flex-col gap-6">
                <SectionHeader
                  title="Data Management"
                  description="Clear the QuickBooks sync data stored in Medusa. Records inside QuickBooks are never deleted."
                />

                <div className="flex flex-col divide-y divide-ui-border-base rounded-md border border-ui-border-base">
                  <div className="flex flex-col gap-3 p-4 md:flex-row md:items-center md:justify-between">
                    <div className="flex flex-col gap-y-1">
                      <Text size="small" leading="compact" weight="plus">
                        Customer links
                      </Text>
                      <Text
                        size="small"
                        leading="compact"
                        className="text-ui-fg-subtle"
                      >
                        Mappings between Medusa customers and QuickBooks
                        customers.
                      </Text>
                    </div>
                    <Button
                      size="small"
                      variant="secondary"
                      isLoading={resetMutation.isPending}
                      onClick={() =>
                        void handleClear({
                          type: "customers",
                          title: "Clear customer links?",
                          description:
                            "All customer sync mappings stored in Medusa will be removed. The next sync re-creates them.",
                        })
                      }
                    >
                      Clear
                    </Button>
                  </div>

                  <div className="flex flex-col gap-3 p-4 md:flex-row md:items-center md:justify-between">
                    <div className="flex flex-col gap-y-1">
                      <Text size="small" leading="compact" weight="plus">
                        Order links
                      </Text>
                      <Text
                        size="small"
                        leading="compact"
                        className="text-ui-fg-subtle"
                      >
                        Mappings between Medusa orders and QuickBooks invoices
                        or sales receipts.
                      </Text>
                    </div>
                    <Button
                      size="small"
                      variant="secondary"
                      isLoading={resetMutation.isPending}
                      onClick={() =>
                        void handleClear({
                          type: "orders",
                          title: "Clear order links?",
                          description:
                            "All order sync mappings stored in Medusa will be removed. Re-syncing orders creates new documents in QuickBooks.",
                        })
                      }
                    >
                      Clear
                    </Button>
                  </div>

                  <div className="flex flex-col gap-3 p-4 md:flex-row md:items-center md:justify-between">
                    <div className="flex flex-col gap-y-1">
                      <Text size="small" leading="compact" weight="plus">
                        Product links
                      </Text>
                      <Text
                        size="small"
                        leading="compact"
                        className="text-ui-fg-subtle"
                      >
                        Products are matched to QuickBooks items by SKU — no
                        local sync data is stored, so there is nothing to clear.
                      </Text>
                    </div>
                    <Button size="small" variant="secondary" disabled>
                      Nothing to clear
                    </Button>
                  </div>
                </div>

                <div className="flex flex-col gap-3 rounded-md border border-ui-border-error bg-ui-bg-base p-4 md:flex-row md:items-center md:justify-between">
                  <div className="flex flex-col gap-y-1">
                    <Text size="small" leading="compact" weight="plus">
                      Clear everything
                    </Text>
                    <Text
                      size="small"
                      leading="compact"
                      className="text-ui-fg-subtle"
                    >
                      Removes all customer and order links and disconnects the
                      QuickBooks connection. You will need to reconnect
                      afterwards.
                    </Text>
                  </div>
                  <Button
                    size="small"
                    variant="danger"
                    isLoading={resetMutation.isPending}
                    onClick={() =>
                      void handleClear({
                        type: "all",
                        title: "Clear all QuickBooks data?",
                        description:
                          "All customer and order links will be removed and QuickBooks will be disconnected. Records in QuickBooks are not deleted. This cannot be undone.",
                      })
                    }
                  >
                    Clear All & Disconnect
                  </Button>
                </div>
              </div>
            </Tabs.Content>
          </div>
        </Container>
      </Tabs>
    </div>
  );
};

export default QuickbooksSettingsPage;
