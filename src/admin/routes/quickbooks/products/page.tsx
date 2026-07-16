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
import { StatCard } from "../../../components/quickbooks-ui";

type ProductVariantSummary = {
  id: string | null;
  title: string | null;
  sku: string | null;
  manage_inventory: boolean;
  quickbooks_item_id: string | null;
  quickbooks_active: boolean | null;
  quickbooks_type: string | null;
  quickbooks_unit_price: number | null;
  quickbooks_qty_on_hand: number | null;
  quickbooks_image_count: number;
  availability: string[];
};

type UnifiedProductRow = {
  id: string;
  medusa_product_id: string | null;
  quickbooks_item_ids: string[];
  title: string | null;
  subtitle: string | null;
  handle: string | null;
  status: string | null;
  thumbnail: string | null;
  product_type: string | null;
  collection: string | null;
  source: "medusa" | "quickbooks";
  availability: string[];
  product_tags: string[];
  sales_channels: string[];
  image_count: number;
  quickbooks_image_count: number;
  variant_count: number;
  matched_variant_count: number;
  unmatched_variant_count: number;
  variants: ProductVariantSummary[];
  quickbooks_name: string | null;
  quickbooks_type: string | null;
  quickbooks_active: boolean | null;
  quickbooks_updated_at: string | null;
};

