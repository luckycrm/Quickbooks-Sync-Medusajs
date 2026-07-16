import { defineRouteConfig } from "@medusajs/admin-sdk";
import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Buildings, ArrowPathMini } from "@medusajs/icons";
import {
  Alert,
  Badge,
  Button,
  Container,
  Heading,
  StatusBadge,
  Table,
  Text,
  toast,
} from "@medusajs/ui";

import { sdk } from "../../lib/client";
import {
  StatCard,
  SectionHeader,
  formatDateTime,
} from "../../components/quickbooks-ui";

type QuickbooksStatusResponse = {
  configured: boolean;
  connected: boolean;
  missingKeys?: string[];
  environment?: string;
  redirectUri?: string;
  realmId?: string;
  expiresAt?: string;
  connectedAt?: string;
  company?: Record<string, unknown> | null;
  selectedIncomeAccountId?: string | null;
  selectedIncomeAccountName?: string | null;
  companyError?: string;
  error?: string;
};

type ProductVariantSummary = {
  quickbooks_item_id: string | null;
  quickbooks_image_count: number;
};

type UnifiedProductRow = {
  id: string;
  medusa_product_id: string | null;
  title: string | null;
  status: string | null;
  availability: string[];
  variant_count: number;
  matched_variant_count: number;
  unmatched_variant_count: number;
  image_count: number;
  quickbooks_image_count: number;
  variants: ProductVariantSummary[];
};

type ProductsStatusResponse = {
  configured: boolean;
  connected: boolean;
  environment?: string;
  realmId?: string;
  missingKeys?: string[];
  quickbooks?: {
    error?: string;
  };
  summary: {
    medusa_products: number;
    quickbooks_items: number;
    matched_variants: number;
    missing_variants: number;
    quickbooks_only_items: number;
  };
  rows: UnifiedProductRow[];
};

type OrderLink = {
  id: string;
  medusa_order_id: string;
  quickbooks_sales_receipt_id: string | null;
  quickbooks_invoice_id: string | null;
  sync_type: string | null;
  last_synced_at: string | null;
};

type OrdersStatusResponse = {
  order_links: OrderLink[];
  count: number;
};

type CustomerSummary = {
  id: string | null;
  active?: boolean | null;
};

type MatchSummary = {
  email?: string | null;
  medusa_customer_id?: string | null;
  quickbooks_customer_id?: string | null;
};

type CustomersStatusResponse = {
  configured: boolean;
  connected: boolean;
  environment?: string;
  realmId?: string;
  missingKeys?: string[];
  medusa: {
    count: number;
    normalized: CustomerSummary[];
  };
  quickbooks: {
    count: number;
    normalized: CustomerSummary[];
    error?: string;
  };
  matches?: MatchSummary[];
};

type ProductSyncResponse = {
  created?: number;
  updated?: number;
  skipped?: number;
};

type OrderSyncResponse = {
  synced?: number;
  skipped?: number;
};

type CustomerSyncResponse = {
  created: number;
  updated: number;
  skipped: number;
};

const asRecord = (value: unknown) => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return null;
};

const asString = (value: unknown) => (typeof value === "string" ? value : null);

const QuickLinkCard = ({
  title,
  description,
  badge,
  onClick,
}: {
  title: string;
  description: string;
  badge?: string;
  onClick: () => void;
}) => (
  <button
    type="button"
    onClick={onClick}
    className="flex w-full flex-col items-start gap-y-2 rounded-md border border-ui-border-base bg-ui-bg-base p-4 text-left transition-colors hover:bg-ui-bg-subtle"
  >
    <div className="flex w-full items-start justify-between gap-3">
      <Text size="small" leading="compact" weight="plus">
        {title}
      </Text>
      {badge ? <Badge size="2xsmall">{badge}</Badge> : null}
    </div>
    <Text size="small" leading="compact" className="text-ui-fg-subtle">
      {description}
    </Text>
  </button>
);

type OverviewRow = {
  key: string;
  title: string;
  subtitle?: string;
  badge?: string;
  tone?: "green" | "orange" | "red" | "grey" | "blue";
};

