import { defineRouteConfig } from "@medusajs/admin-sdk";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Button,
  Container,
  DataTable,
  DataTablePaginationState,
  Heading,
  StatusBadge,
  Text,
  createDataTableColumnHelper,
  toast,
  useDataTable,
} from "@medusajs/ui";
import { ArrowPathMini } from "@medusajs/icons";

import { sdk } from "../../../lib/client";
import { StatCard, formatDateTime } from "../../../components/quickbooks-ui";

type CustomerSummary = {
  id: string | null;
  email?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  company_name?: string | null;
  phone?: string | null;
  has_account?: boolean | null;
  display_name?: string | null;
  fully_qualified_name?: string | null;
  primary_email?: string | null;
  primary_phone?: string | null;
  active?: boolean | null;
  create_time?: string | null;
  update_time?: string | null;
};

type MatchSummary = {
  email?: string | null;
  medusa_customer_id?: string | null;
  quickbooks_customer_id?: string | null;
  medusa_name?: string | null;
  quickbooks_name?: string | null;
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

type SyncResponse = {
  connected: boolean;
  created: number;
  updated: number;
  skipped: number;
};

type CustomerRow = CustomerSummary & { _key: string };
type MatchRow = MatchSummary & { _key: string };

const PAGE_SIZE = 10;

const customerName = (customer: CustomerSummary) =>
  customer.display_name ||
  [customer.first_name, customer.last_name].filter(Boolean).join(" ") ||
  customer.company_name ||
  "-";

const customerEmail = (customer: CustomerSummary) =>
  customer.primary_email || customer.email || "-";

const customerPhone = (customer: CustomerSummary) =>
  customer.primary_phone || customer.phone || "-";

const matchesQuery = (
  values: Array<string | null | undefined>,
  query: string,
) => values.some((value) => value?.toLowerCase().includes(query));

const customerColumnHelper = createDataTableColumnHelper<CustomerRow>();
const matchColumnHelper = createDataTableColumnHelper<MatchRow>();

const medusaCustomerColumns = [
  customerColumnHelper.accessor("email", {
    header: "Customer",
    cell: ({ row }) => (
      <div className="flex flex-col">
        <Text size="small" leading="compact" weight="plus">
          {customerName(row.original)}
        </Text>
        <Text size="xsmall" leading="compact" className="text-ui-fg-subtle">
          {customerEmail(row.original)}
        </Text>
      </div>
    ),
  }),
  customerColumnHelper.accessor("phone", {
    header: "Phone",
    cell: ({ row }) => (
      <Text size="small" leading="compact">
        {customerPhone(row.original)}
      </Text>
    ),
  }),
  customerColumnHelper.accessor("company_name", {
    header: "Company",
    cell: ({ getValue }) => (
      <Text size="small" leading="compact">
        {getValue() || "-"}
      </Text>
    ),
  }),
  customerColumnHelper.accessor("has_account", {
    header: "Account",
    cell: ({ getValue }) =>
      getValue() ? (
        <StatusBadge color="green">Registered</StatusBadge>
      ) : (
        <StatusBadge color="grey">Guest</StatusBadge>
      ),
  }),
  customerColumnHelper.accessor("id", {
    header: "ID",
    cell: ({ getValue }) => (
      <Text
        size="xsmall"
        leading="compact"
        className="font-mono text-ui-fg-subtle"
      >
        {getValue() || "-"}
      </Text>
    ),
  }),
];

const quickbooksCustomerColumns = [
  customerColumnHelper.accessor("display_name", {
    header: "Customer",
    cell: ({ row }) => (
      <div className="flex flex-col">
        <Text size="small" leading="compact" weight="plus">
          {customerName(row.original)}
        </Text>
        <Text size="xsmall" leading="compact" className="text-ui-fg-subtle">
          {customerEmail(row.original)}
        </Text>
      </div>
    ),
  }),
  customerColumnHelper.accessor("primary_phone", {
    header: "Phone",
    cell: ({ row }) => (
      <Text size="small" leading="compact">
        {customerPhone(row.original)}
      </Text>
    ),
  }),
  customerColumnHelper.accessor("company_name", {
    header: "Company",
    cell: ({ getValue }) => (
      <Text size="small" leading="compact">
        {getValue() || "-"}
      </Text>
    ),
  }),
  customerColumnHelper.accessor("active", {
    header: "Status",
    cell: ({ getValue }) =>
      getValue() === false ? (
        <StatusBadge color="red">Inactive</StatusBadge>
      ) : (
        <StatusBadge color="green">Active</StatusBadge>
      ),
  }),
  customerColumnHelper.accessor("update_time", {
    header: "Updated",
    cell: ({ getValue }) => (
      <Text size="small" leading="compact" className="text-ui-fg-subtle">
        {formatDateTime(getValue())}
      </Text>
    ),
  }),
];

const matchColumns = [
  matchColumnHelper.accessor("email", {
    header: "Email",
    cell: ({ getValue }) => (
      <Text size="small" leading="compact" weight="plus">
        {getValue() || "-"}
      </Text>
    ),
  }),
  matchColumnHelper.accessor("medusa_name", {
    header: "Medusa",
    cell: ({ row }) => (
      <div className="flex flex-col">
        <Text size="small" leading="compact">
          {row.original.medusa_name || "-"}
        </Text>
        <Text
          size="xsmall"
          leading="compact"
          className="font-mono text-ui-fg-subtle"
        >
          {row.original.medusa_customer_id || "-"}
        </Text>
      </div>
    ),
  }),
  matchColumnHelper.accessor("quickbooks_name", {
    header: "QuickBooks",
    cell: ({ row }) => (
      <div className="flex flex-col">
        <Text size="small" leading="compact">
          {row.original.quickbooks_name || "-"}
        </Text>
        <Text
          size="xsmall"
          leading="compact"
          className="font-mono text-ui-fg-subtle"
        >
          {row.original.quickbooks_customer_id || "-"}
        </Text>
      </div>
    ),
  }),
  matchColumnHelper.accessor("medusa_customer_id", {
    header: "Link",
    cell: () => <StatusBadge color="green">Matched</StatusBadge>,
  }),
];

type CustomerTableCardProps<TRow extends { _key: string }> = {
  title: string;
  description: string;
  rows: TRow[];
  columns: any[];
  isLoading: boolean;
  searchPlaceholder: string;
  filterRow: (row: TRow, query: string) => boolean;
};

const CustomerTableCard = <TRow extends { _key: string }>({
  title,
  description,
  rows,
  columns,
  isLoading,
  searchPlaceholder,
  filterRow,
}: CustomerTableCardProps<TRow>) => {
  const [search, setSearch] = useState("");
  const [pagination, setPagination] = useState<DataTablePaginationState>({
    pageIndex: 0,
    pageSize: PAGE_SIZE,
  });

  const filteredRows = useMemo(() => {
    const query = search.trim().toLowerCase();

    if (!query) {
      return rows;
    }

    return rows.filter((row) => filterRow(row, query));
  }, [rows, search, filterRow]);

  const pageRows = useMemo(() => {
    const start = pagination.pageIndex * pagination.pageSize;

    return filteredRows.slice(start, start + pagination.pageSize);
  }, [filteredRows, pagination]);

  const table = useDataTable({
    data: pageRows,
    columns,
    rowCount: filteredRows.length,
    getRowId: (row) => row._key,
    isLoading,
    pagination: {
      state: pagination,
      onPaginationChange: setPagination,
    },
    search: {
      state: search,
      onSearchChange: (value) => {
        setSearch(value);
        setPagination((current) => ({ ...current, pageIndex: 0 }));
      },
    },
  });

  return (
    <Container className="p-0 overflow-hidden">
      <DataTable instance={table}>
        <DataTable.Toolbar className="flex flex-col items-start justify-between gap-3 px-6 py-4 md:flex-row md:items-center">
          <div className="flex flex-col gap-y-1">
            <Heading level="h2">{title}</Heading>
            <Text size="small" leading="compact" className="text-ui-fg-subtle">
              {description}
            </Text>
          </div>
          <DataTable.Search placeholder={searchPlaceholder} />
        </DataTable.Toolbar>
        <DataTable.Table />
        <DataTable.Pagination />
      </DataTable>
    </Container>
  );
};

const QuickbooksCustomersPage = () => {
  const queryClient = useQueryClient();

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["quickbooks-customers"],
    queryFn: () =>
      sdk.client.fetch<CustomersStatusResponse>(
        "/admin/quickbooks/customers/status",
      ),
  });

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["quickbooks-customers"] });

  const inboundSyncMutation = useMutation({
    mutationFn: () =>
      sdk.client.fetch<SyncResponse>("/admin/quickbooks/customers/sync", {
        method: "POST",
      }),
    onSuccess: async (result) => {
      toast.success(
        `QuickBooks to Medusa sync finished. Created ${result.created}, updated ${result.updated}, skipped ${result.skipped}.`,
      );
      await refresh();
    },
    onError: (e: any) => {
      toast.error(
        e?.message || "Unable to sync QuickBooks customers into Medusa.",
      );
    },
  });

  const outboundSyncMutation = useMutation({
    mutationFn: () =>
      sdk.client.fetch<SyncResponse>("/admin/quickbooks/customers/sync", {
        method: "POST",
        body: { direction: "medusa_to_quickbooks" },
      }),
    onSuccess: async (result) => {
      toast.success(
        `Medusa to QuickBooks sync finished. Created ${result.created}, updated ${result.updated}, skipped ${result.skipped}.`,
      );
      await refresh();
    },
    onError: (e: any) => {
      toast.error(
        e?.message || "Unable to sync Medusa customers into QuickBooks.",
      );
    },
  });

  const medusaRows = useMemo<CustomerRow[]>(
    () =>
      (data?.medusa.normalized || []).map((customer, index) => ({
        ...customer,
        _key: `medusa-${customer.id ?? customer.email ?? index}-${index}`,
      })),
    [data?.medusa.normalized],
  );

  const quickbooksRows = useMemo<CustomerRow[]>(
    () =>
      (data?.quickbooks.normalized || []).map((customer, index) => ({
        ...customer,
        _key: `qbo-${customer.id ?? customer.primary_email ?? index}-${index}`,
      })),
    [data?.quickbooks.normalized],
  );

  const matchRows = useMemo<MatchRow[]>(
    () =>
      (data?.matches || []).map((match, index) => ({
        ...match,
        _key: `match-${match.medusa_customer_id ?? ""}-${match.quickbooks_customer_id ?? ""}-${index}`,
      })),
    [data?.matches],
  );

  const inactiveCount = useMemo(
    () =>
      (data?.quickbooks.normalized || []).filter(
        (customer) => customer.active === false,
      ).length,
    [data?.quickbooks.normalized],
  );

  const isSyncing =
    inboundSyncMutation.isPending || outboundSyncMutation.isPending;

  const filterCustomerRow = (row: CustomerRow, query: string) =>
    matchesQuery(
      [
        customerName(row),
        customerEmail(row),
        customerPhone(row),
        row.company_name,
        row.id,
      ],
      query,
    );

  const filterMatchRow = (row: MatchRow, query: string) =>
    matchesQuery(
      [
        row.email,
        row.medusa_name,
        row.quickbooks_name,
        row.medusa_customer_id,
        row.quickbooks_customer_id,
      ],
      query,
    );

  return (
    <div className="flex flex-col gap-y-4">
      <Container className="p-0 overflow-hidden">
        <div className="flex flex-col gap-y-4 px-6 py-4">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="flex flex-col gap-y-1">
              <Heading level="h1">QuickBooks Customers</Heading>
              <Text
                size="small"
                leading="compact"
                className="text-ui-fg-subtle"
              >
                Compare customer records between Medusa and QuickBooks and run
                sync in either direction.
              </Text>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge color={data?.connected ? "green" : "grey"}>
                {data?.connected ? "Connected" : "Disconnected"}
              </StatusBadge>
              <Button
                size="small"
                variant="primary"
                onClick={() => inboundSyncMutation.mutate()}
                isLoading={inboundSyncMutation.isPending}
                disabled={!data?.connected || isSyncing}
              >
                Sync QuickBooks to Medusa
              </Button>
              <Button
                size="small"
                variant="primary"
                onClick={() => outboundSyncMutation.mutate()}
                isLoading={outboundSyncMutation.isPending}
                disabled={!data?.connected || isSyncing}
              >
                Sync Medusa to QuickBooks
              </Button>
              <Button
                size="small"
                variant="secondary"
                onClick={() => void refresh()}
                disabled={isLoading}
              >
                <ArrowPathMini className="size-4" />
              </Button>
            </div>
          </div>

          {isError ? (
            <Alert variant="error">
              {(error as Error)?.message || "Unable to load customer status."}
            </Alert>
          ) : null}

          {data && !data.configured ? (
            <Alert variant="warning">
              QuickBooks is not configured on the backend. Missing keys:{" "}
              {(data.missingKeys || []).join(", ")}
            </Alert>
          ) : null}

          {data?.quickbooks.error ? (
            <Alert variant="warning">{data.quickbooks.error}</Alert>
          ) : null}

          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatCard
              label="Medusa Customers"
              value={data?.medusa.count ?? 0}
            />
            <StatCard
              label="QuickBooks Customers"
              value={data?.quickbooks.count ?? 0}
              hint={`${inactiveCount} inactive`}
            />
            <StatCard label="Matched" value={matchRows.length} />
            <StatCard
              label="Environment"
              value={data?.environment || "-"}
              hint={data?.realmId ? `Realm ${data.realmId}` : undefined}
            />
          </div>
        </div>
      </Container>

      <CustomerTableCard
        title="Matched Customers"
        description="Email-based links between Medusa and QuickBooks customers."
        rows={matchRows}
        columns={matchColumns}
        isLoading={isLoading}
        searchPlaceholder="Search matches..."
        filterRow={filterMatchRow}
      />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <CustomerTableCard
          title="Medusa Customers"
          description="Customers currently stored in Medusa."
          rows={medusaRows}
          columns={medusaCustomerColumns}
          isLoading={isLoading}
          searchPlaceholder="Search Medusa customers..."
          filterRow={filterCustomerRow}
        />
        <CustomerTableCard
          title="QuickBooks Customers"
          description="Customer records returned from QuickBooks."
          rows={quickbooksRows}
          columns={quickbooksCustomerColumns}
          isLoading={isLoading}
          searchPlaceholder="Search QuickBooks customers..."
          filterRow={filterCustomerRow}
        />
      </div>
    </div>
  );
};

export const config = defineRouteConfig({
  label: "Customers",
});

export const handle = {
  breadcrumb: () => "Customers",
};

export default QuickbooksCustomersPage;
