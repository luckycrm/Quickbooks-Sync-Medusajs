<div align="center">
  <img src="https://github.com/luckycrm/Quickbooks-Sync-Medusajs/raw/main/screenshot/quickbooksmedusa.png" width="1200">
</div>

<div align="center">

# quickbooks-sync-medusajs

**Sync Medusa.js orders, customers, and products with QuickBooks Online — in real time.**

[![npm version](https://img.shields.io/npm/v/quickbooks-sync-medusajs?style=flat-square)](https://www.npmjs.com/package/quickbooks-sync-medusajs)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg?style=flat-square)](LICENSE)
[![Medusa v2](https://img.shields.io/badge/Medusa-v2-blueviolet?style=flat-square)](https://medusajs.com)

</div>

---

## Features

| Feature | Description |
|---|---|
| 🛒 **Order Sync** | Sync Medusa orders to QuickBooks as Sales Receipts or Invoices |
| 👥 **Customer Sync** | Bidirectional customer sync between Medusa and QuickBooks |
| 📦 **Product Sync** | Push Medusa products to QuickBooks as Items, and pull QB Items back |
| 🔗 **OAuth 2.0** | Full QuickBooks OAuth 2.0 connect / disconnect flow |
| 🔔 **Webhooks** | Real-time webhook handler — QB → Medusa for customers and products |
| ⚡ **Event Subscribers** | Auto-sync on `customer.created`, `customer.updated`, `customer.deleted` |
| 🖥️ **Admin UI** | Built-in Admin dashboard widget and settings page |
| ♻️ **Reset / Re-sync** | Clear sync history and re-run a full sync at any time |

---

## Requirements

- Medusa v2 (2.x)
- Node.js ≥ 20
- A [QuickBooks Online](https://developer.intuit.com/) developer account with an app (OAuth 2.0)

---

## Installation

```bash
npm i quickbooks-sync-medusajs
```

---

## Configuration

### 1. Environment Variables

Add the following to your `.env` file:

```env
# QuickBooks OAuth 2.0 credentials (from your Intuit developer app)
QUICKBOOKS_CLIENT_ID=your_client_id
QUICKBOOKS_CLIENT_SECRET=your_client_secret

# Webhook verification (from your Intuit developer app → Webhooks section)
QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN=your_webhook_verifier_token

# Set to "sandbox" for development, "production" for live
QUICKBOOKS_ENVIRONMENT=sandbox

# Your Medusa backend public URL (used to build the OAuth callback URL)
MEDUSA_BACKEND_URL=https://your-medusa-backend.com
```

### 2. Register the Plugin in `medusa-config.ts`

```ts
// medusa-config.ts
import { defineConfig } from "@medusajs/framework/utils"

export default defineConfig({
  plugins: [
    {
      resolve: "quickbooks-sync-medusajs",
      options: {
        // No additional options required — all config is via environment variables
      },
    },
  ],
})
```

### 3. Run Migrations

The plugin creates its own database tables to track sync state (connection tokens, customer links, order links). Run migrations after installation:

```bash
npx medusa db:migrate
```

---

## OAuth Setup (Connect to QuickBooks)

### Setting Up Your Intuit App

1. Go to [Intuit Developer Portal](https://developer.intuit.com/app/developer/dashboard)
2. Create a new app → select **QuickBooks Online and Payments**
3. Under **Keys & OAuth**, copy your **Client ID** and **Client Secret** into `.env`
4. Add the following **Redirect URI** to your app:

```
https://your-medusa-backend.com/admin/quickbooks/callback
```

> For local development use: `http://localhost:9000/admin/quickbooks/callback`

### Connecting via the Admin Dashboard

Once the plugin is installed and your env vars are set:

1. Open your Medusa Admin → **Settings → QuickBooks**
2. Click **Connect to QuickBooks**
3. Complete the Intuit OAuth flow
4. Select your **Income Account** for product mapping
5. Done — the plugin will begin syncing automatically

---

## Webhook Setup

Webhooks allow QuickBooks to push changes (new/updated customers, products) to Medusa in real time.

### Webhook Endpoint

```
POST https://your-medusa-backend.com/quickbooks/webhooks
```

### Registering the Webhook in Intuit

1. Go to your app in the [Intuit Developer Portal](https://developer.intuit.com/app/developer/dashboard)
2. Navigate to **Webhooks** → **Add Endpoint**
3. Enter the webhook URL above
4. Select the following entities:

| Entity | Events |
|---|---|
| **Customer** | Create, Update, Delete |
| **Item** | Create, Update |

5. Copy the **Verifier Token** shown and add it to your `.env`:

```env
QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN=your_verifier_token
```

> The plugin verifies the `Intuit-Signature` header on every incoming webhook request. Invalid signatures are rejected with a `401`.

### What Webhooks Handle

| QB Entity | Operation | Medusa Action |
|---|---|---|
| `Customer` | Create / Update | Upsert customer in Medusa |
| `Customer` | Delete | Remove customer from Medusa |
| `Item` | Create / Update | Upsert product in Medusa |

---

## Sync Behaviour

### Orders

Medusa orders are synced to QuickBooks as **Sales Receipts** (paid) or **Invoices** (unpaid). The plugin maps:

- Line items → QB line items with quantity and unit price
- Tax → `TxnTaxDetail` / native QB tax codes
- Customer → linked QB customer record
- Shipping → separate line item

### Customers

Bidirectional sync. You can push all Medusa customers to QuickBooks, pull all QB customers into Medusa, or let the event subscribers handle it automatically on create/update/delete.

### Products

Medusa products / variants are synced to QuickBooks as **Items** (type: `Service` or `NonInventory`). You must select an **Income Account** in the QuickBooks settings after connecting.

---

## Admin UI

The plugin ships with:

- A **Settings page** at `/app/settings/quickbooks` — connect/disconnect, view connection status, configure income account
- A **Dashboard widget** — quick overview of sync status

No additional setup is needed; the admin extensions are bundled automatically.

---

## API Reference

All endpoints are under `/admin/quickbooks` and require an authenticated Medusa admin session.

### Connection

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/admin/quickbooks/connect` | Get OAuth authorization URL |
| `GET` | `/admin/quickbooks/callback` | OAuth callback (redirect from Intuit) |
| `POST` | `/admin/quickbooks/disconnect` | Disconnect QuickBooks |
| `GET` | `/admin/quickbooks/status` | Connection status and token info |
| `GET` | `/admin/quickbooks/company` | Fetch connected QB company info |

### Sync

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/admin/quickbooks/orders/sync` | Sync one, many, or all orders |
| `GET` | `/admin/quickbooks/orders/status` | Order sync status |
| `POST` | `/admin/quickbooks/customers/sync` | Sync customers (bidirectional) |
| `GET` | `/admin/quickbooks/customers/status` | Customer sync status |
| `POST` | `/admin/quickbooks/products/sync` | Sync one, many, or all products |
| `GET` | `/admin/quickbooks/products/status` | Product sync status |
| `POST` | `/admin/quickbooks/products/:productId/sync` | Sync a single product by ID |

### Settings & Utilities

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/admin/quickbooks/settings` | Set income account for product mapping |
| `POST` | `/admin/quickbooks/reset` | Clear sync history (`orders`, `customers`, or `all`) |

### Webhooks (Public)

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/quickbooks/webhooks` | Receive real-time events from QuickBooks |

---

### Order Sync Body

```json
// Sync specific orders
{ "order_ids": ["ord_01...", "ord_02..."] }

// Sync all completed orders
{ "sync_all": true }
```

### Customer Sync Body

```json
// QuickBooks → Medusa (default)
{ "direction": "quickbooks_to_medusa" }

// Medusa → QuickBooks
{ "direction": "medusa_to_quickbooks" }
```

### Product Sync Body

```json
// Sync specific products
{ "product_ids": ["prod_01...", "prod_02..."] }

// Sync all products
{ "sync_all": true }
```

### Reset Body

```json
// Clear order sync history
{ "type": "orders" }

// Clear customer sync history
{ "type": "customers" }

// Clear everything
{ "type": "all" }
```

---

## Event Subscribers

The plugin automatically listens to the following Medusa events and syncs to QuickBooks without any additional setup:

| Event | Action |
|---|---|
| `customer.created` | Create customer in QuickBooks |
| `customer.updated` | Update customer in QuickBooks |
| `customer.deleted` | Delete/deactivate customer in QuickBooks |

---

## License

MIT © [luckycrm](https://github.com/luckycrm)
