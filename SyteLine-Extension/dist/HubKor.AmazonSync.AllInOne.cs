// AUTO-GENERATED from src/*.cs for SyteLine 'Build From Source'. Edit src/, then run tools/make_allinone.py.
using Mongoose.IDO.Protocol;
using Mongoose.IDO;
using System.Collections.Generic;
using System.Collections;
using System.Globalization;
using System.IO;
using System.Net;
using System.Text.RegularExpressions;
using System.Text;
using System.Threading;
using System;

namespace HubKor.AmazonSync
{
    // ===== src/AmazonSyncExt.cs =====
    /// <summary>
    /// IDO extension class attached to the ue_HK_AmazonConfigs IDO.
    /// Pulls orders and payments from the Amazon SP-API (or the mock server) and stages them in the
    /// HubKor customer order tables (ue_hk_co_msts / ue_hk_coitem_msts). Every order and payment seen
    /// in a run gets a new row in the ue_HK_AmazonIntegrationLogs IDO.
    ///
    /// Methods exposed to Mongoose:
    ///   ue_HK_SyncAmazonOrders(ConfigId, ref Infobar)   - full sync run (form button + scheduled task)
    /// </summary>
    [IDOExtensionClass("ue_HK_AmazonConfigs")]
    public class AmazonSyncExt : IDOExtensionClass
    {
        private const string ConfigIdo = "ue_HK_AmazonConfigs";
        private const string LogIdo = "ue_hk_amazon_integration_logs";
        private const string StageHeaderIdo = "ue_hk_co_msts";
        private const string StageLineIdo = "ue_hk_coitem_msts";
        private const string CustomerBillToIdo = "ue_hk_co_customers";
        private const string PaymentHeaderIdo = "ue_hk_ArpmtExternals";   // HubKor AR Payments form, top part
        private const string PaymentDetailIdo = "ue_hk_ArpmtdExternals";  // HubKor AR Payments form, grid
        private const string IdoDateFormat = "yyyyMMdd HH:mm:ss.fff";
        private const int CoNumLength = 10;

        // Orders fetched per Sync Now click; the next click continues where this one stopped. 0 = no limit.
        private const int MaxOrdersPerRun = 10;

        // Values HubKor's own staged Amazon test orders use; the customer record has none of these.
        private const string WebStore = "AMAZON";
        private const string TakenBy = "AZ";
        private const string DefaultShipCode = "FXG";
        private const string DefaultShipDescription = "FedEx Ground";
        private const string DefaultEndUserType = "RETDSL";
        private const string DefaultBankCode = "BK1";

        // Log statuses
        private const string Synced = "Synced";
        private const string Error = "Error";
        private const string Skipped = "Skipped";
        private const string Warning = "Warning";

        // Log record types
        private const string OrderRecord = "Order";
        private const string PaymentRecord = "Payment";

        private readonly Dictionary<string, ItemInfo> _itemCache = new Dictionary<string, ItemInfo>(StringComparer.OrdinalIgnoreCase);

        [IDOMethod(MethodFlags.None, "Infobar")]
        public int ue_HK_SyncAmazonOrders(string ConfigId, ref string Infobar)
        {
            try
            {
                var cfg = LoadConfig(string.IsNullOrWhiteSpace(ConfigId) ? "DEFAULT" : ConfigId);
                LoadCustomer(cfg);

                var runId = Guid.NewGuid().ToString();
                var runStartUtc = DateTime.UtcNow;
                var since = cfg.LastSyncUtc == DateTime.MinValue
                    ? runStartUtc.AddDays(-Math.Max(1, cfg.LookbackDays))
                    : cfg.LastSyncUtc;

                var run = new RunState { RunId = runId, Client = new AmazonSpApiClient(cfg) };
                // Amazon does not guarantee any order, so fetch the whole window and sort it oldest-update first;
                // that makes "continue after the last one handled" safe.
                var orders = run.Client.SearchOrders(since);
                orders.Sort((a, b) => UpdatedUtc(a).CompareTo(UpdatedUtc(b)));
                var more = MaxOrdersPerRun > 0 && orders.Count > MaxOrdersPerRun;
                if (more)
                    orders.RemoveRange(MaxOrdersPerRun, orders.Count - MaxOrdersPerRun);

                var newestUpdate = DateTime.MinValue;
                foreach (var order in orders)
                {
                    ProcessOrder(order, cfg, run);
                    if (UpdatedUtc(order) > newestUpdate)
                        newestUpdate = UpdatedUtc(order);
                }

                // Only move the watermark forward when everything worked, so failed orders are
                // fetched again next time. Orders already staged are skipped (and logged) on a re-fetch.
                // If the per-run limit cut the list short, continue from the newest order handled
                // (one second back, in case another order shares its timestamp) instead of jumping to now.
                if (run.Errors == 0)
                    cfg.LastSyncUtc = more ? newestUpdate.AddSeconds(-1) : runStartUtc.AddMinutes(-5);
                SaveConfigProgress(cfg);

                Infobar = string.Format("Amazon sync finished: {0} orders staged, {1} skipped, {2} errors, {3} warnings; {4} payments recorded.",
                    run.Staged, run.Skipped, run.Errors, run.Warnings, run.PaymentsRecorded)
                    + (more ? " Limit of " + MaxOrdersPerRun + " orders per run reached; click Sync Now again for the next batch." : "");
                return run.Errors == 0 ? 0 : 16;
            }
            catch (Exception ex)
            {
                Infobar = "Amazon sync failed: " + ex.Message;
                return 16;
            }
        }

        // ------------------------------------------------------------------ order processing

        private void ProcessOrder(Dictionary<string, object> order, AmazonConfig cfg, RunState run)
        {
            var orderId = Json.Str(order, "orderId");
            if (string.IsNullOrEmpty(orderId))
                return;

            try
            {
                ProcessOrderCore(order, orderId, cfg, run);
            }
            catch (Exception ex)
            {
                run.Count(LogOrder(run, cfg, order, null, Error, "Unexpected error: " + ex.Message));
            }
        }

