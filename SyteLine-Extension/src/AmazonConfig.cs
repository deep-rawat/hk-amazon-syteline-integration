using System;

namespace HubKor.AmazonSync
{
    /// <summary>One row of the ue_HK_AmazonConfig table (IDO ue_HK_AmazonConfigs).</summary>
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
    }
}
