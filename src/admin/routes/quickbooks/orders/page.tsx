import { defineRouteConfig } from "@medusajs/admin-sdk";
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Badge,
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

type OrderLink = {
  id: string;
  medusa_order_id: string;
  quickbooks_sales_receipt_id: string | null;
  quickbooks_invoice_id: string | null;
  quickbooks_sync_token: string | null;
  realm_id: string | null;
  sync_type: string | null;
  last_synced_hash: string | null;
  last_synced_at: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

type OrdersStatusResponse = {
  order_links: OrderLink[];
  count: number;
  limit: number;
  offset: number;
  has_more: boolean;
};

type OrderSyncResponse = {
  count?: number;
  synced?: number;
  skipped?: number;
  medusa_order_id?: string;
  quickbooks_sales_receipt_id?: string;
  doc_number?: string;
  reason?: string;
  results?: Array<{
    skipped: boolean;
    reason?: string;
    medusa_order_id?: string;
    quickbooks_sales_receipt_id?: string;
  }>;
};

const columnHelper = createDataTableColumnHelper<OrderLink>();

const columns = [
  columnHelper.accessor("medusa_order_id", {
    header: "Medusa Order",
    cell: ({ getValue }) => (
      <Text size="small" leading="compact" className="font-mono">
        {getValue()}
      </Text>
    ),
  }),
  columnHelper.accessor("quickbooks_sales_receipt_id", {
    header: "QuickBooks Reference",
    cell: ({ row }) => {
      const reference =
        row.original.quickbooks_sales_receipt_id ||
        row.original.quickbooks_invoice_id;

      if (!reference) {
        return <StatusBadge color="grey">Not synced</StatusBadge>;
      }

      return (
        <Text size="small" leading="compact" className="font-mono">
          {reference}
        </Text>
      );
    },
  }),
  columnHelper.accessor("sync_type", {
    header: "Sync Type",
    cell: ({ getValue }) => {
      const type = getValue();

      if (!type) {
        return (
          <Text size="small" leading="compact" className="text-ui-fg-subtle">
            -
          </Text>
        );
      }

      return (
        <Badge
          color={type === "sales_receipt" ? "green" : "blue"}
          size="2xsmall"
        >
          {type === "sales_receipt" ? "Sales Receipt" : type}
        </Badge>
      );
    },
  }),
  columnHelper.accessor("last_synced_at", {
    header: "Last Synced",
    cell: ({ getValue }) => (
      <Text size="small" leading="compact" className="text-ui-fg-subtle">
        {formatDateTime(getValue())}
      </Text>
    ),
  }),
  columnHelper.accessor("realm_id", {
    header: "Realm ID",
    cell: ({ getValue }) => (
      <Text
        size="small"
        leading="compact"
        className="font-mono text-ui-fg-subtle"
      >
        {getValue() || "-"}
      </Text>
    ),
  }),
];

const QuickbooksOrdersPage = () => {
  const queryClient = useQueryClient();
  const [pagination, setPagination] = useState<DataTablePaginationState>({
    pageIndex: 0,
    pageSize: 20,
  });

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["quickbooks-orders", pagination.pageIndex, pagination.pageSize],
    queryFn: () =>
      sdk.client.fetch<OrdersStatusResponse>(
        "/admin/quickbooks/orders/status",
        {
          query: {
            page: {
              limit: pagination.pageSize,
              offset: pagination.pageIndex * pagination.pageSize,
            },
          },
        },
      ),
  });

  const syncAllMutation = useMutation({
    mutationFn: () =>
      sdk.client.fetch<OrderSyncResponse>("/admin/quickbooks/orders/sync", {
        method: "POST",
        body: { sync_all: true },
      }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["quickbooks-orders"] });

      if (result.skipped === result.count) {
        toast.warning("No new orders to sync");
      } else {
        toast.success(`Synced ${result.synced || 0} orders`);
      }
    },
    onError: (e: any) => {
      toast.error(e?.message || "Unable to sync orders");
    },
  });

  const pageStats = useMemo(() => {
    const links = data?.order_links || [];
    const synced = links.filter(
      (link) => link.quickbooks_sales_receipt_id || link.quickbooks_invoice_id,
    ).length;

    return {
      synced,
      pending: links.length - synced,
    };
  }, [data?.order_links]);

  const table = useDataTable({
    data: data?.order_links || [],
    columns,
    rowCount: data?.count || 0,
    getRowId: (row) => row.id,
    isLoading,
    pagination: {
      state: pagination,
      onPaginationChange: setPagination,
    },
  });

  return (
    <div className="flex flex-col gap-y-4">
      <Container className="p-0 overflow-hidden">
        <div className="flex flex-col gap-y-4 px-6 py-4">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="flex flex-col gap-y-1">
              <Heading level="h1">QuickBooks Orders</Heading>
              <Text
                size="small"
                leading="compact"
                className="text-ui-fg-subtle"
              >
                Placed orders sync to QuickBooks as invoices, completed orders
                as sales receipts.
              </Text>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="small"
                variant="primary"
                onClick={() => syncAllMutation.mutate()}
                isLoading={syncAllMutation.isPending}
              >
                Sync All Orders
              </Button>
              <Button
                size="small"
                variant="secondary"
                onClick={() =>
                  void queryClient.invalidateQueries({
                    queryKey: ["quickbooks-orders"],
                  })
                }
                disabled={isLoading}
              >
                <ArrowPathMini className="size-4" />
              </Button>
            </div>
          </div>

          {isError ? (
            <Alert variant="error">
              {(error as Error)?.message || "Unable to load order sync status."}
            </Alert>
          ) : null}

          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <StatCard
              label="Order Links"
              value={data?.count ?? 0}
              hint="Total order-to-QuickBooks mappings"
            />
            <StatCard
              label="Synced on This Page"
              value={pageStats.synced}
              hint="Rows with a QuickBooks reference"
            />
            <StatCard
              label="Pending on This Page"
              value={pageStats.pending}
              hint="Rows without a QuickBooks reference"
            />
          </div>
        </div>
      </Container>

      <Container className="p-0 overflow-hidden">
        <DataTable instance={table}>
          <DataTable.Toolbar className="flex items-center justify-between px-6 py-4">
            <div className="flex flex-col gap-y-1">
              <Heading level="h2">Order Sync Records</Heading>
              <Text
                size="small"
                leading="compact"
                className="text-ui-fg-subtle"
              >
                All order-to-QuickBooks mappings, most recently synced first.
              </Text>
            </div>
          </DataTable.Toolbar>
          <DataTable.Table />
          <DataTable.Pagination />
        </DataTable>
      </Container>
    </div>
  );
};

export const config = defineRouteConfig({
  label: "Orders",
  rank: 3,
});

export const handle = {
  breadcrumb: () => "Orders",
};

export default QuickbooksOrdersPage;