        private void ProcessOrderCore(Dictionary<string, object> order, string orderId, AmazonConfig cfg, RunState run)
        {
            var status = (Json.Str(order, "fulfillment.fulfillmentStatus") ?? "").ToUpperInvariant();
            var stagedCo = FindStagedOrder(orderId);

            if (status.StartsWith("CANCEL"))
            {
                run.Count(stagedCo == null
                    ? LogOrder(run, cfg, order, null, Skipped, "Order cancelled on Amazon before it was staged.")
                    : LogOrder(run, cfg, order, stagedCo, Warning, "Order cancelled on Amazon; staged order " + stagedCo + " needs to be cancelled in SyteLine."));
                return;
            }

            if (stagedCo != null)
            {
                run.Count(LogOrder(run, cfg, order, stagedCo, Skipped, "Already staged as HubKor order " + stagedCo + "."));
                RecordPayment(orderId, stagedCo, cfg, run);
                return;
            }

            // Pending orders have no reliable pricing yet; they come back once Amazon updates them.
            if (status.Contains("PENDING") || status == "UNFULFILLABLE")
            {
                run.Count(LogOrder(run, cfg, order, null, Skipped, "Order status " + status + " is not staged yet."));
                return;
            }

            var lines = new List<CoLine>();
            var unmapped = new List<string>();
            foreach (var orderItem in Json.Array(order, "orderItems"))
            {
                var qty = Json.Dec(orderItem, "quantityOrdered");
                if (qty <= 0)
                    continue;

                var sku = Json.Str(orderItem, "product.sellerSku") ?? "";
                var item = ResolveItem(sku, cfg.CustNum);
                if (item == null)
                    unmapped.Add(sku);
                lines.Add(new CoLine
                {
                    Item = item == null ? Trunc(sku, 30) : item.Item,
                    UM = item == null ? "EA" : item.UM,
                    CustItem = Trunc(sku, 30),
                    Description = Trunc(Json.Str(orderItem, "product.title") ?? sku, 40),
                    Qty = qty,
                    UnitPrice = Json.Dec(orderItem, "product.price.unitPrice.amount"),
                });
            }

            if (lines.Count == 0)
            {
                run.Count(LogOrder(run, cfg, order, null, Skipped, "Order has no lines with quantity."));
                return;
            }

            PaymentInfo payment = null;
            string paymentError = null;
            try { payment = GetPayment(run.Client, orderId); }
            catch (Exception ex) { paymentError = ex.Message; }

            string coNum = null;
            try
            {
                coNum = NextCoNum(cfg);
                StageOrder(cfg, coNum, order, orderId, lines, payment);
            }
            catch (Exception ex)
            {
                var cleanup = coNum == null ? "" : TryDeleteStagedOrder(coNum);
                run.Count(LogOrder(run, cfg, order, null, Error, "Staging order failed: " + ex.Message + cleanup));
                return;
            }

            var warn = unmapped.Count > 0
                ? " SKU not found in SyteLine items (staged with the Amazon SKU): " + string.Join(", ", unmapped.ToArray())
                : "";
            run.Count(LogOrder(run, cfg, order, coNum, unmapped.Count > 0 ? Warning : Synced,
                "Staged as HubKor order " + coNum + " with " + lines.Count + " line(s)." + warn));
            if (unmapped.Count > 0)
                run.Staged++;   // a staged order with an unmapped SKU is logged as Warning but is still staged

            LogPayment(run, cfg, orderId, coNum, payment, paymentError, true);
        }

        /// <summary>Payment for an order that is already staged: record it on the staged header if it arrived since.</summary>
        private void RecordPayment(string orderId, string coNum, AmazonConfig cfg, RunState run)
        {
            PaymentInfo payment = null;
            string paymentError = null;
            try { payment = GetPayment(run.Client, orderId); }
            catch (Exception ex) { paymentError = ex.Message; }

            var alreadyRecorded = false;
            if (payment != null && paymentError == null)
            {
                try
                {
                    var header = Load(StageHeaderIdo, "payment_amount, grandtotal", "CoNum = " + Q(coNum), 1);
                    if (header.Items.Count > 0)
                    {
                        payment.OrderTotal = ToDecimal(header[0, "grandtotal"].Value);
                        alreadyRecorded = ToDecimal(header[0, "payment_amount"].Value) == payment.Total;
                        if (!alreadyRecorded)
                            Update(StageHeaderIdo, header.Items[0].ItemID, PaymentValues(coNum, payment));
                    }
                }
                catch (Exception ex)
                {
                    paymentError = "Could not update payment on " + coNum + ": " + ex.Message;
                }
            }
            LogPayment(run, cfg, orderId, coNum, payment, paymentError, !alreadyRecorded);
        }

        private void LogPayment(RunState run, AmazonConfig cfg, string orderId, string coNum, PaymentInfo payment, string error, bool recorded)
        {
            if (error != null)
            {
                run.Count(Log(run, cfg, PaymentRecord, orderId, null, null, null, coNum, Error, "Payment lookup failed: " + error, null));
                return;
            }
            if (payment == null)
            {
                Log(run, cfg, PaymentRecord, orderId, null, null, null, coNum, Skipped, "No released payment on Amazon yet for this order.", null);
                return;
            }
            foreach (var txn in payment.Transactions)
            {
                var message = recorded
                    ? "Payment " + payment.Total.ToString("0.00", CultureInfo.InvariantCulture) + " recorded on " + coNum + "."
                    : "Payment already recorded on " + coNum + ".";
                Log(run, cfg, PaymentRecord, orderId, Json.Str(txn, "transactionId"), FinancialGroupId(txn),
                    Json.Dec(txn, "totalAmount.amount"), coNum, recorded ? Synced : Skipped, message, txn);
                if (recorded)
                {
                    run.PaymentsRecorded++;
                    try { WritePaymentForm(cfg, orderId, coNum, txn, payment); }
                    catch (Exception ex)
                    {
                        run.Count(Log(run, cfg, PaymentRecord, orderId, Json.Str(txn, "transactionId"), null, null, coNum, Error,
                            "Could not write HubKor AR Payments rows: " + ex.Message, null));
                    }
                }
            }
        }