const OverviewTable = ({
  empty,
  columnLabel,
  statusLabel,
  rows,
}: {
  empty: string;
  columnLabel: string;
  statusLabel: string;
  rows: OverviewRow[];
}) => {
  if (!rows.length) {
    return (
      <div className="px-6 py-8">
        <Text size="small" leading="compact" className="text-ui-fg-subtle">
          {empty}
        </Text>
      </div>
    );
  }

  return (
    <Table>
      <Table.Header>
        <Table.Row>
          <Table.HeaderCell>{columnLabel}</Table.HeaderCell>
          <Table.HeaderCell className="text-right">
            {statusLabel}
          </Table.HeaderCell>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {rows.map((row) => (
          <Table.Row key={row.key}>
            <Table.Cell>
              <div className="flex min-w-0 flex-col py-1">
                <Text
                  size="small"
                  leading="compact"
                  weight="plus"
                  className="truncate"
                >
                  {row.title}
                </Text>
                {row.subtitle ? (
                  <Text
                    size="xsmall"
                    leading="compact"
                    className="truncate text-ui-fg-subtle"
                  >
                    {row.subtitle}
                  </Text>
                ) : null}
              </div>
            </Table.Cell>
            <Table.Cell className="text-right">
              {row.badge ? (
                <Badge size="2xsmall" color={row.tone || "grey"}>
                  {row.badge}
                </Badge>
              ) : null}
            </Table.Cell>
          </Table.Row>
        ))}
      </Table.Body>
    </Table>
  );
};

