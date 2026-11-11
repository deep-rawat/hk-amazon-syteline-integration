using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;

namespace HubKor.AmazonSync
{
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
}
