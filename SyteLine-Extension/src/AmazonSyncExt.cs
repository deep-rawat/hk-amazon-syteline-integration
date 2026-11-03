using System;
using System.Collections.Generic;
using System.Globalization;
using Mongoose.IDO;
using Mongoose.IDO.Protocol;

namespace HubKor.AmazonSync
{
    /// <summary>
    /// IDO extension class attached to the ue_HK_AmazonConfigs IDO.
    /// Pulls orders from Amazon SP-API and creates SyteLine customer orders (SLCos / SLCoitems).
    ///
    /// Methods exposed to Mongoose:
    ///   ue_HK_SyncAmazonOrders(ConfigId, ref Infobar)   - full sync run (form button + scheduled task)
    /// </summary>
    [IDOExtensionClass("ue_HK_AmazonConfigs")]
    public class AmazonSyncExt : IDOExtensionClass
    {
        private const string ConfigIdo = "ue_HK_AmazonConfigs";
        private const string LogIdo = "ue_HK_AmazonOrderLogs";
        private const string IdoDateFormat = "yyyyMMdd HH:mm:ss.fff";
        private const int CoNumLength = 10;
        private const int MaxRetryAttempts = 10;

        // Log statuses
        private const string Synced = "Synced";
        private const string Error = "Error";
        private const string Skipped = "Skipped";
        private const string Warning = "Warning";

        private readonly Dictionary<string, ItemInfo> _itemCache = new Dictionary<string, ItemInfo>(StringComparer.OrdinalIgnoreCase);

        [IDOMethod(MethodFlags.None, "Infobar")]
        public int ue_HK_SyncAmazonOrders(string ConfigId, ref string Infobar)
        {
            try
            {
                var cfg = LoadConfig(string.IsNullOrWhiteSpace(ConfigId) ? "DEFAULT" : ConfigId);
                LoadCustomer(cfg);

                var runStartUtc = DateTime.UtcNow;
                var since = cfg.LastSyncUtc == DateTime.MinValue
                    ? runStartUtc.AddDays(-Math.Max(1, cfg.LookbackDays))
                    : cfg.LastSyncUtc;

                var counts = new Dictionary<string, int> { { Synced, 0 }, { Error, 0 }, { Skipped, 0 }, { Warning, 0 } };

                // 1. Retry orders that failed earlier (e.g. SKU was not mapped yet), from the stored JSON.
                foreach (var order in LoadRetryableOrders())
                    counts[ProcessOrder(order, cfg)]++;

                // 2. Fetch new/changed orders from Amazon.
                var client = new AmazonSpApiClient(cfg);
                foreach (var order in client.SearchOrders(since))
                    counts[ProcessOrder(order, cfg)]++;

                // Overlap the next window by 5 minutes; duplicates are blocked by the CustPo check.
                cfg.LastSyncUtc = runStartUtc.AddMinutes(-5);
                SaveConfigProgress(cfg);

                Infobar = string.Format("Amazon sync finished: {0} created, {1} errors, {2} skipped, {3} warnings.",
                    counts[Synced], counts[Error], counts[Skipped], counts[Warning]);
                return counts[Error] == 0 ? 0 : 16;
            }
            catch (Exception ex)
            {
                Infobar = "Amazon sync failed: " + ex.Message;
                return 16;
            }
        }

        // ------------------------------------------------------------------ order processing

