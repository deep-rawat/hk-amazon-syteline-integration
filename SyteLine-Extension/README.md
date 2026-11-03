# HubKor Amazon → SyteLine order sync (Mongoose extension, no middleware)

SyteLine pulls orders straight from Amazon SP-API and creates customer orders. Everything runs inside
the CloudSuite Industrial (Mongoose) tenant: an IDO extension class, two custom tables, one form and
a scheduled task.

```
SyteLine (Mongoose)
 ├─ Form "HubKor Amazon Integration"  ── [Sync Now] ─┐
 ├─ Scheduled task (every 15 min) ───────────────────┤
 │                                                   ▼
 │   ue_HK_AmazonConfigs.ue_HK_SyncAmazonOrders  (HubKor.AmazonSync.dll)
 │     1. retry earlier errors from the log
 │     2. LWA token → GET /orders/2026-01-01/orders?lastUpdatedAfter=…
 │     3. SKU → Item (Customer Items, then Item = SKU)
 │     4. SLCos insert (CustPo = Amazon order id) + SLCoitems inserts
 │     5. write ue_hk_amazon_order_log, move the watermark
 └─ Tables: ue_hk_amazon_config, ue_hk_amazon_order_log
```

> **Check with Infor first:** confirm that IDO extension classes in your cloud tenant may make
> outbound HTTPS calls to `api.amazon.com` and `sellingpartnerapi-*.amazon.com`. If not, register
> SP-API as an API suite in ION API Gateway and change `AmazonSpApiClient` to call through ION.

## Files

| File | Purpose |
|---|---|
| `src/AmazonSyncExt.cs` | IDO extension class: sync run, order mapping, CO creation, logging |
| `src/AmazonSpApiClient.cs` | LWA token + Orders API calls (pagination, 429 retry) |
| `src/AmazonConfig.cs` | Config row model |
| `src/Json.cs` | JSON helpers (no third-party DLLs) |
| `demo/mock-orders.json` | Demo orders for the mock server: 2 good, 1 unmapped SKU, 1 pending |

## Setup

### 1. Custom tables (Application Schema → Tables)

**ue_hk_amazon_config**

| Column | Type | Notes |
|---|---|---|
| ConfigId | nvarchar(20), key | `DEFAULT` |
| Active | tinyint | 1 |
| BaseUrl | nvarchar(200) | sandbox / production / mock URL |
| ClientId | nvarchar(200) | blank = no auth (mock demo) |
| ClientSecret | nvarchar(500) | secret: restrict access |
| RefreshToken | nvarchar(1000) | secret: restrict access |
| MarketplaceId | nvarchar(20) | `ATVPDKIKX0DER` = amazon.com |
| FulfilledBy | nvarchar(10) | `AMAZON` (FBA), `MERCHANT` (FBM), blank = both |
| QueryOverride | nvarchar(1000) | only for Amazon's static sandbox |
| CustNum | nvarchar(7) | e.g. `AMAZONU` (max 7 chars) |
| CustSeq | int | 0 |
| Whse | nvarchar(4) | e.g. `MAIN` |
| CoStat | nchar(1) | `O` Ordered (or `P` Planned) |
| CoPrefix | nvarchar(5) | `AMZ` → CO numbers `AMZ0000001` |
| NextCoSeq | int | 1 |
| LastSyncUtc | datetime | leave empty for first run |
| LookbackDays | int | 7 |

**ue_hk_amazon_order_log**

| Column | Type |
|---|---|
| AmazonOrderId | nvarchar(30), key |
| CreatedTimeUtc | datetime |
| AmazonStatus | nvarchar(30) |
| SyncStatus | nvarchar(10) (`Synced` / `Error` / `Skipped` / `Warning`) |
| CoNum | nvarchar(10) |
| Message | nvarchar(1000) |
| LineCount | int |
| OrderTotal | decimal(18,4) |
| Currency | nvarchar(3) |
| Attempts | int |
| LastAttempt | datetime |
| RawJson | nvarchar(max) |

### 2. IDOs (IDO wizard)
Generate `ue_HK_AmazonConfigs` and `ue_HK_AmazonOrderLogs` from the two tables. Property names must
match the column names (the wizard does this by default).

### 3. Build the assembly in SyteLine (Build From Source)
1. Run `python tools/make_allinone.py`. It combines `src/*.cs` into
   `dist/HubKor.AmazonSync.AllInOne.cs`.
2. In SyteLine, open **IDO Extension Class Assemblies** and create a record:
   - Assembly Name: `ue_HubKor.AmazonSync`
   - Assembly Type: `Build From Source`
   - Language: `C#`
   - References:
     `System.dll, System.Data.dll, IDOCore.dll, IDOBase.dll, IDOProtocol.dll, MGShared.dll, WSEnums.dll`
