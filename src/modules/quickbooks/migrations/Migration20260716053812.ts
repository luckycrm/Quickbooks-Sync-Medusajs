import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260716053812 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "quickbooks_connection" add column if not exists "quickbooks_order_tax_treatment" text null, add column if not exists "quickbooks_order_tax_code_id" text null, add column if not exists "quickbooks_order_tax_code_name" text null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "quickbooks_connection" drop column if exists "quickbooks_order_tax_treatment", drop column if exists "quickbooks_order_tax_code_id", drop column if exists "quickbooks_order_tax_code_name";`);
  }

}
