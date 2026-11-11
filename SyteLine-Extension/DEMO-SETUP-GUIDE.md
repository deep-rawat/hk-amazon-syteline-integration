# Amazon → SyteLine Demo: Setup Guide (SyteLine only)

Everything is shown inside SyteLine. Orders and payments are pulled from the mock server
(`http://18.206.166.241:9001`) when you click **Sync Now**.

## What the demo shows

| Where | What you see |
|---|---|
| **Amazon Integration** form (new) | Sync Now button, plus a log of every order and payment that was synced |
| **HubKor customer order** form (existing) | The staged Amazon orders (webstore = AMAZON) with their lines and payment fields |
| **HubKor AR Payments** form (existing) | One payment per Amazon transaction, with Source Order Id, Order Number, Amount, Fee and Net |

How the pieces connect:

```
Mock server (orders + finances)
      │  Sync Now (ue_HK_SyncAmazonOrders, max 10 orders per click)
      ▼
ue_hk_co_mst / ue_hk_coitem_mst           ← order + lines     (HubKor customer order form)
ue_hk_ArpmtExternal / ue_hk_ArpmtdExternal ← payment + grid row (HubKor AR Payments form)
ue_hk_amazon_integration_log               ← one new row for every order/payment, every sync
```

The sync code already writes all of the above. You only need to create the log table, its IDO and the form,
then deploy the code.

---

## Part A. Create the log table `ue_hk_amazon_integration_log`

A new row is added on every sync, even for the same order (this is why the log has its own key).

1. Open the form **Sql Tables**. Click **New**.
2. Table Name: `ue_hk_amazon_integration_log`. Description: `Amazon integration log`.
3. Open **Sql Columns** for this table and add the columns below. Make the **LogId** column the primary key.

| Column | Type | Length | Null | Notes |
|---|---|---|---|---|
| LogId | nvarchar | 36 | No | Primary key (the code sends a GUID) |
| RunId | nvarchar | 36 | No | Groups all rows from one Sync Now click |
| ConfigId | nvarchar | 30 | Yes | |
| RecordType | nvarchar | 10 | No | `Order` or `Payment` |
| AmazonOrderId | nvarchar | 40 | Yes | |
| TransactionId | nvarchar | 100 | Yes | |
| FinancialEventGroupId | nvarchar | 40 | Yes | |
| Amount | decimal | 19,4 | Yes | |
| Status | nvarchar | 20 | No | Synced / Skipped / Warning / Error |
| CoNum | nvarchar | 10 | Yes | Staged HubKor order number |
| Message | nvarchar | 1000 | Yes | |
| RawJson | nvarchar | max | Yes | |
| CreatedAt | datetime | | No | |

4. Add the standard system columns. The easiest way is to open the existing table `ue_hk_amazon_order_log`
   in **Sql Columns** and copy its system columns (`RowPointer`, `CreatedBy`, `UpdatedBy`, `CreateDate`,
   `RecordDate`, `NoteExistsFlag`, `InWorkflow`). Use the same types and defaults.
5. Click **Update Current Table** to create it in the database.
   Check: run `SELECT count(1) FROM ue_hk_amazon_integration_log` (it should return 0).

## Part B. Create the IDO `ue_hk_amazon_integration_logs`

1. Open **IDOs** (or the **IDO Wizard**). Create a new IDO named `ue_hk_amazon_integration_logs`.
2. On the **Tables** tab add `ue_hk_amazon_integration_log` (alias `ail`).
3. On the **Properties** tab add one property per column. **The property names must be exactly the column names**
   (`LogId`, `RunId`, `ConfigId`, `RecordType`, `AmazonOrderId`, `TransactionId`, `FinancialEventGroupId`,
   `Amount`, `Status`, `CoNum`, `Message`, `RawJson`, `CreatedAt`), plus the system properties
   (`RowPointer`, `CreatedBy`, `UpdatedBy`, `CreateDate`, `RecordDate`, `NoteExistsFlag`, `InWorkflow`).
4. Check the IDO in and wait a few minutes (metadata cache).
5. Tell me when it is done. I will verify it through the API.

