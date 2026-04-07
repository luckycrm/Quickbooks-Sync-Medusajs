import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260330051958 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table if not exists "quickbooks_connection" ("id" text not null, "provider" text not null default 'quickbooks', "environment" text not null default 'sandbox', "realm_id" text null, "access_token" text null, "refresh_token" text null, "token_type" text null, "scope" jsonb null, "expires_at" timestamptz null, "refresh_token_expires_at" timestamptz null, "raw_token" jsonb null, "connected_at" timestamptz null, "disconnected_at" timestamptz null, "quickbooks_product_income_account_id" text null, "quickbooks_product_income_account_name" text null, "updated_by" text null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "quickbooks_connection_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_quickbooks_connection_deleted_at" ON "quickbooks_connection" ("deleted_at") WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "quickbooks_customer_link" ("id" text not null, "medusa_customer_id" text not null, "quickbooks_customer_id" text not null, "quickbooks_sync_token" text null, "realm_id" text null, "last_synced_hash" text null, "last_direction" text null, "last_synced_at" timestamptz null, "metadata" jsonb null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "quickbooks_customer_link_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_quickbooks_customer_link_deleted_at" ON "quickbooks_customer_link" ("deleted_at") WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "quickbooks_order_link" ("id" text not null, "medusa_order_id" text not null, "quickbooks_sales_receipt_id" text null, "quickbooks_invoice_id" text null, "quickbooks_sync_token" text null, "realm_id" text null, "sync_type" text null, "last_synced_hash" text null, "last_synced_at" timestamptz null, "metadata" jsonb null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "quickbooks_order_link_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_quickbooks_order_link_deleted_at" ON "quickbooks_order_link" ("deleted_at") WHERE deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "quickbooks_connection" cascade;`);

    this.addSql(`drop table if exists "quickbooks_customer_link" cascade;`);

    this.addSql(`drop table if exists "quickbooks_order_link" cascade;`);
  }

}
