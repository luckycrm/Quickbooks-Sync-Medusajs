import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260818000000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `create table if not exists "quickbooks_product_sync_queue" ("id" text not null, "product_id" text not null, "status" text not null default 'pending', "attempts" int not null default 0, "available_at" timestamptz not null, "locked_at" timestamptz null, "last_error" text null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "quickbooks_product_sync_queue_pkey" primary key ("id"));`,
    );
    this.addSql(
      `create unique index if not exists "IDX_quickbooks_product_sync_queue_product_id" on "quickbooks_product_sync_queue" ("product_id") where deleted_at is null;`,
    );
    this.addSql(
      `create index if not exists "IDX_quickbooks_product_sync_queue_available" on "quickbooks_product_sync_queue" ("status", "available_at") where deleted_at is null;`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "quickbooks_product_sync_queue" cascade;`);
  }
}