        private string ProcessOrder(Dictionary<string, object> order, AmazonConfig cfg)
        {
            var orderId = Json.Str(order, "orderId");
            if (string.IsNullOrEmpty(orderId))
                return Skipped;

            var status = (Json.Str(order, "fulfillment.fulfillmentStatus") ?? "").ToUpperInvariant();
            var existingCo = FindCoByAmazonOrder(cfg.CustNum, orderId);

            if (status.StartsWith("CANCEL"))
            {
                if (existingCo == null)
                    return WriteLog(order, status, null, Skipped, "Order cancelled on Amazon before it was synced.");
                return WriteLog(order, status, existingCo, Warning, "Order cancelled on Amazon; customer order " + existingCo + " needs to be cancelled in SyteLine.");
            }

            if (existingCo != null)
                return WriteLog(order, status, existingCo, Synced, "Already synced to customer order " + existingCo + ".");

            // Pending orders have no reliable pricing yet; they come back once Amazon updates them.
            if (status.Contains("PENDING") || status == "UNFULFILLABLE")
                return WriteLog(order, status, null, Skipped, "Order status " + status + " is not synced yet.");

            // Resolve every SKU before creating anything, so we never leave half an order behind.
            var lines = new List<CoLine>();
            var missing = new List<string>();
            foreach (var orderItem in Json.Array(order, "orderItems"))
            {
                var qty = Json.Dec(orderItem, "quantityOrdered");
                if (qty <= 0)
                    continue;

                var sku = Json.Str(orderItem, "product.sellerSku");
                var item = ResolveItem(sku, cfg.CustNum);
                if (item == null)
                {
                    missing.Add(sku);
                    continue;
                }
                lines.Add(new CoLine { Item = item.Item, UM = item.UM, Qty = qty, UnitPrice = Json.Dec(orderItem, "product.price.unitPrice.amount") });
            }

            if (missing.Count > 0)
                return WriteLog(order, status, null, Error, "SKU not mapped to a SyteLine item: " + string.Join(", ", missing.ToArray()));
            if (lines.Count == 0)
                return WriteLog(order, status, null, Skipped, "Order has no lines with quantity.");

            string coNum = null;
            try
            {
                coNum = NextCoNum(cfg);
                var orderDate = ParseUtc(Json.Str(order, "createdTime")) ?? DateTime.UtcNow;
                CreateCustomerOrder(cfg, coNum, orderId, orderDate, lines);
                return WriteLog(order, status, coNum, Synced, "Customer order " + coNum + " created with " + lines.Count + " line(s).");
            }
            catch (Exception ex)
            {
                var cleanup = coNum == null ? "" : TryDeleteCustomerOrder(coNum);
                return WriteLog(order, status, null, Error, "Creating customer order failed: " + ex.Message + cleanup);
            }
        }

        private void CreateCustomerOrder(AmazonConfig cfg, string coNum, string amazonOrderId, DateTime orderDate, List<CoLine> lines)
        {
            var header = new Dictionary<string, string>
            {
                { "CoNum", coNum },
                { "CustNum", cfg.CustNum },
                { "CustSeq", cfg.CustSeq.ToString(CultureInfo.InvariantCulture) },
                { "CustPo", amazonOrderId },
                { "OrderDate", orderDate.Date.ToString(IdoDateFormat, CultureInfo.InvariantCulture) },
                { "Whse", cfg.Whse },
                { "Stat", cfg.CoStat },
            };
            AddIfSet(header, "CurrCode", cfg.CurrCode);
            AddIfSet(header, "TermsCode", cfg.TermsCode);
            AddIfSet(header, "TaxCode1", cfg.TaxCode1);
            AddIfSet(header, "Slsman", cfg.Slsman);
            Insert("SLCos", header);

            for (var i = 0; i < lines.Count; i++)
            {
                Insert("SLCoitems", new Dictionary<string, string>
                {
                    { "CoNum", coNum },
                    { "CoLine", (i + 1).ToString(CultureInfo.InvariantCulture) },
                    { "CoRelease", "0" },
                    { "Item", lines[i].Item },
                    { "UM", lines[i].UM },
                    { "QtyOrderedConv", lines[i].Qty.ToString(CultureInfo.InvariantCulture) },
                    { "PriceConv", lines[i].UnitPrice.ToString(CultureInfo.InvariantCulture) },
                    { "DueDate", orderDate.Date.ToString(IdoDateFormat, CultureInfo.InvariantCulture) },
                    { "Whse", cfg.Whse },
                    // Without this, lines are created as P (Planned) even on an Ordered header.
                    { "Stat", cfg.CoStat },
                });
            }
        }

