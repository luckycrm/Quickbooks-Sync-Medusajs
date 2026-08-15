import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260815180000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "quickbooks_connection" add column if not exists "quickbooks_order_doc_number_prefix" text null;`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `alter table if exists "quickbooks_connection" drop column if exists "quickbooks_order_doc_number_prefix";`,
    );
  }
}
