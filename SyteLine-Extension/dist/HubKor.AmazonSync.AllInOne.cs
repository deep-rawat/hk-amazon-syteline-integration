// AUTO-GENERATED from src/*.cs for SyteLine 'Build From Source'. Edit src/, then run tools/make_allinone.py.
using Mongoose.IDO.Protocol;
using Mongoose.IDO;
using System.Collections.Generic;
using System.Collections;
using System.Globalization;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System;

namespace HubKor.AmazonSync
{
    // ===== src/AmazonSyncExt.cs =====
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
                return WriteLog(order, status, null, Error, "Creating customer order failed: " + ex.Message + cleanup
                    + " [cust=" + cfg.CustNum + ", curr=" + cfg.CurrCode + ", terms=" + cfg.TermsCode + ", tax=" + cfg.TaxCode1 + ", slsman=" + cfg.Slsman + "]");
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
                query.Append("&includedData=FULFILLMENT,PROCEEDS");
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