        /// <summary>Writes one payment (header + grid row) to the tables behind the HubKor AR Payments form. Skips if it is already there.</summary>
        private void WritePaymentForm(AmazonConfig cfg, string orderId, string coNum, Dictionary<string, object> txn, PaymentInfo payment)
        {
            var paymentId = Trunc(Json.Str(txn, "transactionId") ?? orderId, 50);
            if (Load(PaymentHeaderIdo, "PaymentId", "PaymentId = " + Q(paymentId), 1).Items.Count > 0)
                return;

            var net = Json.Dec(txn, "totalAmount.amount");
            var gross = payment.Transactions.Count == 1 && payment.OrderTotal > 0m ? payment.OrderTotal : net;
            var fee = gross > net ? gross - net : 0m;
            var currency = Json.Str(txn, "totalAmount.currencyCode") ?? cfg.CurrCode ?? "USD";
            var posted = ParseUtc(Json.Str(txn, "postedDate")) ?? DateTime.UtcNow;
            var inv = CultureInfo.InvariantCulture;

            Insert(PaymentHeaderIdo, new Dictionary<string, string>
            {
                { "PaymentId", paymentId },
                { "PaymentCustNum", cfg.CustNum },
                { "PaymentCurrCode", Trunc(currency, 3) },
                { "PaymentAmount", net.ToString(inv) },
                { "PaymentDate", posted.ToString(IdoDateFormat, inv) },
                { "PaymentStatus", "Received" },
                { "SLARPaymentCreated", "0" },
                { "ProcessMessage", "Amazon order " + orderId + " staged as " + coNum },
            });
            Insert(PaymentDetailIdo, new Dictionary<string, string>
            {
                { "PaymentId", paymentId },
                { "SourceOrderId", Trunc(orderId, 50) },
                { "OrderId", Trunc(orderId, 50) },
                { "OrderNumber", coNum },
                { "Amount", gross.ToString(inv) },
                { "Fee", fee.ToString(inv) },
                { "Net", net.ToString(inv) },
                { "CurrCode", Trunc(currency, 3) },
                { "Status", "Received" },
                { "SourceType", "AMAZON" },
            });
        }

        // ------------------------------------------------------------------ staging in the HubKor tables

        private void StageOrder(AmazonConfig cfg, string coNum, Dictionary<string, object> order, string orderId, List<CoLine> lines, PaymentInfo payment)
        {
            var orderDate = (ParseUtc(Json.Str(order, "createdTime")) ?? DateTime.UtcNow).Date;
            var subtotal = 0m;
            foreach (var line in lines)
                subtotal += line.Qty * line.UnitPrice;

            var tax = 0m;
            var freight = 0m;
            foreach (var breakdown in Json.Array(order, "proceeds.breakdowns"))
            {
                var type = (Json.Str(breakdown, "type") ?? "").ToUpperInvariant();
                if (type == "TAX") tax += Json.Dec(breakdown, "subtotal.amount");
                else if (type == "SHIPPING") freight += Json.Dec(breakdown, "subtotal.amount");
            }
            var grandTotal = Json.Dec(order, "proceeds.grandTotal.amount");
            if (grandTotal == 0m)
                grandTotal = subtotal + tax + freight;
            if (payment != null)
                payment.OrderTotal = grandTotal;

            // Recipient details if Amazon sent them (BUYER/RECIPIENT data), otherwise the marketplace customer's own.
            Func<string, string> recip = name => Json.Str(order, "recipient.deliveryAddress." + name);
            var name1 = Trunc(recip("name") ?? cfg.CustName ?? "Amazon Customer", 60);
            var addr1 = Trunc(recip("addressLine1") ?? cfg.Addr1 ?? "Address not provided by Amazon", 50);
            var city = Trunc(recip("city") ?? cfg.City ?? "", 30);
            var state = Trunc(recip("stateOrRegion") ?? cfg.State ?? "", 5);
            var zip = Trunc(recip("postalCode") ?? cfg.Zip ?? "", 10);
            var country = Trunc(CountryName(recip("countryCode")) ?? cfg.Country ?? "UNITED STATES", 30);
            var email = Trunc(Json.Str(order, "buyer.buyerEmail") ?? "", 50);
            var currency = Json.Str(order, "proceeds.grandTotal.currencyCode") ?? cfg.CurrCode ?? "USD";

            var header = new Dictionary<string, string>
            {
                { "CoNum", coNum },
                { "CustNum", cfg.CustNum },
                { "CustSeq", cfg.CustSeq.ToString(CultureInfo.InvariantCulture) },
                { "CustPo", Trunc(orderId, 25) },
                { "ExternalConfirmationRef", orderId },
                { "webstore", WebStore },
                { "TakenBy", TakenBy },
                { "Whse", cfg.Whse },
                { "ShipCode", cfg.ShipCode ?? DefaultShipCode },
                { "shipdescription", DefaultShipDescription },
                { "EndUserType", cfg.EndUserType ?? DefaultEndUserType },
                { "bank_code", cfg.BankCode ?? DefaultBankCode },
                { "currency", currency },
                { "ExchRate", "1" },
                { "DiscountType", "P" },
                { "ShipEarly", "1" },
                { "ShipPartial", "1" },
                { "OrderDate", orderDate.ToString(IdoDateFormat, CultureInfo.InvariantCulture) },
                { "grandtotal", grandTotal.ToString(CultureInfo.InvariantCulture) },
                { "SubtTotal", subtotal.ToString(CultureInfo.InvariantCulture) },
                { "tax_amount", tax.ToString(CultureInfo.InvariantCulture) },
                { "freight", freight.ToString(CultureInfo.InvariantCulture) },
                { "LinesCount", lines.Count.ToString(CultureInfo.InvariantCulture) },
                { "numcolines", lines.Count.ToString(CultureInfo.InvariantCulture) },
                { "billid", cfg.BillToId },
                { "billname", Trunc(cfg.CustName ?? name1, 60) },
                { "sname", Trunc(cfg.CustName ?? name1, 60) },
                { "Contact", Trunc(name1, 30) },
                { "bill_to_name", name1 },
                { "bill_to_addr1", addr1 },
                { "bill_to_city", city },
                { "bill_to_state", state },
                { "bill_to_zip", zip },
                { "bill_to_country", country },
                { "ship_to_name", name1 },
                { "ship_to_addr1", addr1 },
                { "ship_to_city", city },
                { "ship_to_state", state },
                { "ship_to_zip", zip },
                { "ship_to_country", country },
            };
            AddIfSet(header, "email", email);
            AddIfSet(header, "TermsCode", cfg.TermsCode);
            AddIfSet(header, "TaxCode1", cfg.TaxCode1);
            AddIfSet(header, "FrtTaxCode1", cfg.TaxCode1);
            AddIfSet(header, "MscTaxCode1", cfg.TaxCode1);
            AddIfSet(header, "Slsman", cfg.Slsman);
            if (payment != null)
                foreach (var pair in PaymentValues(coNum, payment))
                    header[pair.Key] = pair.Value;

            Insert(StageHeaderIdo, header);

            for (var i = 0; i < lines.Count; i++)
            {
                Insert(StageLineIdo, new Dictionary<string, string>
                {
                    { "co_num", coNum },
                    { "co_line", (i + 1).ToString(CultureInfo.InvariantCulture) },
                    { "co_release", "0" },
                    { "item", lines[i].Item },
                    { "cust_item", lines[i].CustItem },
                    { "description", lines[i].Description },
                    { "u_m", lines[i].UM },
                    { "qty_ordered", lines[i].Qty.ToString(CultureInfo.InvariantCulture) },
                    { "qty_ordered_conv", lines[i].Qty.ToString(CultureInfo.InvariantCulture) },
                    { "price", lines[i].UnitPrice.ToString(CultureInfo.InvariantCulture) },
                    { "price_conv", lines[i].UnitPrice.ToString(CultureInfo.InvariantCulture) },
                    { "whse", cfg.Whse },
                    { "ref_type", "I" },
                });
            }
        }

