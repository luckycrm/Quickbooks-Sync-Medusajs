import { defineRouteConfig } from "@medusajs/admin-sdk"
import { useMemo, useState } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import {
  Alert,
  Badge,
  Button,
  Container,
  DataTable,
  DataTablePaginationState,
  Heading,
  Text,
  createDataTableColumnHelper,
  useDataTable,
  toast,
} from "@medusajs/ui"
import { ArrowPathMini } from "@medusajs/icons"
import { sdk } from "../../../lib/client"

type OrderLink = {
  id: string
  medusa_order_id: string
  quickbooks_sales_receipt_id: string | null
  quickbooks_invoice_id: string | null
  quickbooks_sync_token: string | null
  realm_id: string | null
  sync_type: string | null
  last_synced_hash: string | null
  last_synced_at: string | null
  metadata: Record<string, unknown> | null
  created_at: string
  updated_at: string
}

type OrdersStatusResponse = {
  order_links: OrderLink[]
  count: number
  limit: number
  offset: number
  has_more: boolean
}

type OrderSyncResponse = {
  count?: number
  synced?: number
  skipped?: number
  medusa_order_id?: string
  quickbooks_sales_receipt_id?: string
  doc_number?: string
  reason?: string
  results?: Array<{
    skipped: boolean
    reason?: string
    medusa_order_id?: string
    quickbooks_sales_receipt_id?: string
  }>
}

const StatCard = ({
  label,
  value,
}: {
  label: string
  value: string | number
}) => (
  <div className="flex flex-col gap-y-1 rounded-md border border-ui-border-base bg-ui-bg-base px-4 py-3">
    <Text size="xsmall" className="text-ui-fg-subtle">
      {label}
    </Text>
    <Text size="large" weight="plus">
      {value}
    </Text>
  </div>
)

const columnHelper = createDataTableColumnHelper<OrderLink>()

const QuickbooksOrdersPage = () => {
  const queryClient = useQueryClient()
  const [pagination, setPagination] = useState<DataTablePaginationState>({
    pageIndex: 0,
    pageSize: 50,
  })

  const { data, isLoading, isError, error } = useQuery({
    queryFn: async () => {
      const response = await sdk.client.fetch<OrdersStatusResponse>(
        "/admin/quickbooks/orders/status",
        {
          query: {
            limit: pagination.pageSize,
            offset: pagination.pageIndex * pagination.pageSize,
          },
        }
      )
      return response
    },
    queryKey: ["quickbooks-orders", pagination.pageIndex, pagination.pageSize],
  })

  const syncAllMutation = useMutation({
    mutationFn: async () => {
      return await sdk.client.fetch<OrderSyncResponse>(
        "/admin/quickbooks/orders/sync",
        {
          method: "POST",
          body: { sync_all: true },
        }
      )
    },
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["quickbooks-orders"] })
      if (result.skipped === result.count) {
        toast.warning("No new orders to sync")
      } else {
        toast.success(`Synced ${result.synced || 0} orders`)
      }
    },
    onError: (e: any) => {
      toast.error(e.message || "Unable to sync orders")
    },
  })

  const resetMutation = useMutation({
    mutationFn: async () => {
      return await sdk.client.fetch<{ success: boolean; message: string }>(
        "/admin/quickbooks/reset",
        {
          method: "POST",
          body: { type: "orders" },
        }
      )
    },
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["quickbooks-orders"] })
      toast.success(result.message || "Order sync history reset")
    },
    onError: (e: any) => {
      toast.error(e.message || "Unable to reset sync history")
    },
  })

  const columns = useMemo(
    () => [
      columnHelper.accessor("medusa_order_id", {
        header: "Medusa Order ID",
        cell: ({ getValue }: { getValue: () => string }) => (
          <Text size="small" className="font-mono">
            {getValue()}
          </Text>
        ),
      }),
      columnHelper.accessor("quickbooks_sales_receipt_id", {
        header: "QBO Sales Receipt ID",
        cell: ({ getValue }: { getValue: () => string | null }) => {
          const value = getValue()
          if (!value) return <Badge color="grey" size="2xsmall">Not Synced</Badge>
          return (
            <Text size="small" className="font-mono">
              {value}
            </Text>
          )
        },
      }),
      columnHelper.accessor("sync_type", {
        header: "Sync Type",
        cell: ({ getValue }: { getValue: () => string | null }) => {
          const type = getValue()
          if (!type) return "-"
          const color = type === "sales_receipt" ? "green" : "blue"
          return <Badge color={color} size="2xsmall">{type}</Badge>
        },
      }),
      columnHelper.accessor("last_synced_at", {
        header: "Last Synced",
        cell: ({ getValue }: { getValue: () => string | null }) => {
          const value = getValue()
          if (!value) return "-"
          const date = new Date(value)
          return (
            <Text size="small">
              {date.toLocaleDateString()} {date.toLocaleTimeString()}
            </Text>
          )
        },
      }),
      columnHelper.accessor("realm_id", {
        header: "Realm ID",
        cell: ({ getValue }: { getValue: () => string | null }) => (
          <Text size="small" className="font-mono">
            {getValue() || "-"}
          </Text>
        ),
      }),
    ],
    []
  )

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
  })

  return (
    <div className="flex flex-col gap-y-4">
      <Container className="p-0 overflow-hidden">
        <div className="flex flex-col gap-y-4 px-6 py-4">
          <div className="flex items-start justify-between">
            <div className="flex flex-col gap-y-1">
              <Heading level="h1">QuickBooks Orders</Heading>
              <Text className="text-ui-fg-subtle" size="small">
                Synchronize Medusa completed orders with QuickBooks Online Sales Receipts.
              </Text>
            </div>
            <div className="flex items-center gap-x-2">
              <Button
                size="small"
                variant="primary"
                onClick={() => syncAllMutation.mutate()}
                isLoading={syncAllMutation.isPending}
              >
                Sync All Completed Orders
              </Button>
              <Button
                size="small"
                variant="danger"
                onClick={() => {
                  if (confirm("Are you sure you want to clear all order sync history? This will NOT delete records in QuickBooks, only the mappings in Medusa.")) {
                    resetMutation.mutate()
                  }
                }}
                isLoading={resetMutation.isPending}
              >
                Reset Sync History
              </Button>
              <Button
                size="small"
                variant="secondary"
                onClick={() => void queryClient.invalidateQueries({ queryKey: ["quickbooks-orders"] })}
                disabled={isLoading}
              >
                <ArrowPathMini className="size-4" />
              </Button>
            </div>
          </div>

          {isError && (
            <Alert variant="error">
              {error?.message || "Unable to load order sync status."}
            </Alert>
          )}

          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatCard label="Total Synced" value={data?.count ?? 0} />
            <StatCard label="Current Page" value={pagination.pageIndex + 1} />
            <StatCard label="Page Size" value={pagination.pageSize} />
            <StatCard label="Has More" value={data?.has_more ? "Yes" : "No"} />
          </div>
        </div>
      </Container>

      <Container className="p-0 overflow-hidden">
        <DataTable instance={table}>
          <DataTable.Toolbar className="flex items-center justify-between px-6 py-4">
            <Heading level="h2">Order Sync Records</Heading>
            <div className="text-ui-fg-subtle text-sm">
              Shows all order-to-QuickBooks mappings
            </div>
          </DataTable.Toolbar>
          <DataTable.Table />
          <DataTable.Pagination />
        </DataTable>
      </Container>
    </div>
  )
}

export const config = defineRouteConfig({
  label: "Orders",
  rank: 3,
})

export const handle = {
  breadcrumb: () => "Orders",
}

export default QuickbooksOrdersPage