3. Paste the all-in-one file under **Source Code**, then click **Build Assembly** and **Check In**.
   The code is written in C# 5 syntax because the server compiler may be old, and it needs no
   third-party DLLs.
4. In **IDOs**, open `ue_HK_AmazonConfigs` (check it out), set Ext Class Assembly =
   `ue_HubKor.AmazonSync` and Ext Class = `HubKor.AmazonSync.AmazonSyncExt`. Add the method
   `ue_HK_SyncAmazonOrders` (parameters `ConfigId` input, `Infobar` input/output). Check it in.

### 4. Form (Form Designer)
Create the form **HubKor Amazon Integration**:
- Top: the config fields bound to `ue_HK_AmazonConfigs`. Mask the secrets.
- Grid: `ue_HK_AmazonOrderLogs`, newest first, with columns AmazonOrderId, AmazonStatus,
  SyncStatus, CoNum, Message and LastAttempt.
- Button **Sync Now**: event handler that calls the IDO method `ue_HK_SyncAmazonOrders` with
  `ConfigId` = `DEFAULT`, shows the returned Infobar, and refreshes the grid.

Give the form a security group so only admins can see the credentials.

### 5. Schedule
Create a background task or event that calls `ue_HK_SyncAmazonOrders('DEFAULT')` every 15 minutes.
Which option exists (Background Task Definitions, or a timed Event Handler) depends on your
Mongoose version.

### 6. SyteLine master data
- Amazon US customer, e.g. number `AMAZONU` and name "Amazon.com". SyteLine customer numbers are
  max 7 chars, and this must match `CustNum`. Use currency USD, with
  the terms you want and a tax code that adds no sales tax (Amazon collects it as marketplace
  facilitator).
- Items `DEMO-001`, `DEMO-002` and `DEMO-003`. Alternatively, keep your own item numbers and map
  each SKU under **Customer Items** for the Amazon customer (Customer Item = Amazon SellerSKU).

## Run modes (config row)

| Mode | BaseUrl | ClientId / Secret / Token | QueryOverride |
|---|---|---|---|
| **Demo** (mock orders) | your Postman mock server URL | blank | blank |
| **Amazon sandbox** | `https://sandbox.sellingpartnerapi-eu.amazon.com` | sandbox LWA creds | the exact canned query from collection request *SANDBOX - 2.4* (after `?`) |
| **Production** | `https://sellingpartnerapi-na.amazon.com` | client's LWA creds | blank |

For Demo mode, set the Postman mock server's example for `GET /orders/2026-01-01/orders` to
`demo/mock-orders.json`. The mock ignores query strings, so match on path only.

## Demo script (all in the SyteLine UI)
1. Open **HubKor Amazon Integration** and click **Sync Now**.
   - Result: "2 created, 1 errors, 1 skipped". The pending order is skipped, and SKU
     `NOT-IN-SYTELINE-999` is rejected.
2. Open **Customer Orders**, filter Customer PO = `113-4100001-0000001`, and show the header and
   both lines.
3. Error handling: create item `NOT-IN-SYTELINE-999` (or a Customer Item mapping), click
   **Sync Now** again, and the order that failed is now created from the log.
4. No duplicates: click **Sync Now** again, and nothing new is created.

## What it does / doesn't do (phase 1)
- Creates one CO per Amazon order, with Amazon order id in **CustPo**. Duplicates are blocked by
  checking CustPo for the Amazon customer.
- Rejects an order with any unmapped SKU as a whole, and retries it automatically (up to 10
  attempts) once the mapping exists.
- Skips `PENDING` and `UNFULFILLABLE` orders. They come back when Amazon updates them.
- Marks an order cancelled after sync as **Warning**. It does not cancel the CO automatically.
- Does not handle shipping charges, promotions, gift wrap, or FBA shipment/invoicing. These are
  planned for later phases.

## Verify before go-live
The assembly now compiles in the TST tenant. That confirms the Mongoose API calls are valid, but
the sync hasn't been run yet. Check:
- SLCos / SLCoitems property names: `CustPo`, `QtyOrderedConv`, `PriceConv`, `DueDate`,
  `CoRelease`. Check them in the IDOs form, or by creating one CO in the UI first.
- CO numbering: the `AMZ0000001` scheme must not clash with your tenant's CO prefixes.
- The Orders API 2026-01-01 response fields. The collection sample was a mock, so compare it with
  Amazon's official model (`fulfillment.fulfillmentStatus` values, `pagination.nextToken`).