        /// <summary>Payment columns on the HubKor header. paymentid is an integer there, so it uses the number part of the order number.</summary>
        private static Dictionary<string, string> PaymentValues(string coNum, PaymentInfo payment)
        {
            var digits = Regex.Replace(coNum ?? "", "[^0-9]", "");
            if (digits.Length > 9)
                digits = digits.Substring(digits.Length - 9);
            return new Dictionary<string, string>
            {
                { "paymentid", digits.Length == 0 ? "0" : digits },
                { "payment_amount", payment.Total.ToString(CultureInfo.InvariantCulture) },
                { "prepayment", "1" },
            };
        }

        private string TryDeleteStagedOrder(string coNum)
        {
            try
            {
                foreach (var line in Load(StageLineIdo, "co_num", "co_num = " + Q(coNum), 0).Items)
                    Delete(StageLineIdo, line.ItemID);
                foreach (var header in Load(StageHeaderIdo, "CoNum", "CoNum = " + Q(coNum), 1).Items)
                    Delete(StageHeaderIdo, header.ItemID);
                return " (partial staged order " + coNum + " was removed)";
            }
            catch (Exception ex)
            {
                return " (partial staged order " + coNum + " could not be removed, clean up manually: " + ex.Message + ")";
            }
        }

        // ------------------------------------------------------------------ payments

        /// <summary>Released Amazon transactions for the order, or null if there are none yet.</summary>
        private static PaymentInfo GetPayment(AmazonSpApiClient client, string orderId)
        {
            var released = new List<Dictionary<string, object>>();
            var total = 0m;
            foreach (var txn in client.GetOrderTransactions(orderId))
            {
                var txnStatus = (Json.Str(txn, "transactionStatus") ?? "").ToUpperInvariant();
                if (txnStatus != "RELEASED")
                    continue;
                released.Add(txn);
                total += Json.Dec(txn, "totalAmount.amount");
            }
            return released.Count == 0 ? null : new PaymentInfo { Total = total, Transactions = released };
        }

        private static string FinancialGroupId(Dictionary<string, object> txn)
        {
            foreach (var id in Json.Array(txn, "relatedIdentifiers"))
                if (Json.Str(id, "relatedIdentifierName") == "FINANCIAL_EVENT_GROUP_ID")
                    return Json.Str(id, "relatedIdentifierValue");
            return null;
        }

        // ------------------------------------------------------------------ lookups

        /// <summary>SKU -> Item: first Customer Items (SLItemcusts) for the Amazon customer, then an item with the same number.</summary>
        private ItemInfo ResolveItem(string sku, string custNum)
        {
            if (string.IsNullOrWhiteSpace(sku))
                return null;
            ItemInfo info;
            if (_itemCache.TryGetValue(sku, out info))
                return info;

            var itemNum = sku;
            var byCustItem = Load("SLItemcusts", "Item", "CustNum = " + Q(custNum) + " AND CustItem = " + Q(sku), 1);
            if (byCustItem.Items.Count > 0)
                itemNum = byCustItem[0, "Item"].Value;

            var byItem = Load("SLItems", "Item, UM", "Item = " + Q(itemNum), 1);
            info = byItem.Items.Count > 0
                ? new ItemInfo { Item = byItem[0, "Item"].Value, UM = byItem[0, "UM"].Value }
                : null;

            _itemCache[sku] = info;
            return info;
        }

        private string FindStagedOrder(string amazonOrderId)
        {
            var r = Load(StageHeaderIdo, "CoNum", "webstore = " + Q(WebStore) + " AND CustPo = " + Q(Trunc(amazonOrderId, 25)), 1);
            return r.Items.Count > 0 ? r[0, "CoNum"].Value : null;
        }

        /// <summary>
        /// Looks up the Amazon customer and copies its order defaults into the config.
        /// SyteLine often stores CustNum right-justified with leading spaces, so the value is
        /// used exactly as stored.
        /// </summary>
        private void LoadCustomer(AmazonConfig cfg)
        {
            var trimmed = (cfg.CustNum ?? "").Trim();
            var r = Load("SLCustomers", "CustNum, Name, Addr_1, City, State, Zip, Country, ShipCode, EndUserType, BankCode, CurrCode, TermsCode, TaxCode1, Slsman",
                "CustNum LIKE " + Q("%" + trimmed) + " AND CustSeq = 0", 0);
            for (var i = 0; i < r.Items.Count; i++)
            {
                if (!r[i, "CustNum"].Value.Trim().Equals(trimmed, StringComparison.OrdinalIgnoreCase))
                    continue;
                Func<string, string> v = name => r[i, name].IsNull ? null : r[i, name].Value;
                cfg.CustNum = v("CustNum");
                cfg.CustName = v("Name");
                cfg.Addr1 = v("Addr_1");
                cfg.City = v("City");
                cfg.State = v("State");
                cfg.Zip = v("Zip");
                cfg.Country = v("Country");
                cfg.ShipCode = v("ShipCode");
                cfg.EndUserType = v("EndUserType");
                cfg.BankCode = v("BankCode");
                cfg.CurrCode = v("CurrCode");
                cfg.TermsCode = v("TermsCode");
                cfg.TaxCode1 = v("TaxCode1");
                cfg.Slsman = v("Slsman");
                cfg.BillToId = LoadBillToId(cfg.CustNum);
                return;
            }
            throw new InvalidOperationException("Customer '" + trimmed + "' configured for Amazon does not exist in SyteLine.");
        }

