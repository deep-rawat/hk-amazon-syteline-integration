# Amazon → SyteLine: step-by-step implementation guide

For someone new to SyteLine. Do the steps in order and tick each box. Every step ends with a
**✅ Check**: don't move on until it passes.

> **Form names vary between SyteLine versions.** To open a form, use the **search box at the top
> of SyteLine** (or *Explorer → Master Explorer*) and type the form name. If a name in this guide
> isn't found, search a keyword (e.g. "IDO", "SQL", "Assembly") and pick the closest match. If
> you get stuck, send a screenshot.

---

## Part 0: Prepare (1 day)

### Step 0.1: Use the TEST environment
Cloud SyteLine usually has several environments (e.g. `..._TST`, `..._TRN`, `..._PRD`). **Do all of
this work in TST.** Never customize PRD directly.

- [ ] Log in to SyteLine and note the environment name on the screen and in the URL.
- [ ] Note the **site** you're in (top bar, e.g. `MAIN` or `OH`).

✅ Check: you're in a non-production environment and know the site name.

### Step 0.2: Check your permissions
You need developer/administrator rights. Try opening each form below. If one opens, you have
access to it.

| Form | Needed for |
|---|---|
| Customers | Amazon customer |
| Items | Demo items |
| Customer Orders | Testing orders |
| IDOs | Seeing field names, adding the method |
| SQL Tables (or "Application Schema Tables") | Creating 2 custom tables |
| IDO Extension Class Assemblies | Uploading the DLL |
| Background Task Definitions | Scheduling |
| Design Mode (in the form's menu: *Actions / Design* or a pencil icon) | Building the form |

- [ ] Write down which forms do **not** open. Ask your SyteLine administrator (or Infor) to add
  your user to a developer/admin authorization group (often "SystemAdministrator" or a
  "Mongoose developer" group).

✅ Check: all forms open.

### Step 0.3: Ask Infor one question (start now, the reply takes time)
Open a ticket on the Infor Support Portal (or ask your Infor partner):

> "In our CloudSuite Industrial cloud tenant, can an IDO extension class assembly make outbound
> HTTPS calls to external internet APIs (api.amazon.com, sellingpartnerapi-na.amazon.com)?
> If not, what's the supported approach: calling external APIs through ION API Gateway?"

*(No need to ask for the Mongoose DLLs: SyteLine builds the code itself, see Part 6.)*

- [ ] Ticket raised. Write down your SyteLine version (Help → About).

### Step 0.4: Install tools on your PC
- [ ] **VS Code** (or any editor) to open and copy the code file. Visual Studio is only needed
  for the fallback in Part 6.
- [ ] **Postman**, used only behind the scenes for the mock server and testing.

---

## Part 1: Learn SyteLine by creating one order by hand (1–2 hours)

The integration does exactly what you're about to do by hand. Doing it once teaches you what
SyteLine needs.

### Step 1.1: Look at an existing customer
- [ ] Open the **Customers** form. Press **F4** (or the filter/search button) to list records.
  Open any customer.
- [ ] Note these fields: **Customer** (number), **Name**, **Currency**, **Terms**, **Tax Code**,
  **Warehouse**, **Ship To** = 0.
  - Customer numbers in SyteLine are **at most 7 characters**.

### Step 1.2: Look at an existing item
- [ ] Open **Items** and open any item. Note **Item**, **Description**, **U/M** (unit of measure),
  **Product Code**, **Type** (Material) and **Source** (Purchased / Manufactured).

### Step 1.3: Create a test customer order by hand
- [ ] Open **Customer Orders** and click **New**.
- [ ] Fill in **Customer** with an existing customer number, then **Customer PO** = `TEST-HAND-001`.
  Leave **Order** (the CO number) as SyteLine fills it, and note **Status** and **Warehouse**.
- [ ] Save.
- [ ] Click **Lines** (or open **Customer Order Lines**), add a line with an item, quantity 1 and a
  price, then save.

✅ Check: you have a CO with a line. **Write down every field SyteLine forced you to fill**, and
the CO number format it generated (e.g. `0000001234` or `C000001234`). You'll need both in
Part 3.

---

## Part 2: Master data for Amazon (30 minutes)

> **Status: ✅ done via the ION API on 2026-11-01, site DALS** (configuration `QUADKOR_AX1_DALS`):
> - Customer `AMAZONU` "Amazon.com (US Marketplace) - HubKor Demo": USD, terms M36, tax code NT
>   (Tax Exempt), warehouse MAIN, salesperson GIB.
> - Items `DEMO-001`, `DEMO-002`, `DEMO-003`: UM EA, product code FG-100, Purchased.
> - Test order `AMZTEST001` (Customer PO `TEST-API-0001`) with 3 lines proves the API can create
>   orders. Delete it before the client demo.
> - Customer #54 "Amazon" already existed. We don't use it.
>
> Lesson learned: unlike the form, the API doesn't fill in defaults. The header needs
> `CurrCode`, `TermsCode`, `TaxCode1` and `Slsman`, and lines need `UM` and `Stat`. The code now
> copies them from the customer and item.

### Step 2.1: Create the Amazon customer
- [ ] **Customers → New**, then fill in:
  - Customer: `AMAZONU`
  - Name: `Amazon.com (US Marketplace)`
  - Currency: `USD`
  - Terms: copy them from an existing customer (Amazon pays every ~14 days)
  - Tax Code: a **non-taxable** code, because Amazon collects US sales tax itself
  - Fill in any other required fields like the customer you looked at in Step 1.1.
- [ ] Save.

### Step 2.2: Create three demo items
- [ ] **Items → New**: `DEMO-001` "Demo Widget Blue". Copy U/M, Product Code, Type and Source from
  an existing finished-goods item. Save.
- [ ] Repeat for `DEMO-002` "Demo Widget Red" and `DEMO-003` "Demo Gadget".
- [ ] **Do NOT** create `NOT-IN-SYTELINE-999`. The demo uses it to show error handling.

### Step 2.3 (optional): Customer Items mapping
This is how a real client maps Amazon SKUs that differ from SyteLine item numbers.
- [ ] Open **Customer Items**. Set Customer = `AMAZONU`, Item = `DEMO-003`, Customer Item =
  `AMZ-GADGET-01`. Save.

### Step 2.4: Make sure an order for this customer works
- [ ] Repeat Step 1.3 with customer `AMAZONU`, item `DEMO-001` and Customer PO `TEST-HAND-002`.

✅ Check: the order saves without errors. If SyteLine complains about a missing price, cost or
warehouse record, fix the item or customer setup now. The integration would fail the same way.

---

## Part 3: Confirm the field names the code uses (30 minutes)

> **Status: ✅ done via the ION API.** All properties used by the code exist on SLCos, SLCoitems,
> SLItems and SLCustomers. Customer numbers are stored right-justified (`"      2"`); the code
> handles that. CO number style `AMZ0000001` fits the existing pattern (e.g. `DC00001109`).

The code talks to SyteLine through **IDOs**, SyteLine's data objects. Each IDO has **properties**,
which are its field names. We confirm them now.

### Step 3.1: SLCos (customer order header)
- [ ] Open the **IDOs** form, filter IDO Name = `SLCos`, and open the **Properties** tab.
- [ ] Confirm these properties exist: `CoNum`, `CustNum`, `CustSeq`, `CustPo`, `OrderDate`, `Whse`,
  `Stat`.

### Step 3.2: SLCoitems (customer order lines)
- [ ] Same for `SLCoitems`: `CoNum`, `CoLine`, `CoRelease`, `Item`, `QtyOrderedConv`, `PriceConv`,
  `DueDate`, `Whse`.

### Step 3.3: Lookups
- [ ] `SLItems` has `Item`, `SLItemcusts` has `CustNum`, `CustItem` and `Item`, and `SLCustomers`
  has `CustNum` and `CustSeq`.

✅ Check: if any name is different or missing, write the correct name down and tell me. I'll
change the code.

### Step 3.4: CO number
- [ ] The code creates CO numbers like `AMZ0000001`. Compare that with the format from Step 1.3.
  If your CO numbers are numeric only, or `AMZ` is already used as a prefix, pick another prefix
  (e.g. `AZ`). Tell me if SyteLine rejects a letter prefix.

---

## Part 4: Create the two custom tables (1 hour)

Naming follows the existing HubKor custom tables in this tenant (e.g. `ue_hk_ap_auto_activitylog`):
lowercase `ue_hk_` table names, PascalCase column names, and no `_mst` / site column. The tables
hold integration data, not site-specific business data.

General rules for both tables:
- **Standard columns:** if the form offers "Add standard/audit columns", tick it. SyteLine needs
  `RowPointer`, `CreatedBy`, `UpdatedBy`, `CreateDate`, `RecordDate`, `NoteExistsFlag` and
  `InWorkflow` on every table. If you add them by hand, copy their types from an existing table
  such as `ue_hk_ap_auto_activitylog` in the same form.
- **Column names:** type them **exactly** as listed, including upper/lower case. The code uses
  these names.
- **Nullable:** every column except the primary key may be NULL.
- At the end, click the button that **creates the table in the database** (e.g. *Create Table* /
  *Commit* / *Generate*). Saving the form record alone may only save the definition.

### Step 4.1: Config table `ue_hk_amazon_config`

| Column | Data type | Length | Notes |
|---|---|---|---|
| ConfigId | nvarchar | 20 | **Primary key**, not null |
| Active | tinyint | | |
| BaseUrl | nvarchar | 200 | |
| ClientId | nvarchar | 200 | |
| ClientSecret | nvarchar | 500 | |
| RefreshToken | nvarchar | 1000 | |
| MarketplaceId | nvarchar | 20 | |
| FulfilledBy | nvarchar | 10 | |
| QueryOverride | nvarchar | 1000 | |
| CustNum | nvarchar | 7 | |
| CustSeq | int | | |
| Whse | nvarchar | 4 | |
| CoStat | nchar | 1 | |
| CoPrefix | nvarchar | 5 | |
| NextCoSeq | int | | |
| LastSyncUtc | datetime | | |
| LookbackDays | int | | |

### Step 4.2: Log table `ue_hk_amazon_order_log`

| Column | Data type | Length | Notes |
|---|---|---|---|
| AmazonOrderId | nvarchar | 30 | **Primary key**, not null |
| CreatedTimeUtc | datetime | | |
| AmazonStatus | nvarchar | 30 | |
| SyncStatus | nvarchar | 10 | |
| CoNum | nvarchar | 10 | |
| Message | nvarchar | 1000 | |
| LineCount | int | | |
| OrderTotal | decimal | 18,4 | |
| Currency | nvarchar | 3 | |
| Attempts | int | | |
| LastAttempt | datetime | | |
| RawJson | nvarchar | max | the form may write max as `-1` or `MAX` |

✅ Check: both tables appear in **SQL Tables** with all columns. Tell me when they're done, and I'll
verify them through the API.

---

## Part 5: Create IDOs for the tables (30 minutes)

### Step 5.1: Config IDO
The IDO names must be exactly these, because the code calls them by name. The table names are
only used here.

- [ ] In the **IDOs** form, use **New IDO wizard** (Actions menu), or search for an "IDO Wizard"
  form.
- [ ] Project: choose (or create) a custom project, e.g. `HK_Amazon`.
- [ ] IDO name: **`ue_HK_AmazonConfigs`**. Base table: `ue_hk_amazon_config`. Add **all columns**
  as properties and **keep the property names identical to the column names** (the wizard default).
- [ ] Finish, then **check in** the IDO (IDOs are checked out while you edit them).

### Step 5.2: Log IDO
- [ ] Same for **`ue_HK_AmazonOrderLogs`** on table `ue_hk_amazon_order_log`.

✅ Check: the IDOs form shows both IDOs with their properties. Tell me, and I'll test loading
them through the API.

---

## Part 6: Build the assembly inside SyteLine (30 minutes, no DLLs or Visual Studio needed)

SyteLine can compile C# code itself, using the **Build From Source** option. All the code is in
one file you paste: `dist/HubKor.AmazonSync.AllInOne.cs`.

> **Status: ✅ done.** Assembly `ue_HubKor.AmazonSync` was built successfully ("Assembly compiled
> and updated successfully").

### Step 6.1: Create the assembly record
- [ ] Open **IDO Extension Class Assemblies** and click **New** (✱ icon).
- [ ] Fill in only these fields; leave everything else empty, SyteLine fills it:

  | Field | Value |
  |---|---|
  | Assembly Name | `ue_HubKor.AmazonSync` (custom objects use the `ue_` prefix) |
  | Assembly Type | `Build From Source` |
  | Language | `C#` |
  | References | `System.dll, System.Data.dll, IDOCore.dll, IDOBase.dll, IDOProtocol.dll, MGShared.dll, WSEnums.dll` |

- [ ] Save (Ctrl+S or the disk icon).

✅ Check: **Locked By** shows your user (the record is checked out to you) and the buttons on the
right become active.

> **If Save, New and all the buttons stay greyed out**, your user has no edit rights on
> developer forms. Ask the SyteLine administrator to give your user developer/metadata edit
> rights in TST (see Step 0.2).

### Step 6.2: Paste the source code
- [ ] Click **Source Code**. An editor window opens.
- [ ] In VS Code, open `dist/HubKor.AmazonSync.AllInOne.cs`, press **Ctrl+A**, **Ctrl+C**.
- [ ] In the SyteLine editor, press **Ctrl+A** (to clear it), **Ctrl+V**, then save/close the
  editor and save the form.

### Step 6.3: Build
- [ ] Click **Build Assembly**.

✅ Check: the message **"Assembly compiled and updated successfully."**

Build errors we hit, and their fixes:

| Error | Cause | Fix |
|---|---|---|
| `The type or namespace name 'Net' does not exist in the namespace 'System'`, `'Uri' does not exist`, `'HttpWebRequest' could not be found` | `System.dll` not referenced | Add `System.dll` to References |
| `The type 'DataRow' is defined in an assembly that is not referenced … System.Data` | Mongoose's `IDOUpdateItem` has an overload that uses `DataRow` | Add `System.Data.dll` to References |
| Any other `You must add a reference to assembly 'X'` | Same pattern | Add `X.dll` to References |
| Compile errors in the code itself | Code problem | Send the full error list; the code gets fixed in `src/`, regenerated with `python tools/make_allinone.py`, and pasted again |

### Step 6.4: Check in
- [ ] Click **Check In**.
- [ ] If the message *"Source control integration is currently disabled in the current
  configuration. The item will not be checked in to source control."* appears, click **OK**.
  That's normal and only informational: your tenant doesn't use Infor's optional source control
  (a version history system). The check-in still completes and releases your lock.

✅ Check: **Locked By** is empty and **Revision Num** is filled in.

> **When the code changes later:** click **Source Code**, paste the new
> `dist/HubKor.AmazonSync.AllInOne.cs` (regenerate it first with `python tools/make_allinone.py`),
> save, **Build Assembly**, then **Check In** again.

> **Fallback (only if your form has no "Build From Source"):** build the DLL in Visual Studio with
> `HubKor.AmazonSync.csproj`. That needs the Mongoose DLLs in `lib\`. Ask Infor support for the
> "Mongoose IDO extension class development references" for your version, or copy them from a
> SyteLine Windows client / on-prem install folder. Then use **Import Assembly** in the same form.

---

## Part 7: Connect the assembly to the IDO (30 minutes)

### Step 7.1: Attach it to the config IDO
- [ ] In **IDOs**, open `ue_HK_AmazonConfigs` and **check it out**.
- [ ] Set **Extension Class Assembly** = `ue_HubKor.AmazonSync` (the name from Part 6) and
  **Extension Class** = `HubKor.AmazonSync.AmazonSyncExt` (namespace + class name inside the code).
- [ ] Go to the **Methods** tab and add method `ue_HK_SyncAmazonOrders`:
  - Type: custom assembly / standard method
  - Parameter 1: `ConfigId`, input, string
  - Parameter 2: `Infobar`, input/output, string
- [ ] Save, then **check in**.

✅ Check: the method appears on the IDO. If the assembly doesn't load, write down the exact
error. A typical cause is a .NET version mismatch.

---

## Part 8: Configure and run the first test (1 hour)

### Step 8.1: Prepare the mock server (internal only, the client never sees it)
- [ ] In Postman, open your mock collection. Open the request that the mock server uses
  (`Mock 3 order request`). Edit its saved **Example** response and paste the content of
  `demo/mock-orders.json` as the body. Set status 200 and the header
  `Content-Type: application/json`. Save.
- [ ] Send `GET https://2b904d08-70bc-472e-a150-fcaf96eda99f.mock.pstmn.io/orders/2026-01-01/orders`
  in Postman or a browser.

✅ Check: you see the 4 demo orders.

### Step 8.2: Insert the config row
There's no form yet, so either use a generic data form if your version has one, or build the
form in Part 9 first and come back. The values:

| Field | Value |
|---|---|
| ConfigId | `DEFAULT` |
| Active | `1` |
| BaseUrl | `https://2b904d08-70bc-472e-a150-fcaf96eda99f.mock.pstmn.io` |
| ClientId / ClientSecret / RefreshToken | *(blank for demo mode)* |
| MarketplaceId | `ATVPDKIKX0DER` |
| FulfilledBy | *(blank)* |
| CustNum | `AMAZONU` |
| CustSeq | `0` |
| Whse | `MAIN` |
| CoStat | `O` |
| CoPrefix | `AMZ` (or what you chose in 3.4) |
| NextCoSeq | `1` |
| LookbackDays | `7` |

### Step 8.3: Run the method once
- [ ] Easiest is the **Sync Now** button from Part 9. Alternatively, call the IDO method through
  the ION API from Postman. That needs an `.ionapi` file, which I can help you set up.

✅ Check: the Infobar message says **"2 created, 1 errors, 1 skipped, 0 warnings"**:
- **Customer Orders**, filtered on Customer PO `113-4100001-0000001`, shows AMZ0000001 with 2
  lines (DEMO-001 ×2 and DEMO-002 ×1 at 49.99).
- `113-4100002-0000002` exists with DEMO-003.
- The log shows `113-4100003-0000003` as Error ("SKU not mapped: NOT-IN-SYTELINE-999").
- The log shows `113-4100004-0000004` as Skipped (pending).

---

## Part 9: Build the "HubKor Amazon Integration" form (2–3 hours)

- [ ] Open **Design Mode** (Form Designer) and create a **new form** `ue_HK_AmazonIntegration`,
  caption "HubKor Amazon Integration".
- [ ] **Primary collection**: IDO `ue_HK_AmazonConfigs`. Add edit fields for BaseUrl, ClientId,
  ClientSecret (set it as a password/masked field), RefreshToken (masked), MarketplaceId,
  FulfilledBy, CustNum, Whse, CoPrefix, NextCoSeq and LastSyncUtc.
- [ ] **Grid**: add a grid bound to a second collection, IDO `ue_HK_AmazonOrderLogs`.
  - Columns: AmazonOrderId, AmazonStatus, SyncStatus, CoNum, Message, LastAttempt.
  - Order by `LastAttempt DESC`.
- [ ] **Button "Sync Now"**: add a button and give it an event handler with these actions:
  1. Response type **Method Call** on IDO `ue_HK_AmazonConfigs`, method
     `ue_HK_SyncAmazonOrders`, parameters `ConfigId` = the ConfigId field and `Infobar` = a
     variable.
  2. Show the Infobar message.
  3. Refresh the log grid collection.
- [ ] Save the form, add it to Explorer (or a menu), and set security so only admins can open it.

✅ Check: open the form, click **Sync Now**, and the grid fills with the log rows.

---

## Part 10: Schedule it every 15 minutes (30 minutes)

- [ ] Open **Background Task Definitions** and create a task `HK_AMAZON_SYNC` that calls the IDO
  method `ue_HK_AmazonConfigs.ue_HK_SyncAmazonOrders` with parameter `DEFAULT`. If your version
  can't call a method from a task, tell me. The alternative is a timed Event Handler.
- [ ] Schedule it to recur every 15 minutes.

✅ Check: the log's LastAttempt times update without anyone clicking.
*For the demo, the button alone is enough. You can do this part after the demo.*

---

## Part 11: Rehearse the client demo

1. **Reset**: delete the demo COs and log rows from the earlier test, set `NextCoSeq` = 1, and
   clear `LastSyncUtc`.
2. Open **HubKor Amazon Integration** and click **Sync Now**.
   - Say: "SyteLine just pulled the new Amazon orders."
3. Open **Customer Orders**, search Customer PO = Amazon order number, and show the header, then
   the lines.
4. Back in the grid, show the order with the unknown SKU.
   - Say: "Bad data never creates bad orders."
5. Create item `NOT-IN-SYTELINE-999` and click **Sync Now** again. The order is now created.
6. Click **Sync Now** once more and nothing duplicates.
   - Say: "Safe to run every 15 minutes."
7. Close with: "In production this runs automatically every 15 minutes against your Seller
   Central account once you authorize our app. No extra servers."

---

## When you get stuck
Send me:
- the step number
- a screenshot
- the exact error text

I'll tell you what to change. If the code has to change, I'll update it in the repo.