        private string TryDeleteCustomerOrder(string coNum)
        {
            try
            {
                foreach (var line in Load("SLCoitems", "CoNum", "CoNum = " + Q(coNum), 0).Items)
                    Delete("SLCoitems", line.ItemID);
                foreach (var header in Load("SLCos", "CoNum", "CoNum = " + Q(coNum), 1).Items)
                    Delete("SLCos", header.ItemID);
                return " (partial order " + coNum + " was removed)";
            }
            catch (Exception ex)
            {
                return " (partial order " + coNum + " could not be removed, clean up manually: " + ex.Message + ")";
            }
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

        private string FindCoByAmazonOrder(string custNum, string amazonOrderId)
        {
            var r = Load("SLCos", "CoNum", "CustNum = " + Q(custNum) + " AND CustPo = " + Q(amazonOrderId), 1);
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
            var r = Load("SLCustomers", "CustNum, CurrCode, TermsCode, TaxCode1, Slsman",
                "CustNum LIKE " + Q("%" + trimmed) + " AND CustSeq = 0", 0);
            for (var i = 0; i < r.Items.Count; i++)
            {
                if (!r[i, "CustNum"].Value.Trim().Equals(trimmed, StringComparison.OrdinalIgnoreCase))
                    continue;
                Func<string, string> v = name => r[i, name].IsNull ? null : r[i, name].Value;
                cfg.CustNum = v("CustNum");
                cfg.CurrCode = v("CurrCode");
                cfg.TermsCode = v("TermsCode");
                cfg.TaxCode1 = v("TaxCode1");
                cfg.Slsman = v("Slsman");
                return;
            }
            throw new InvalidOperationException("Customer '" + trimmed + "' configured for Amazon does not exist in SyteLine.");
        }

        private string NextCoNum(AmazonConfig cfg)
        {
            var prefix = cfg.CoPrefix ?? "";
            while (true)
            {
                var candidate = prefix + cfg.NextCoSeq.ToString(CultureInfo.InvariantCulture).PadLeft(CoNumLength - prefix.Length, '0');
                cfg.NextCoSeq++;
                if (Load("SLCos", "CoNum", "CoNum = " + Q(candidate), 1).Items.Count == 0)
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

        private List<Dictionary<string, object>> LoadRetryableOrders()
        {
            var orders = new List<Dictionary<string, object>>();
            var r = Load(LogIdo, "AmazonOrderId, RawJson", "SyncStatus = " + Q(Error) + " AND Attempts < " + MaxRetryAttempts, 0);
            for (var i = 0; i < r.Items.Count; i++)
            {
                if (r[i, "RawJson"].IsNull)
                    continue;
                try { orders.Add(Json.Parse(r[i, "RawJson"].Value)); }
                catch (FormatException) { /* corrupt row; leave it for manual review */ }
            }
            return orders;
        }

        /// <summary>Insert or update the log row for this Amazon order. Returns the status for counting.</summary>
        private string WriteLog(Dictionary<string, object> order, string amazonStatus, string coNum, string syncStatus, string message)
        {
            var orderId = Json.Str(order, "orderId");
            var values = new Dictionary<string, string>
            {
                { "AmazonStatus", amazonStatus },
                { "SyncStatus", syncStatus },
                { "Message", message.Length > 1000 ? message.Substring(0, 1000) : message },
                { "OrderTotal", Json.Dec(order, "proceeds.grandTotal.amount").ToString(CultureInfo.InvariantCulture) },
                { "Currency", Json.Str(order, "proceeds.grandTotal.currencyCode") },
                { "LineCount", Json.Array(order, "orderItems").Count.ToString(CultureInfo.InvariantCulture) },
                { "LastAttempt", DateTime.UtcNow.ToString(IdoDateFormat, CultureInfo.InvariantCulture) },
                { "RawJson", Json.Serialize(order) },
            };
            if (coNum != null)
                values["CoNum"] = coNum;

            var createdUtc = ParseUtc(Json.Str(order, "createdTime"));
            if (createdUtc.HasValue)
                values["CreatedTimeUtc"] = createdUtc.Value.ToString(IdoDateFormat, CultureInfo.InvariantCulture);

            var existing = Load(LogIdo, "AmazonOrderId, Attempts", "AmazonOrderId = " + Q(orderId), 1);
            if (existing.Items.Count == 0)
            {
                values["AmazonOrderId"] = orderId;
                values["Attempts"] = "1";
                Insert(LogIdo, values);
            }
            else
            {
                values["Attempts"] = (ToInt(existing[0, "Attempts"].Value, 0) + 1).ToString(CultureInfo.InvariantCulture);
                Update(LogIdo, existing.Items[0].ItemID, values);
            }
            return syncStatus;
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

        private static int ToInt(string s, int fallback)
        {
            int i;
            return int.TryParse(s, NumberStyles.Any, CultureInfo.InvariantCulture, out i) ? i : fallback;
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
            public decimal Qty;
            public decimal UnitPrice;
        }
    }
}