        /// <summary>HubKor matches a staged order to its customer by this ID (customer field Shopify BillTo ID).</summary>
        private string LoadBillToId(string custNum)
        {
            var r = Load(CustomerBillToIdo, "cusUf_Shopify_BillToID", "CustNum = " + Q(custNum) + " AND CustSeq = 0", 1);
            if (r.Items.Count == 0 || r[0, "cusUf_Shopify_BillToID"].IsNull)
                return "0";
            return r[0, "cusUf_Shopify_BillToID"].Value;
        }

        /// <summary>Next free order number, checked against both the HubKor staging table and real customer orders.</summary>
        private string NextCoNum(AmazonConfig cfg)
        {
            var prefix = cfg.CoPrefix ?? "";
            while (true)
            {
                var candidate = prefix + cfg.NextCoSeq.ToString(CultureInfo.InvariantCulture).PadLeft(CoNumLength - prefix.Length, '0');
                cfg.NextCoSeq++;
                if (Load(StageHeaderIdo, "CoNum", "CoNum = " + Q(candidate), 1).Items.Count == 0
                    && Load("SLCos", "CoNum", "CoNum = " + Q(candidate), 1).Items.Count == 0)
                {
                    SaveConfigProgress(cfg);   // persist immediately so a crash never reuses a number
                    return candidate;
                }
            }
        }

        // ------------------------------------------------------------------ config + log tables

        private AmazonConfig LoadConfig(string configId)
        {
            const string props = "ConfigId, BaseUrl, ClientId, ClientSecret, RefreshToken, MarketplaceId, FulfilledBy, QueryOverride, " +
                                 "CustNum, CustSeq, Whse, CoStat, CoPrefix, NextCoSeq, LastSyncUtc, LookbackDays";
            var r = Load(ConfigIdo, props, "ConfigId = " + Q(configId) + " AND Active = 1", 1);
            if (r.Items.Count == 0)
                throw new InvalidOperationException("No active Amazon configuration '" + configId + "' found.");

            Func<string, string> v = name => r[0, name].IsNull ? null : r[0, name].Value;
            return new AmazonConfig
            {
                ItemId = r.Items[0].ItemID,
                ConfigId = v("ConfigId"),
                BaseUrl = v("BaseUrl"),
                ClientId = v("ClientId"),
                ClientSecret = v("ClientSecret"),
                RefreshToken = v("RefreshToken"),
                MarketplaceId = v("MarketplaceId"),
                FulfilledBy = v("FulfilledBy"),
                QueryOverride = v("QueryOverride"),
                CustNum = v("CustNum"),
                CustSeq = ToInt(v("CustSeq"), 0),
                Whse = v("Whse"),
                CoStat = string.IsNullOrWhiteSpace(v("CoStat")) ? "O" : v("CoStat"),
                CoPrefix = v("CoPrefix") ?? "AMZ",
                NextCoSeq = ToInt(v("NextCoSeq"), 1),
                LastSyncUtc = ParseIdoDate(v("LastSyncUtc")) ?? DateTime.MinValue,
                LookbackDays = ToInt(v("LookbackDays"), 7),
            };
        }

        private void SaveConfigProgress(AmazonConfig cfg)
        {
            var values = new Dictionary<string, string> { { "NextCoSeq", cfg.NextCoSeq.ToString(CultureInfo.InvariantCulture) } };
            if (cfg.LastSyncUtc != DateTime.MinValue)
                values["LastSyncUtc"] = cfg.LastSyncUtc.ToString(IdoDateFormat, CultureInfo.InvariantCulture);
            Update(ConfigIdo, cfg.ItemId, values);
            // Each update changes the row's ItemID (it carries the RowPointer + timestamp), so reload it.
            cfg.ItemId = Load(ConfigIdo, "ConfigId", "ConfigId = " + Q(cfg.ConfigId), 1).Items[0].ItemID;
        }

        private string LogOrder(RunState run, AmazonConfig cfg, Dictionary<string, object> order, string coNum, string status, string message)
        {
            return Log(run, cfg, OrderRecord, Json.Str(order, "orderId"), null, null,
                Json.Dec(order, "proceeds.grandTotal.amount"), coNum, status, message, order);
        }

        /// <summary>Always inserts a new row, so repeated syncs of the same order leave a full history. Returns the status for counting.</summary>
        private string Log(RunState run, AmazonConfig cfg, string recordType, string orderId, string transactionId, string financialEventGroupId,
            decimal? amount, string coNum, string status, string message, Dictionary<string, object> raw)
        {
            var values = new Dictionary<string, string>
            {
                { "LogId", Guid.NewGuid().ToString() },
                { "RunId", run.RunId },
                { "RecordType", recordType },
                { "Status", status },
                { "Message", Trunc(message ?? "", 1000) },
                { "CreatedAt", DateTime.UtcNow.ToString(IdoDateFormat, CultureInfo.InvariantCulture) },
            };
            AddIfSet(values, "ConfigId", cfg.ConfigId);
            AddIfSet(values, "AmazonOrderId", orderId);
            AddIfSet(values, "TransactionId", Trunc(transactionId, 100));
            AddIfSet(values, "FinancialEventGroupId", financialEventGroupId);
            AddIfSet(values, "CoNum", coNum);
            if (amount.HasValue)
                values["Amount"] = amount.Value.ToString(CultureInfo.InvariantCulture);
            if (raw != null)
                values["RawJson"] = Json.Serialize(raw);
            Insert(LogIdo, values);
            return status;
        }

        // ------------------------------------------------------------------ IDO helpers

        private LoadCollectionResponseData Load(string ido, string properties, string filter, int recordCap)
        {
            var request = new LoadCollectionRequestData
            {
                IDOName = ido,
                PropertyList = new PropertyList(properties),
                Filter = filter,
                RecordCap = recordCap,
            };
            return Context.Commands.LoadCollection(request);
        }

        private void Insert(string ido, Dictionary<string, string> values)
        {
            Save(ido, new IDOUpdateItem(UpdateAction.Insert), values);
        }

        private void Update(string ido, string itemId, Dictionary<string, string> values)
        {
            Save(ido, new IDOUpdateItem(UpdateAction.Update, itemId), values);
        }