## Part C. Deploy the new code

1. Open the IDO `ue_HK_AmazonConfigs` (the one that holds the sync method).
2. Replace the extension class source with the full contents of
   `SyteLine-Extension/dist/HubKor.AmazonSync.AllInOne.cs`.
3. Build the assembly (**Build From Source**) and check in. Wait a few minutes for the cache.

I have already pointed the config row `DEFAULT` at the mock server. Nothing else is needed.

## Part D. First test (before building the form)

1. Open the **HubKor customer order** form and note how many AMAZON orders exist now.
2. Ask me to run the sync once through the API. I will check:
   - 10 staged orders (webstore = AMAZON) with lines in the HubKor order form,
   - 10 payments in the HubKor AR Payments form,
   - log rows in `ue_hk_amazon_integration_logs`.

## Part E. Build the form `ue_HK_AmazonIntegration`

Go slowly here. If a menu looks different on your SyteLine version, send a screenshot and I will adjust the steps.

1. Open **Forms**, then the form designer: **New** → **Form Wizard** (category **Classic**, **Detail-Only**).
2. Form name: `ue_HK_AmazonIntegration`. Title: `Amazon Integration`.
3. Primary collection: `ue_hk_amazon_integration_logs`.
4. Add the log columns as grid columns, in this order:
   `CreatedAt`, `RecordType`, `Status`, `AmazonOrderId`, `CoNum`, `Amount`, `TransactionId`, `Message`.
   Leave `RawJson` and `LogId` out (or add `RawJson` on a detail pane).
5. In the grid properties:
   - **Order By**: `CreatedAt DESC`
   - **Record Cap**: 200
   - Make every column **Read Only**.
6. Add three tabs with a **NoteBook** from the Toolbox, named *All Activity*, *Orders*, *Payments*:
   - All Activity: no filter.
   - Orders: Initial Filter `RecordType = 'Order'`.
   - Payments: Initial Filter `RecordType = 'Payment'`.
   Each tab has its own grid on the same collection.
7. Add a **Button** named `SyncNowButton`, caption **Sync Now**:
   - **Event**: Click → invoke IDO method `ue_HK_AmazonConfigs.ue_HK_SyncAmazonOrders`
     with parameters `ConfigId = DEFAULT` and `Infobar` (output).
   - After it runs: show the Infobar text in the status bar, then refresh all grids.
8. Add a second button **Open Orders** that opens the HubKor customer order form, and a third button
   **Open Payments** that opens the HubKor AR Payments form.
9. Optional: color the Status cell (Synced = green, Skipped = grey, Warning = amber, Error = red).
10. Save the form, then preview (**Run**). Add it to a menu if you want a shortcut.

## Demo script

1. Open **Amazon Integration**. The log is empty or old.
2. Click **Sync Now**. The status line says something like
   *"Amazon sync finished: 10 orders staged, 0 skipped, 0 errors, 0 warnings; 10 payments recorded. Limit of 10 orders per run reached; click Sync Now again."*
   Show the **Orders** and **Payments** tabs.
3. Open **Open Orders**. Show an Amazon order with its lines, amounts and payment fields.
4. Open **Open Payments**. Show the payment, and its grid row: Source Order Id, Order Number, Amount, Fee, Net.
5. Go back and click **Sync Now** again. It picks up the next 10 orders.
6. To show that a repeated sync is logged again, I reset the sync date before the demo.
   The next click re-reads the first orders, logs them as *Skipped (already staged)*,
   and adds new log rows (the old rows are kept).

## Notes and limits

- Mock server items (`DEMO-SKU-10xx`) do not exist in SyteLine. The orders still stage; each unmapped item gives a Warning log row.
- The order → real SyteLine customer order step (HubKor "transformation") is not part of this demo.
- Payment amount on the AR Payments form is the Amazon amount **net of fees**. Amount = order total, Fee = difference, Net = payment.
  `A/R Payment Created` stays unchecked, so nothing posts to A/R.
- The mock server only returns data for the dates it holds; the first sync reads the last 150 days.