const QuickbooksPage = () => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const dashboardQuery = useQuery({
    queryKey: ["quickbooks-dashboard"],
    queryFn: async () => {
      const [status, products, orders, customers] = await Promise.all([
        sdk.client.fetch<QuickbooksStatusResponse>("/admin/quickbooks/status"),
        sdk.client.fetch<ProductsStatusResponse>(
          "/admin/quickbooks/products/status",
          {
            query: { limit: 5 },
          },
        ),
        sdk.client.fetch<OrdersStatusResponse>(
          "/admin/quickbooks/orders/status",
          {
            query: { page: { limit: 5, offset: 0 } },
          },
        ),
        sdk.client.fetch<CustomersStatusResponse>(
          "/admin/quickbooks/customers/status",
        ),
      ]);

      return {
        status,
        products,
        orders,
        customers,
      };
    },
  });

  const invalidateDashboard = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["quickbooks-dashboard"] }),
      queryClient.invalidateQueries({ queryKey: ["quickbooks-products"] }),
      queryClient.invalidateQueries({ queryKey: ["quickbooks-orders"] }),
      queryClient.invalidateQueries({ queryKey: ["quickbooks-customers"] }),
    ]);
  };

  const syncProductsMutation = useMutation({
    mutationFn: async () =>
      sdk.client.fetch<ProductSyncResponse>("/admin/quickbooks/products/sync", {
        method: "POST",
        body: { sync_all: true },
      }),
    onSuccess: async (result) => {
      toast.success(
        `Products synced. Created ${result.created || 0}, updated ${result.updated || 0}.`,
      );
      await invalidateDashboard();
    },
    onError: (error: any) => {
      toast.error(error?.message || "Unable to sync products");
    },
  });

  const syncOrdersMutation = useMutation({
    mutationFn: async () =>
      sdk.client.fetch<OrderSyncResponse>("/admin/quickbooks/orders/sync", {
        method: "POST",
        body: { sync_all: true },
      }),
    onSuccess: async (result) => {
      toast.success(
        `Orders synced. Synced ${result.synced || 0}, skipped ${result.skipped || 0}.`,
      );
      await invalidateDashboard();
    },
    onError: (error: any) => {
      toast.error(error?.message || "Unable to sync orders");
    },
  });

  const syncCustomersMutation = useMutation({
    mutationFn: async () =>
      sdk.client.fetch<CustomerSyncResponse>(
        "/admin/quickbooks/customers/sync",
        {
          method: "POST",
          body: { direction: "medusa_to_quickbooks" },
        },
      ),
    onSuccess: async (result) => {
      toast.success(
        `Customers synced. Created ${result.created}, updated ${result.updated}, skipped ${result.skipped}.`,
      );
      await invalidateDashboard();
    },
    onError: (error: any) => {
      toast.error(error?.message || "Unable to sync customers");
    },
  });

  const data = dashboardQuery.data;

  const companyName = useMemo(() => {
    const company = asRecord(data?.status.company);

    return (
      asString(company?.CompanyName) ||
      asString(company?.LegalName) ||
      "QuickBooks company"
    );
  }, [data?.status.company]);

  const unmatchedProducts = useMemo<OverviewRow[]>(() => {
    return (data?.products.rows || [])
      .filter(
        (row) =>
          row.unmatched_variant_count > 0 || row.quickbooks_image_count === 0,
      )
      .slice(0, 5)
      .map((row) => ({
        key: row.id,
        title: row.title || "Untitled product",
        subtitle: `${row.matched_variant_count}/${row.variant_count} variants matched • ${row.quickbooks_image_count} QuickBooks images`,
        badge:
          row.unmatched_variant_count > 0
            ? `${row.unmatched_variant_count} missing`
            : "Images",
        tone:
          row.unmatched_variant_count > 0
            ? ("orange" as const)
            : ("grey" as const),
      }));
  }, [data?.products.rows]);

  const recentOrders = useMemo<OverviewRow[]>(() => {
    return (data?.orders.order_links || []).slice(0, 5).map((order) => ({
      key: order.id,
      title: order.medusa_order_id,
      subtitle: `QuickBooks ${order.quickbooks_sales_receipt_id || order.quickbooks_invoice_id || "pending"} • ${formatDateTime(order.last_synced_at)}`,
      badge: order.sync_type || "pending",
      tone:
        order.quickbooks_sales_receipt_id || order.quickbooks_invoice_id
          ? ("green" as const)
          : ("grey" as const),
    }));
  }, [data?.orders.order_links]);

  const customerMatches = useMemo<OverviewRow[]>(() => {
    return (data?.customers.matches || []).slice(0, 5).map((match) => ({
      key: `${match.medusa_customer_id}-${match.quickbooks_customer_id}-${match.email}`,
      title: match.email || "Unknown email",
      subtitle: `Medusa ${match.medusa_customer_id || "-"} • QuickBooks ${match.quickbooks_customer_id || "-"}`,
      badge: "Matched",
      tone: "green" as const,
    }));
  }, [data?.customers.matches]);

  const inactiveQuickbooksCustomers = useMemo(() => {
    return (
      data?.customers.quickbooks.normalized.filter(
        (customer) => customer.active === false,
      ).length || 0
    );
  }, [data?.customers.quickbooks.normalized]);

  const missingConfigKeys =
    data?.status.missingKeys ||
    data?.products.missingKeys ||
    data?.customers.missingKeys ||
    [];

  return (
    <div className="flex flex-col gap-y-4">
      <Container className="p-0 overflow-hidden">
        <div className="flex flex-col gap-y-4 px-6 py-4">
          <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
            <div className="flex flex-col gap-y-1">
              <Heading level="h1">QuickBooks</Heading>
              <Text
                size="small"
                leading="compact"
                className="text-ui-fg-subtle"
              >
                Manage the QuickBooks plugin from one place: connection health,
                sync coverage, and the most important actions for products,
                orders, and customers.
              </Text>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge color={data?.status.connected ? "green" : "grey"}>
                {data?.status.connected ? "Connected" : "Disconnected"}
              </StatusBadge>
              <Button
                size="small"
                variant="secondary"
                onClick={() => void invalidateDashboard()}
                isLoading={dashboardQuery.isFetching}
              >
                <ArrowPathMini className="size-4" />
              </Button>
              <Button
                size="small"
                variant="secondary"
                onClick={() => navigate("/quickbooks/settings")}
              >
                Open Settings
              </Button>
            </div>
          </div>

          {dashboardQuery.isError ? (
            <Alert variant="error">
              {(dashboardQuery.error as Error)?.message ||
                "Unable to load the QuickBooks dashboard."}
            </Alert>
          ) : null}

          {!data?.status.configured && missingConfigKeys.length ? (
            <Alert variant="warning">
              QuickBooks is not fully configured. Missing keys:{" "}
              {missingConfigKeys.join(", ")}
            </Alert>
          ) : null}

          {data?.status.error ? (
            <Alert variant="warning">{data.status.error}</Alert>
          ) : null}

          {data?.status.companyError ? (
            <Alert variant="warning">{data.status.companyError}</Alert>
          ) : null}

          {data?.products.quickbooks?.error ? (
            <Alert variant="warning">{data.products.quickbooks.error}</Alert>
          ) : null}

          {data?.customers.quickbooks.error ? (
            <Alert variant="warning">{data.customers.quickbooks.error}</Alert>
          ) : null}

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
            <StatCard
              label="Connection"
              value={data?.status.connected ? "Ready" : "Needs attention"}
              hint={`${data?.status.environment || "-"} • Realm ${data?.status.realmId || "-"}`}
            />
            <StatCard
              label="Products"
              value={data?.products.summary.matched_variants ?? 0}
              hint={`${data?.products.summary.missing_variants ?? 0} missing variant links`}
            />
            <StatCard
              label="Orders"
              value={data?.orders.count ?? 0}
              hint="Synced order link records"
            />
            <StatCard
              label="Customers"
              value={data?.customers.matches?.length ?? 0}
              hint={`${inactiveQuickbooksCustomers} inactive in QuickBooks`}
            />
          </div>
        </div>
      </Container>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.3fr_0.9fr]">
        <Container className="p-0 overflow-hidden">
          <div className="flex flex-col gap-y-4 px-6 py-4">
            <SectionHeader
              title="Quick Actions"
              description="Run the plugin's most important sync operations or jump straight into the detailed pages."
            />

            <div className="flex flex-wrap gap-2">
              <Button
                size="small"
                variant="primary"
                onClick={() => syncProductsMutation.mutate()}
                isLoading={syncProductsMutation.isPending}
                disabled={!data?.status.connected}
              >
                Sync Products
              </Button>
              <Button
                size="small"
                variant="primary"
                onClick={() => syncOrdersMutation.mutate()}
                isLoading={syncOrdersMutation.isPending}
                disabled={!data?.status.connected}
              >
                Sync Orders
              </Button>
              <Button
                size="small"
                variant="primary"
                onClick={() => syncCustomersMutation.mutate()}
                isLoading={syncCustomersMutation.isPending}
                disabled={!data?.status.connected}
              >
                Sync Customers
              </Button>
            </div>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <QuickLinkCard
                title="Products"
                description="Inspect variant coverage, QuickBooks image counts, and sync individual catalog items."
                badge={`${data?.products.summary.missing_variants ?? 0} missing`}
                onClick={() => navigate("/quickbooks/products")}
              />
              <QuickLinkCard
                title="Orders"
                description="Review order link records and rerun outbound order sync into QuickBooks receipts."
                badge={`${data?.orders.count ?? 0} records`}
                onClick={() => navigate("/quickbooks/orders")}
              />
              <QuickLinkCard
                title="Customers"
                description="Compare Medusa and QuickBooks customers, email matches, and run customer sync."
                badge={`${data?.customers.matches?.length ?? 0} matched`}
                onClick={() => navigate("/quickbooks/customers")}
              />
              <QuickLinkCard
                title="Settings"
                description="Connect the app, verify the company, and control the selected income account."
                badge={data?.status.selectedIncomeAccountName || "Configure"}
                onClick={() => navigate("/quickbooks/settings")}
              />
            </div>
          </div>
        </Container>

        <Container className="p-0 overflow-hidden">
          <div className="flex flex-col gap-y-4 px-6 py-4">
            <SectionHeader
              title="Connection Snapshot"
              description="Current backend connection details for this QuickBooks workspace."
            />

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <StatCard label="Company" value={companyName} />
              <StatCard
                label="Income Account"
                value={data?.status.selectedIncomeAccountName || "-"}
              />
              <StatCard
                label="Connected At"
                value={formatDateTime(data?.status.connectedAt)}
              />
              <StatCard
                label="Token Expires"
                value={formatDateTime(data?.status.expiresAt)}
              />
            </div>
          </div>
        </Container>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Container className="p-0 overflow-hidden">
          <div className="px-6 py-4">
            <SectionHeader
              title="Product Coverage"
              description="Items that still need attention before the catalog is fully aligned."
            />
          </div>
          <OverviewTable
            empty="No product issues detected in the current sample."
            columnLabel="Product"
            statusLabel="Status"
            rows={unmatchedProducts}
          />
        </Container>

        <Container className="p-0 overflow-hidden">
          <div className="px-6 py-4">
            <SectionHeader
              title="Recent Orders"
              description="Latest linked orders that have been pushed toward QuickBooks."
            />
          </div>
          <OverviewTable
            empty="No synced order links yet."
            columnLabel="Order"
            statusLabel="Sync"
            rows={recentOrders}
          />
        </Container>

        <Container className="p-0 overflow-hidden">
          <div className="px-6 py-4">
            <SectionHeader
              title="Customer Matches"
              description="Email-based customer links currently detected between both systems."
            />
          </div>
          <OverviewTable
            empty="No customer matches found yet."
            columnLabel="Customer"
            statusLabel="Link"
            rows={customerMatches}
          />
        </Container>
      </div>
    </div>
  );
};

export const config = defineRouteConfig({
  label: "QuickBooks",
  icon: Buildings,
});

export const handle = {
  breadcrumb: () => "QuickBooks",
};

export default QuickbooksPage;