        private void Delete(string ido, string itemId)
        {
            Save(ido, new IDOUpdateItem(UpdateAction.Delete, itemId), new Dictionary<string, string>());
        }

        private void Save(string ido, IDOUpdateItem item, Dictionary<string, string> values)
        {
            foreach (var pair in values)
                item.Properties.Add(pair.Key, pair.Value);
            var request = new UpdateCollectionRequestData(ido);
            request.Items.Add(item);
            Context.Commands.UpdateCollection(request);
        }

        // ------------------------------------------------------------------ small utilities

        private static void AddIfSet(Dictionary<string, string> values, string name, string value)
        {
            if (!string.IsNullOrWhiteSpace(value))
                values[name] = value;
        }

        private static string Q(string value)
        {
            return "N'" + (value ?? "").Replace("'", "''") + "'";
        }

        private static string Trunc(string value, int max)
        {
            if (value == null)
                return null;
            return value.Length > max ? value.Substring(0, max) : value;
        }

        private static string CountryName(string code)
        {
            if (string.IsNullOrWhiteSpace(code))
                return null;
            return code.Trim().Equals("US", StringComparison.OrdinalIgnoreCase) ? "UNITED STATES" : code.Trim().ToUpperInvariant();
        }

        private static int ToInt(string s, int fallback)
        {
            int i;
            return int.TryParse(s, NumberStyles.Any, CultureInfo.InvariantCulture, out i) ? i : fallback;
        }

        private static decimal ToDecimal(string s)
        {
            decimal d;
            return decimal.TryParse(s, NumberStyles.Any, CultureInfo.InvariantCulture, out d) ? d : 0m;
        }

        /// <summary>When Amazon last changed the order (falls back to when it was created).</summary>
        private static DateTime UpdatedUtc(Dictionary<string, object> order)
        {
            return ParseUtc(Json.Str(order, "lastUpdatedTime")) ?? ParseUtc(Json.Str(order, "createdTime")) ?? DateTime.MinValue;
        }

        private static DateTime? ParseUtc(string iso)
        {
            DateTime d;
            return DateTime.TryParse(iso, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out d)
                ? d : (DateTime?)null;
        }

        private static DateTime? ParseIdoDate(string s)
        {
            if (string.IsNullOrWhiteSpace(s))
                return null;
            DateTime d;
            if (DateTime.TryParseExact(s, IdoDateFormat, CultureInfo.InvariantCulture, DateTimeStyles.None, out d))
                return d;
            return DateTime.TryParse(s, CultureInfo.InvariantCulture, DateTimeStyles.None, out d) ? d : (DateTime?)null;
        }

        private sealed class ItemInfo
        {
            public string Item;
            public string UM;
        }

        private sealed class CoLine
        {
            public string Item;
            public string UM;
            public string CustItem;
            public string Description;
            public decimal Qty;
            public decimal UnitPrice;
        }

        private sealed class PaymentInfo
        {
            public decimal Total;
            public decimal OrderTotal;
            public List<Dictionary<string, object>> Transactions;
        }

        /// <summary>State shared by everything logged in one Sync Now click.</summary>
        private sealed class RunState
        {
            public string RunId;
            public AmazonSpApiClient Client;
            public int Staged;
            public int Skipped;
            public int Errors;
            public int Warnings;
            public int PaymentsRecorded;

            public void Count(string status)
            {
                if (status == "Synced") Staged++;
                else if (status == "Error") Errors++;
                else if (status == "Skipped") Skipped++;
                else if (status == "Warning") Warnings++;
            }
        }
    }

    // ===== src/AmazonSpApiClient.cs =====
    internal sealed class AmazonApiException : Exception
    {
        public AmazonApiException(string message) : base(message) { }
    }

    /// <summary>
    /// Calls Amazon Selling Partner API directly: LWA token refresh + Orders API v2026-01-01.
    /// SP-API no longer requires AWS SigV4 signing; the LWA access token in the
    /// x-amz-access-token header is enough.
    /// </summary>
    internal sealed class AmazonSpApiClient
    {
        private const string LwaTokenUrl = "https://api.amazon.com/auth/o2/token";
        private const string UserAgent = "HubKorAmazonSync/1.0 (Language=CSharp; Platform=InforMongoose)";
        private const string OrdersPath = "/orders/2026-01-01/orders";
        private const string TransactionsPath = "/finances/2024-06-19/transactions";
        private const int MaxPages = 50;
        private const int MaxRetries = 3;

        private readonly AmazonConfig _cfg;
        private string _accessToken;
        private DateTime _tokenExpiresUtc;

        public AmazonSpApiClient(AmazonConfig cfg)
        {
            _cfg = cfg;
            ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
        }

        /// <summary>
        /// Returns all orders updated after the given time, following pagination.
        /// If QueryOverride is set (needed for Amazon's static sandbox, which only answers
        /// exact canned queries), that query string is sent as-is and only one page is read.
        /// </summary>
        public List<Dictionary<string, object>> SearchOrders(DateTime lastUpdatedAfterUtc)
        {
            var orders = new List<Dictionary<string, object>>();

            if (!string.IsNullOrWhiteSpace(_cfg.QueryOverride))
            {
                var page = Get(OrdersPath + "?" + _cfg.QueryOverride.TrimStart('?'));
                orders.AddRange(Json.Array(page, "orders"));
                return orders;
            }

            string paginationToken = null;
            for (var pageNo = 0; pageNo < MaxPages; pageNo++)
            {
                var query = new StringBuilder();
                query.Append("marketplaceIds=").Append(Uri.EscapeDataString(_cfg.MarketplaceId));
                query.Append("&lastUpdatedAfter=").Append(Uri.EscapeDataString(lastUpdatedAfterUtc.ToString("yyyy-MM-ddTHH:mm:ssZ", CultureInfo.InvariantCulture)));
                query.Append("&includedData=FULFILLMENT,PROCEEDS,BUYER,RECIPIENT");
                query.Append("&maxResultsPerPage=100");
                if (!string.IsNullOrWhiteSpace(_cfg.FulfilledBy))
                    query.Append("&fulfilledBy=").Append(Uri.EscapeDataString(_cfg.FulfilledBy));
                if (paginationToken != null)
                    query.Append("&paginationToken=").Append(Uri.EscapeDataString(paginationToken));

                var page = Get(OrdersPath + "?" + query);
                orders.AddRange(Json.Array(page, "orders"));

                paginationToken = Json.Str(page, "pagination.nextToken") ?? Json.Str(page, "pagination.paginationToken");
                if (string.IsNullOrEmpty(paginationToken))
                    break;
            }
            return orders;
        }

