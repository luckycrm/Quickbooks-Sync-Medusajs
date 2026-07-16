import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260716041951 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "quickbooks_connection" add column if not exists "quickbooks_price_currency" text null;`);

    this.addSql(`alter table if exists "quickbooks_customer_link" alter column "quickbooks_customer_id" type text using ("quickbooks_customer_id"::text);`);
    this.addSql(`alter table if exists "quickbooks_customer_link" alter column "quickbooks_customer_id" set not null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "quickbooks_connection" drop column if exists "quickbooks_price_currency";`);

    this.addSql(`alter table if exists "quickbooks_customer_link" alter column "quickbooks_customer_id" type text using ("quickbooks_customer_id"::text);`);
    this.addSql(`alter table if exists "quickbooks_customer_link" alter column "quickbooks_customer_id" drop not null;`);
  }

}
