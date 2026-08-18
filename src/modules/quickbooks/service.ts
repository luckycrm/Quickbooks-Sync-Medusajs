import { MedusaService } from "@medusajs/framework/utils";

import QuickbooksConnection from "./models/quickbooks-connection";
import QuickbooksCustomerLink from "./models/quickbooks-customer-link";
import QuickbooksOrderLink from "./models/quickbooks-order-link";
import QuickbooksProductSyncQueue from "./models/quickbooks-product-sync-queue";

type UpsertConnectionInput = {
  environment: string;
  realm_id: string | null;
  access_token: string | null;
  refresh_token: string | null;
  token_type: string | null;
  scope?: Record<string, unknown> | null;
  expires_at?: Date | null;
  refresh_token_expires_at?: Date | null;
  raw_token?: Record<string, unknown> | null;
  connected_at?: Date | null;
  disconnected_at?: Date | null;
  quickbooks_product_income_account_id?: string | null;
  quickbooks_product_income_account_name?: string | null;
  quickbooks_price_currency?: string | null;
  quickbooks_order_tax_treatment?: string | null;
  quickbooks_order_tax_code_id?: string | null;
  quickbooks_order_tax_code_name?: string | null;
  quickbooks_order_doc_number_prefix?: string | null;
  updated_by?: string | null;
};