        /// <summary>Finances API v2024-06-19: all transactions (payments, fees) posted against one order.</summary>
        public List<Dictionary<string, object>> GetOrderTransactions(string orderId)
        {
            var page = Get(TransactionsPath + "?relatedIdentifierName=ORDER_ID&relatedIdentifierValue=" + Uri.EscapeDataString(orderId));
            return Json.Array(page, "payload.transactions");
        }

        private Dictionary<string, object> Get(string pathAndQuery)
        {
            var url = _cfg.BaseUrl.TrimEnd('/') + pathAndQuery;

            for (var attempt = 1; ; attempt++)
            {
                var request = (HttpWebRequest)WebRequest.Create(url);
                request.Method = "GET";
                request.Accept = "application/json";
                request.UserAgent = UserAgent;
                request.Timeout = 60000;
                // Demo mode: a mock server with no ClientId configured needs no token.
                if (!string.IsNullOrWhiteSpace(_cfg.ClientId))
                    request.Headers["x-amz-access-token"] = GetAccessToken();

                try
                {
                    using (var response = (HttpWebResponse)request.GetResponse())
                        return Json.Parse(ReadBody(response));
                }
                catch (WebException ex)
                {
                    var response = ex.Response as HttpWebResponse;
                    if (response == null)
                        throw new AmazonApiException("Amazon GET " + pathAndQuery + " failed: " + ex.Message);
                    var body = ReadBody(response);
                    // 429 = SP-API rate limit; back off and retry.
                    if ((int)response.StatusCode == 429 && attempt < MaxRetries)
                    {
                        Thread.Sleep(2000 * attempt);
                        continue;
                    }
                    throw new AmazonApiException("Amazon GET " + pathAndQuery + " failed: HTTP " + (int)response.StatusCode + " " + body);
                }
            }
        }

        private string GetAccessToken()
        {
            if (_accessToken != null && DateTime.UtcNow < _tokenExpiresUtc)
                return _accessToken;

            var form = "grant_type=refresh_token"
                       + "&refresh_token=" + Uri.EscapeDataString(_cfg.RefreshToken ?? "")
                       + "&client_id=" + Uri.EscapeDataString(_cfg.ClientId ?? "")
                       + "&client_secret=" + Uri.EscapeDataString(_cfg.ClientSecret ?? "");
            var bytes = Encoding.UTF8.GetBytes(form);

            var request = (HttpWebRequest)WebRequest.Create(LwaTokenUrl);
            request.Method = "POST";
            request.ContentType = "application/x-www-form-urlencoded";
            request.UserAgent = UserAgent;
            request.ContentLength = bytes.Length;
            using (var stream = request.GetRequestStream())
                stream.Write(bytes, 0, bytes.Length);

            try
            {
                using (var response = (HttpWebResponse)request.GetResponse())
                {
                    var json = Json.Parse(ReadBody(response));
                    _accessToken = Json.Str(json, "access_token");
                    var expiresIn = (int)Json.Dec(json, "expires_in");
                    _tokenExpiresUtc = DateTime.UtcNow.AddSeconds(Math.Max(60, expiresIn - 120));
                    return _accessToken;
                }
            }
            catch (WebException ex)
            {
                var response = ex.Response as HttpWebResponse;
                throw new AmazonApiException("Amazon LWA token request failed: " + (response == null ? ex.Message : ReadBody(response)));
            }
        }

        private static string ReadBody(HttpWebResponse response)
        {
            using (var reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
                return reader.ReadToEnd();
        }
    }

    // ===== src/AmazonConfig.cs =====
    /// <summary>One row of the ue_hk_amazon_config table (IDO ue_HK_AmazonConfigs).</summary>
    internal sealed class AmazonConfig
    {
        public string ItemId;            // Mongoose row id, needed to update the row

        public string ConfigId;
        public string BaseUrl;           // e.g. https://sellingpartnerapi-na.amazon.com, a sandbox host, or a mock server
        public string ClientId;          // LWA client id; blank = no auth (mock server demo)
        public string ClientSecret;
        public string RefreshToken;
        public string MarketplaceId;     // e.g. ATVPDKIKX0DER (amazon.com)
        public string FulfilledBy;       // AMAZON (FBA), MERCHANT (FBM) or blank for both
        public string QueryOverride;     // exact query string for Amazon's static sandbox; blank in production

        public string CustNum;           // SyteLine customer representing this marketplace, e.g. AMAZON-US
        public int CustSeq;              // ship-to sequence, normally 0
        public string Whse;
        public string CoStat;            // status for new customer orders, e.g. O (Ordered) or P (Planned)
        public string CoPrefix;          // e.g. AMZ -> AMZ0000001
        public int NextCoSeq;

        public DateTime LastSyncUtc;     // watermark; orders updated after this are fetched
        public int LookbackDays;         // used on the very first run when LastSyncUtc is empty

        // Copied from the customer record at the start of each run. The IDO insert does not
        // default these the way the Customer Orders form does, and SLCos rejects the row without them.
        public string CurrCode;
        public string TermsCode;
        public string TaxCode1;
        public string Slsman;

        // Customer details used to fill the HubKor staged order when Amazon sends no recipient data.
        public string CustName;
        public string Addr1;
        public string City;
        public string State;
        public string Zip;
        public string Country;
        public string ShipCode;
        public string EndUserType;
        public string BankCode;
        public string BillToId;          // customer's Shopify BillTo ID; HubKor matches the staged order to the customer by it
    }

    // ===== src/Json.cs =====
    /// <summary>
    /// Small self-contained JSON reader/writer, so the assembly needs no JSON library reference
    /// when SyteLine builds it from source. Objects parse to Dictionary&lt;string, object&gt;,
    /// arrays to List&lt;object&gt;, numbers to decimal (double if out of range), plus string/bool/null.
    /// </summary>
    internal static class Json
    {
        public static Dictionary<string, object> Parse(string json)
        {
            var reader = new Reader(json ?? "");
            var value = reader.ReadValue();
            reader.SkipWhitespace();
            if (!reader.AtEnd)
                throw new FormatException("Unexpected text after JSON at position " + reader.Position + ".");
            var obj = value as Dictionary<string, object>;
            if (obj == null)
                throw new FormatException("Expected a JSON object.");
            return obj;
        }