type ProductsStatusResponse = {
  configured: boolean;
  connected: boolean;
  environment?: string;
  realmId?: string;
  limit?: number;
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

type ProductSyncResponse = {
  count?: number;
  created?: number;
  updated?: number;
  skipped?: number;
  skipped_variants?: number;
  medusa_product_id?: string;
  reason?: string;
};

const FETCH_LIMIT = 100;
const PAGE_SIZE = 20;

const columnHelper = createDataTableColumnHelper<UnifiedProductRow>();

const QuickbooksProductsPage = () => {
  const queryClient = useQueryClient();
  const [searchValue, setSearchValue] = useState("");
  const [pagination, setPagination] = useState<DataTablePaginationState>({
    pageIndex: 0,
    pageSize: PAGE_SIZE,
  });

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["quickbooks-products"],
    queryFn: () =>
      sdk.client.fetch<ProductsStatusResponse>(
        "/admin/quickbooks/products/status",
        {
          query: { limit: FETCH_LIMIT },
        },
      ),
  });

  const syncAllMutation = useMutation({
    mutationFn: () =>
      sdk.client.fetch<ProductSyncResponse>("/admin/quickbooks/products/sync", {
        method: "POST",
        body: { sync_all: true },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["quickbooks-products"] });
      toast.success(
        "Full product sync started in the background. Large catalogs take several minutes — refresh the page to see progress.",
      );
    },
    onError: (e: any) => {
      toast.error(e?.message || "Unable to sync all products");
    },
  });

  const syncOneMutation = useMutation({
    mutationFn: (productId: string) =>
      sdk.client.fetch<ProductSyncResponse>(
        `/admin/quickbooks/products/${productId}/sync`,
        {
          method: "POST",
        },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["quickbooks-products"] });
      toast.success("Product sync completed");
    },
    onError: (e: any) => {
      toast.error(e?.message || "Unable to sync product");
    },
  });

  const filteredRows = useMemo(() => {
    const rows = data?.rows || [];
    const query = searchValue.trim().toLowerCase();

    if (!query) {
      return rows;
    }

    return rows.filter((row) =>
      [
        row.title,
        row.handle,
        row.quickbooks_name,
        row.status,
        ...row.variants.map((variant) => variant.sku),
      ].some((value) => value?.toLowerCase().includes(query)),
    );
  }, [data?.rows, searchValue]);

  const pageRows = useMemo(() => {
    const start = pagination.pageIndex * pagination.pageSize;

    return filteredRows.slice(start, start + pagination.pageSize);
  }, [filteredRows, pagination]);

  const columns = useMemo(
    () => [
      columnHelper.accessor("thumbnail", {
        header: "",
        cell: ({ getValue }) => (
          <div className="flex items-center justify-center p-1">
            {getValue() ? (
              <img
                src={getValue()!}
                alt="Product thumbnail"
                className="h-8 w-8 rounded-md border border-ui-border-base object-cover"
              />
            ) : (
              <div className="h-8 w-8 rounded-md border border-dashed border-ui-border-base bg-ui-bg-subtle" />
            )}
          </div>
        ),
      }),
      columnHelper.accessor("title", {
        header: "Product",
        cell: ({ row }) => (
          <div className="flex flex-col">
            <Text size="small" leading="compact" weight="plus">
              {row.original.title || row.original.quickbooks_name || "Untitled"}
            </Text>
            <Text size="xsmall" leading="compact" className="text-ui-fg-subtle">
              {row.original.handle || "-"}
            </Text>
          </div>
        ),
      }),
      columnHelper.accessor("source", {
        header: "Source",
        cell: ({ getValue }) => (
          <Badge
            color={getValue() === "medusa" ? "blue" : "orange"}
            size="2xsmall"
          >
            {getValue() === "medusa" ? "Medusa" : "QuickBooks Only"}
          </Badge>
        ),
      }),
      columnHelper.accessor("status", {
        header: "Status",
        cell: ({ getValue }) => {
          const status = getValue();

          if (!status) {
            return (
              <Text
                size="small"
                leading="compact"
                className="text-ui-fg-subtle"
              >
                -
              </Text>
            );
          }

          return (
            <StatusBadge color={status === "published" ? "green" : "grey"}>
              {status}
            </StatusBadge>
          );
        },
      }),
      columnHelper.accessor("variant_count", {
        header: "Variants Matched",
        cell: ({ row }) => (
          <div className="flex flex-col">
            <Text size="small" leading="compact">
              {row.original.matched_variant_count} /{" "}
              {row.original.variant_count}
            </Text>
            {row.original.unmatched_variant_count > 0 ? (
              <Text
                size="xsmall"
                leading="compact"
                className="text-ui-fg-muted"
              >
                {row.original.unmatched_variant_count} missing
              </Text>
            ) : null}
          </div>
        ),
      }),
      columnHelper.accessor("quickbooks_image_count", {
        header: "QBO Images",
        cell: ({ row }) => (
          <Text size="small" leading="compact" className="text-ui-fg-subtle">
            {row.original.quickbooks_image_count} / {row.original.image_count}
          </Text>
        ),
      }),
      columnHelper.accessor("quickbooks_active", {
        header: "QBO Status",
        cell: ({ getValue }) => {
          const active = getValue();

          if (active === null) {
            return (
              <Text
                size="small"
                leading="compact"
                className="text-ui-fg-subtle"
              >
                -
              </Text>
            );
          }

          return (
            <StatusBadge color={active ? "green" : "red"}>
              {active ? "Active" : "Inactive"}
            </StatusBadge>
          );
        },
      }),
      columnHelper.action({
        actions: (row) => [
          {
            label: "Sync to QuickBooks",
            onClick: () =>
              syncOneMutation.mutate(row.row.original.medusa_product_id!),
            disabled:
              !row.row.original.medusa_product_id || syncOneMutation.isPending,
            icon: <ArrowPathMini className="size-4" />,
          },
        ],
      }),
    ],
    [syncOneMutation],
  );

  const table = useDataTable({
    data: pageRows,
    columns,
    rowCount: filteredRows.length,
    getRowId: (row) => row.id,
    isLoading,
    pagination: {
      state: pagination,
      onPaginationChange: setPagination,
    },
    search: {
      state: searchValue,
      onSearchChange: (value) => {
        setSearchValue(value);
        setPagination((current) => ({ ...current, pageIndex: 0 }));
      },
    },
  });

  return (
    <div className="flex flex-col gap-y-4">
      <Container className="p-0 overflow-hidden">
        <div className="flex flex-col gap-y-4 px-6 py-4">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="flex flex-col gap-y-1">
              <Heading level="h1">QuickBooks Products</Heading>
              <Text
                size="small"
                leading="compact"
                className="text-ui-fg-subtle"
              >
                Synchronize Medusa products with QuickBooks Online. Medusa is
                the source of truth.
              </Text>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge color={data?.connected ? "green" : "grey"}>
                {data?.connected ? "Connected" : "Disconnected"}
              </StatusBadge>
              <Button
                size="small"
                variant="primary"
                onClick={() => syncAllMutation.mutate()}
                isLoading={syncAllMutation.isPending}
                disabled={!data?.connected}
              >
                Sync All
              </Button>
              <Button
                size="small"
                variant="secondary"
                onClick={() =>
                  void queryClient.invalidateQueries({
                    queryKey: ["quickbooks-products"],
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
              {(error as Error)?.message ||
                "Unable to load product sync status."}
            </Alert>
          ) : null}

          {data && !data.configured ? (
            <Alert variant="warning">
              QuickBooks is not configured. Missing:{" "}
              {(data.missingKeys || []).join(", ")}
            </Alert>
          ) : null}

          {data?.quickbooks?.error ? (
            <Alert variant="warning">{data.quickbooks.error}</Alert>
          ) : null}

          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
            <StatCard
              label="Medusa Products"
              value={data?.summary.medusa_products ?? 0}
            />
            <StatCard
              label="QuickBooks Items"
              value={data?.summary.quickbooks_items ?? 0}
            />
            <StatCard
              label="Matched Variants"
              value={data?.summary.matched_variants ?? 0}
            />
            <StatCard
              label="Missing Variants"
              value={data?.summary.missing_variants ?? 0}
            />
            <StatCard
              label="QuickBooks Only"
              value={data?.summary.quickbooks_only_items ?? 0}
              hint={
                data?.environment
                  ? `${data.environment} • Realm ${data.realmId || "-"}`
                  : undefined
              }
            />
          </div>
        </div>
      </Container>

      <Container className="p-0 overflow-hidden">
        <DataTable instance={table}>
          <DataTable.Toolbar className="flex items-center justify-between px-6 py-4">
            <div className="flex flex-col gap-y-1">
              <Heading level="h2">Product List</Heading>
              <Text
                size="small"
                leading="compact"
                className="text-ui-fg-subtle"
              >
                Variant coverage and QuickBooks item status per product.
              </Text>
            </div>
            <DataTable.Search placeholder="Search products..." />
          </DataTable.Toolbar>
          <DataTable.Table />
          <DataTable.Pagination />
        </DataTable>
      </Container>
    </div>
  );
};

export const config = defineRouteConfig({
  label: "Products",
  rank: 2,
});

export const handle = {
  breadcrumb: () => "Products",
};

export default QuickbooksProductsPage;