class QuickbooksModuleService extends MedusaService({
  QuickbooksConnection,
  QuickbooksCustomerLink,
  QuickbooksOrderLink,
  QuickbooksProductSyncQueue,
}) {
  async getConnection() {
    const connections = await this.listQuickbooksConnections({
      provider: "quickbooks",
    });

    return connections[0] ?? null;
  }

  async upsertConnection(input: UpsertConnectionInput) {
    const existing = await this.getConnection();

    if (existing) {
      return await this.updateQuickbooksConnections({
        id: existing.id,
        provider: "quickbooks",
        ...input,
      });
    }

    return await this.createQuickbooksConnections({
      provider: "quickbooks",
      ...input,
    });
  }

  async clearConnection(updatedBy?: string | null) {
    const existing = await this.getConnection();

    if (!existing) {
      return null;
    }

    return await this.updateQuickbooksConnections({
      id: existing.id,
      access_token: null,
      refresh_token: null,
      token_type: null,
      realm_id: null,
      scope: null,
      expires_at: null,
      refresh_token_expires_at: null,
      raw_token: null,
      disconnected_at: new Date(),
      quickbooks_product_income_account_id: null,
      quickbooks_product_income_account_name: null,
      updated_by: updatedBy ?? null,
    });
  }

  async getCustomerLinkByMedusaCustomerId(medusaCustomerId: string) {
    const links = await this.listQuickbooksCustomerLinks({
      medusa_customer_id: medusaCustomerId,
    });

    return links[0] ?? null;
  }

  async getCustomerLinkByQuickbooksCustomerId(quickbooksCustomerId: string) {
    const links = await this.listQuickbooksCustomerLinks({
      quickbooks_customer_id: quickbooksCustomerId,
    });

    return links[0] ?? null;
  }

  async upsertCustomerLink(input: {
    medusa_customer_id: string;
    quickbooks_customer_id: string;
    quickbooks_sync_token?: string | null;
    realm_id?: string | null;
    last_synced_hash?: string | null;
    last_direction?: string | null;
    last_synced_at?: Date | null;
    metadata?: Record<string, unknown> | null;
  }) {
    const existing =
      (await this.getCustomerLinkByMedusaCustomerId(
        input.medusa_customer_id,
      )) ||
      (await this.getCustomerLinkByQuickbooksCustomerId(
        input.quickbooks_customer_id,
      ));

    if (existing) {
      return await this.updateQuickbooksCustomerLinks({
        id: existing.id,
        ...input,
      });
    }

    return await this.createQuickbooksCustomerLinks(input);
  }

  async getOrderLinkByMedusaOrderId(medusaOrderId: string) {
    const links = await this.listQuickbooksOrderLinks({
      medusa_order_id: medusaOrderId,
    });

    return links[0] ?? null;
  }

  async getOrderLinkByQuickbooksSalesReceiptId(
    quickbooksSalesReceiptId: string,
  ) {
    const links = await this.listQuickbooksOrderLinks({
      quickbooks_sales_receipt_id: quickbooksSalesReceiptId,
    });

    return links[0] ?? null;
  }

  async getOrderLinkByQuickbooksInvoiceId(quickbooksInvoiceId: string) {
    const links = await this.listQuickbooksOrderLinks({
      quickbooks_invoice_id: quickbooksInvoiceId,
    });

    return links[0] ?? null;
  }

  async upsertOrderLink(input: {
    medusa_order_id: string;
    quickbooks_sales_receipt_id?: string | null;
    quickbooks_invoice_id?: string | null;
    quickbooks_sync_token?: string | null;
    realm_id?: string | null;
    sync_type?: string | null;
    last_synced_hash?: string | null;
    last_synced_at?: Date | null;
    metadata?: Record<string, unknown> | null;
  }) {
    const existing =
      (await this.getOrderLinkByMedusaOrderId(input.medusa_order_id)) ||
      (input.quickbooks_sales_receipt_id
        ? await this.getOrderLinkByQuickbooksSalesReceiptId(
            input.quickbooks_sales_receipt_id,
          )
        : null) ||
      (input.quickbooks_invoice_id
        ? await this.getOrderLinkByQuickbooksInvoiceId(
            input.quickbooks_invoice_id,
          )
        : null);

    if (existing) {
      return await this.updateQuickbooksOrderLinks({
        id: existing.id,
        ...input,
      });
    }

    return await this.createQuickbooksOrderLinks(input);
  }

  async clearOrderLinks() {
    const [links] = await this.listAndCountQuickbooksOrderLinks(
      {},
      { select: ["id"], take: 5000 },
    );
    if (links.length > 0) {
      await this.deleteQuickbooksOrderLinks(links.map((l) => l.id));
    }
  }

  async clearCustomerLinks() {
    const [links] = await this.listAndCountQuickbooksCustomerLinks(
      {},
      { select: ["id"], take: 5000 },
    );
    if (links.length > 0) {
      await this.deleteQuickbooksCustomerLinks(links.map((l) => l.id));
    }
  }

  async enqueueProductSync(productId: string) {
    const existing = await this.getProductSyncQueueByProductId(productId);
    const input = {
      product_id: productId,
      status: "pending",
      available_at: new Date(),
      locked_at: null,
      last_error: null,
    };

    if (existing) {
      return await this.updateQuickbooksProductSyncQueues({
        id: existing.id,
        ...input,
      });
    }

    return await this.createQuickbooksProductSyncQueues(input);
  }

  async getProductSyncQueueByProductId(productId: string) {
    const rows = await this.listQuickbooksProductSyncQueues({
      product_id: productId,
    });

    return rows[0] ?? null;
  }

  async getNextProductSyncQueueItem() {
    const [rows] = await this.listAndCountQuickbooksProductSyncQueues(
      {
        status: "pending",
        available_at: { $lte: new Date() },
      },
      {
        order: { available_at: "ASC" },
        take: 1,
      },
    );

    const item = rows[0];
    if (!item) {
      return null;
    }

    return await this.updateQuickbooksProductSyncQueues({
      id: item.id,
      status: "processing",
      locked_at: new Date(),
    });
  }

  async releaseStaleProductSyncQueueItems() {
    const staleBefore = new Date(Date.now() - 10 * 60 * 1000);
    const [items] = await this.listAndCountQuickbooksProductSyncQueues({
      status: "processing",
      locked_at: { $lte: staleBefore },
    });

    for (const item of items) {
      await this.updateQuickbooksProductSyncQueues({
        id: item.id,
        status: "pending",
        available_at: new Date(),
        locked_at: null,
      });
    }
  }

  async completeProductSyncQueueItem(id: string) {
    await this.deleteQuickbooksProductSyncQueues([id]);
  }

  async retryProductSyncQueueItem(
    id: string,
    error: string,
    delayMs: number,
  ) {
    const item = await this.retrieveQuickbooksProductSyncQueue(id);

    return await this.updateQuickbooksProductSyncQueues({
      id,
      status: "pending",
      attempts: Number(item.attempts || 0) + 1,
      available_at: new Date(Date.now() + delayMs),
      locked_at: null,
      last_error: error.slice(0, 2000),
    });
  }
}

export default QuickbooksModuleService;