        public static string Serialize(object value)
        {
            var sb = new StringBuilder();
            Write(sb, value);
            return sb.ToString();
        }

        /// <summary>Walks a dotted path such as "product.price.unitPrice.amount". Returns null if any step is missing.</summary>
        public static object Get(Dictionary<string, object> obj, string path)
        {
            object current = obj;
            foreach (var key in path.Split('.'))
            {
                var dict = current as Dictionary<string, object>;
                if (dict == null || !dict.TryGetValue(key, out current))
                    return null;
            }
            return current;
        }

        public static string Str(Dictionary<string, object> obj, string path)
        {
            var value = Get(obj, path);
            return value == null ? null : Convert.ToString(value, CultureInfo.InvariantCulture);
        }

        public static decimal Dec(Dictionary<string, object> obj, string path)
        {
            var s = Str(obj, path);
            decimal d;
            return decimal.TryParse(s, NumberStyles.Any, CultureInfo.InvariantCulture, out d) ? d : 0m;
        }

        public static List<Dictionary<string, object>> Array(Dictionary<string, object> obj, string path)
        {
            var result = new List<Dictionary<string, object>>();
            var items = Get(obj, path) as IEnumerable;
            if (items == null || items is string)
                return result;
            foreach (var item in items)
            {
                var dict = item as Dictionary<string, object>;
                if (dict != null)
                    result.Add(dict);
            }
            return result;
        }

        // ------------------------------------------------------------------ writer

        private static void Write(StringBuilder sb, object value)
        {
            if (value == null)
                sb.Append("null");
            else if (value is string)
                WriteString(sb, (string)value);
            else if (value is bool)
                sb.Append((bool)value ? "true" : "false");
            else if (value is decimal || value is double || value is float || value is int || value is long)
                sb.Append(Convert.ToString(value, CultureInfo.InvariantCulture));
            else if (value is IDictionary<string, object>)
            {
                sb.Append('{');
                var first = true;
                foreach (var pair in (IDictionary<string, object>)value)
                {
                    if (!first) sb.Append(',');
                    first = false;
                    WriteString(sb, pair.Key);
                    sb.Append(':');
                    Write(sb, pair.Value);
                }
                sb.Append('}');
            }
            else if (value is IEnumerable)
            {
                sb.Append('[');
                var first = true;
                foreach (var item in (IEnumerable)value)
                {
                    if (!first) sb.Append(',');
                    first = false;
                    Write(sb, item);
                }
                sb.Append(']');
            }
            else
                WriteString(sb, Convert.ToString(value, CultureInfo.InvariantCulture));
        }

        private static void WriteString(StringBuilder sb, string s)
        {
            sb.Append('"');
            foreach (var c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < ' ')
                            sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                        else
                            sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
        }

        // ------------------------------------------------------------------ reader

        private sealed class Reader
        {
            private readonly string _s;
            public int Position;

            public Reader(string s) { _s = s; }

            public bool AtEnd { get { return Position >= _s.Length; } }

            public void SkipWhitespace()
            {
                while (!AtEnd && char.IsWhiteSpace(_s[Position]))
                    Position++;
            }

            public object ReadValue()
            {
                SkipWhitespace();
                if (AtEnd)
                    throw new FormatException("Unexpected end of JSON.");
                var c = _s[Position];
                if (c == '{') return ReadObject();
                if (c == '[') return ReadArray();
                if (c == '"') return ReadString();
                if (c == 't') { Expect("true"); return true; }
                if (c == 'f') { Expect("false"); return false; }
                if (c == 'n') { Expect("null"); return null; }
                return ReadNumber();
            }

            private Dictionary<string, object> ReadObject()
            {
                var result = new Dictionary<string, object>();
                Position++; // {
                SkipWhitespace();
                if (Peek() == '}') { Position++; return result; }
                while (true)
                {
                    SkipWhitespace();
                    var key = ReadString();
                    SkipWhitespace();
                    Consume(':');
                    result[key] = ReadValue();
                    SkipWhitespace();
                    if (Peek() == ',') { Position++; continue; }
                    Consume('}');
                    return result;
                }
            }

            private List<object> ReadArray()
            {
                var result = new List<object>();
                Position++; // [
                SkipWhitespace();
                if (Peek() == ']') { Position++; return result; }
                while (true)
                {
                    result.Add(ReadValue());
                    SkipWhitespace();
                    if (Peek() == ',') { Position++; continue; }
                    Consume(']');
                    return result;
                }
            }

            private string ReadString()
            {
                Consume('"');
                var sb = new StringBuilder();
                while (true)
                {
                    if (AtEnd)
                        throw new FormatException("Unterminated JSON string.");
                    var c = _s[Position++];
                    if (c == '"')
                        return sb.ToString();
                    if (c != '\\')
                    {
                        sb.Append(c);
                        continue;
                    }
                    var e = _s[Position++];
                    switch (e)
                    {
                        case 'b': sb.Append('\b'); break;
                        case 'f': sb.Append('\f'); break;
                        case 'n': sb.Append('\n'); break;
                        case 'r': sb.Append('\r'); break;
                        case 't': sb.Append('\t'); break;
                        case 'u':
                            sb.Append((char)int.Parse(_s.Substring(Position, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture));
                            Position += 4;
                            break;
                        default: sb.Append(e); break; // \" \\ \/
                    }
                }
            }

            private object ReadNumber()
            {
                var start = Position;
                while (!AtEnd && "+-0123456789.eE".IndexOf(_s[Position]) >= 0)
                    Position++;
                var text = _s.Substring(start, Position - start);
                decimal d;
                if (decimal.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out d))
                    return d;
                double dbl;
                if (double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out dbl))
                    return dbl;
                throw new FormatException("Invalid JSON value at position " + start + ".");
            }

            private char Peek()
            {
                if (AtEnd)
                    throw new FormatException("Unexpected end of JSON.");
                return _s[Position];
            }

            private void Consume(char expected)
            {
                if (Peek() != expected)
                    throw new FormatException("Expected '" + expected + "' at position " + Position + ".");
                Position++;
            }

            private void Expect(string word)
            {
                if (string.CompareOrdinal(_s, Position, word, 0, word.Length) != 0)
                    throw new FormatException("Invalid JSON value at position " + Position + ".");
                Position += word.Length;
            }
        }
    }
}
