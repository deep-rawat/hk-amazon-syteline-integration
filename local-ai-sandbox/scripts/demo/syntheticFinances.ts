/**
 * Synthetic Finances generator for the HubKor SyteLine integration demo.
 *
 * Pure and deterministic: takes the orders already seeded in the sandbox (never invents its
 * own order IDs) and produces Finances 2024-06-19 transactions plus Finances v0 settlement
 * groups (financial event groups) that reconcile exactly. Nothing here touches the network or
 * the database; scripts/demoData.ts reads the live orders and drives the sandbox over HTTP.
 *
 * Modeling choices (reasonable demo approximations, not schema deviations):
 * - Only SHIPPED / PARTIALLY_SHIPPED orders get a Shipment transaction, and only for order
 *   items with quantityFulfilled > 0 — PENDING/UNSHIPPED/CANCELLED orders correctly have none
 *   yet, matching "financial activity appears after the underlying order", not before it.
 * - A transaction's totalAmount always nets its own fee breakdown (principal - referral
 *   commission - FBA fee), so a settlement group's payout is simply the sum of the
 *   totalAmount of every transaction assigned to it — this avoids double counting by
 *   construction rather than by a separate reconciliation pass.
 * - One constant synthetic seller account; no partial-item refunds (a refund always covers a
 *   whole order line); a flat 3% rolling reserve holdback/release, not Amazon's real
 *   risk-based variable rate.
 * - Settlement periods are a fixed 14-day cycle ending "now" (the anchor): the most recent
 *   period is always "Open" (still accruing, nothing disbursed yet), every older period is
 *   "Closed" and has a FundTransferDate a couple of days after it ends.
 */
import {
  type OrderRecord,
  DEMO_CATALOG,
  US_MARKETPLACE_ID,
  US_MARKETPLACE_NAME,
  money,
  parseCents,
  createRandom,
  randomInt,
} from "./syntheticFbaOrders.js";

// --- Constants ---

/** Synthetic seller account id (format-plausible, clearly not a real one). */
export const SYNTHETIC_SELLER_ID = "A3SIMSELLER01";

/** Default PRNG seed for the finances generator (independent of the orders seed). */
export const DEFAULT_FINANCES_SEED = 20260615;

/** Amazon's standard bi-weekly disbursement cycle. */
const SETTLEMENT_PERIOD_DAYS = 14;

/** Time between a period closing and its funds actually transferring. */
const SETTLEMENT_PROCESSING_BUFFER_DAYS = 2;

/** Flat rolling reserve holdback, as a fraction of a period's gross Shipment principal. */
const RESERVE_RATE = 0.03;

/** A reserve holdback is released this many closed settlement periods after it was held. */
const RESERVE_RELEASE_PERIODS_LATER = 2;

/** Roughly 1 in this many eligible (shipped) orders also gets a Refund transaction. */
const REFUND_SAMPLE_EVERY = 11;
const REFUND_SAMPLE_RESIDUE = 3;

/** Roughly 1 in this many eligible orders also gets a fee-reversal Adjustment transaction. */
const ADJUSTMENT_SAMPLE_EVERY = 17;
const ADJUSTMENT_SAMPLE_RESIDUE = 5;

/** Delay between an order shipping and its Shipment transaction posting, in hours. */
const SHIPMENT_POST_DELAY_HOURS_MIN = 24;
const SHIPMENT_POST_DELAY_HOURS_MAX = 60;

/** Delay between a Shipment transaction posting and a sampled Refund, in days. */
const REFUND_DELAY_DAYS_MIN = 3;
const REFUND_DELAY_DAYS_MAX = 20;

/** Delay between a Shipment transaction posting and a sampled fee-reversal Adjustment, in days. */
const ADJUSTMENT_DELAY_DAYS_MIN = 5;
const ADJUSTMENT_DELAY_DAYS_MAX = 15;

/** A posted/settlement timestamp is never allowed within this many hours of "now". */
const PAST_SAFETY_BUFFER_HOURS = 1;

// --- Types (Finances 2024-06-19 Transaction shape, camelCase per the published model) ---

export interface RelatedIdentifier {
  relatedIdentifierName: string;
  relatedIdentifierValue: string;
}

export interface Breakdown {
  breakdownType: string;
  breakdownAmount: { amount: string; currencyCode: string };
}

export interface ProductContext {
  contextType: "ProductContext";
  asin: string;
  sku: string;
  quantityShipped: number;
  fulfillmentNetwork: string;
}

export interface TransactionItem {
  description: string;
  totalAmount: { amount: string; currencyCode: string };
  breakdowns: Breakdown[];
  contexts: ProductContext[];
}

export interface Transaction {
  transactionId: string;
  transactionType: "Shipment" | "Refund" | "Adjustment" | "Reserve";
  transactionStatus: "DEFERRED" | "RELEASED";
  description: string;
  postedDate: string;
  totalAmount: { amount: string; currencyCode: string };
  sellingPartnerMetadata: { sellingPartnerId: string; accountType: string; marketplaceId: string };
  marketplaceDetails: { marketplaceId: string; marketplaceName: string };
  relatedIdentifiers: RelatedIdentifier[];
  items?: TransactionItem[];
  breakdowns: Breakdown[];
}

// --- Types (Finances v0 FinancialEventGroup shape, PascalCase per the published model) ---

export interface FinancialEventGroup {
  FinancialEventGroupId: string;
  ProcessingStatus: "Open" | "Closed";
  FundTransferStatus: string;
  OriginalTotal: { CurrencyCode: string; CurrencyAmount: number };
  ConvertedTotal: { CurrencyCode: string; CurrencyAmount: number };
  FundTransferDate?: string;
  TraceId: string;
  AccountTail: string;
  BeginningBalance: { CurrencyCode: string; CurrencyAmount: number };
  FinancialEventGroupStart: string;
  FinancialEventGroupEnd?: string;
}

export interface GenerateFinancialDataOptions {
  /** "Now", for computing settlement periods and keeping everything in the past. Defaults to the current hour. */
  anchor?: Date;
  /** PRNG seed. Defaults to DEFAULT_FINANCES_SEED. */
  seed?: number;
}

export interface FinancialDataResult {
  transactions: Transaction[];
  settlementGroups: FinancialEventGroup[];
}

// --- Helpers ---

function iso(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * 3600 * 1000);
}

/** Never let a generated timestamp land in the future relative to the anchor. */
function clampToPast(date: Date, anchor: Date): Date {
  const latestAllowed = addHours(anchor, -PAST_SAFETY_BUFFER_HOURS);
  return date.getTime() > latestAllowed.getTime() ? latestAllowed : date;
}

function currency(cents: number): { CurrencyCode: string; CurrencyAmount: number } {
  return { CurrencyCode: "USD", CurrencyAmount: Math.round(cents) / 100 };
}

function sumBreakdowns(breakdowns: Breakdown[]): number {
  return breakdowns.reduce((total, b) => total + parseCents(b.breakdownAmount.amount), 0);
}

// --- Per-order Shipment transaction ---

interface EligibleItem {
  orderItem: OrderRecord["orderItems"][number];
  principalCents: number;
  referralFeeCents: number;
  fbaFeeCents: number;
  netCents: number;
}

function computeEligibleItems(order: OrderRecord, catalogBySku: Map<string, (typeof DEMO_CATALOG)[number]>): EligibleItem[] {
  const eligible: EligibleItem[] = [];
  for (const orderItem of order.orderItems) {
    const quantityFulfilled = orderItem.fulfillment.quantityFulfilled;
    if (quantityFulfilled <= 0) continue;

    const catalogEntry = catalogBySku.get(orderItem.product.sellerSku);
    if (!catalogEntry) continue; // defensive: every demo order draws from DEMO_CATALOG

    const unitPriceCents = parseCents(orderItem.product.price.unitPrice.amount);
    const principalCents = unitPriceCents * quantityFulfilled;
    const referralFeeCents = Math.round(principalCents * catalogEntry.referralFeeRate);
    const fbaFeeCents = catalogEntry.fbaFulfillmentFeeCents * quantityFulfilled;
    const netCents = principalCents - referralFeeCents - fbaFeeCents;

    eligible.push({ orderItem, principalCents, referralFeeCents, fbaFeeCents, netCents });
  }
  return eligible;
}

function productContextFor(item: EligibleItem): ProductContext {
  return {
    contextType: "ProductContext",
    asin: item.orderItem.product.asin,
    sku: item.orderItem.product.sellerSku,
    quantityShipped: item.orderItem.fulfillment.quantityFulfilled,
    fulfillmentNetwork: "AFN", // Amazon Fulfillment Network — this simulator is FBA-only
  };
}

function sellingPartnerMetadata(): Transaction["sellingPartnerMetadata"] {
  return { sellingPartnerId: SYNTHETIC_SELLER_ID, accountType: "PAYABLE", marketplaceId: US_MARKETPLACE_ID };
}

function marketplaceDetails(): Transaction["marketplaceDetails"] {
  return { marketplaceId: US_MARKETPLACE_ID, marketplaceName: US_MARKETPLACE_NAME };
}

/** Builds the Shipment transaction for one eligible order. Returns undefined if nothing shipped. */
function buildShipmentTransaction(
  order: OrderRecord,
  eligibleItems: EligibleItem[],
  anchor: Date,
  random: () => number,
): Transaction | undefined {
  if (eligibleItems.length === 0) return undefined;

  const totalPrincipalCents = eligibleItems.reduce((sum, i) => sum + i.principalCents, 0);
  const totalReferralCents = eligibleItems.reduce((sum, i) => sum + i.referralFeeCents, 0);
  const totalFbaCents = eligibleItems.reduce((sum, i) => sum + i.fbaFeeCents, 0);
  const totalNetCents = eligibleItems.reduce((sum, i) => sum + i.netCents, 0);

  const postedDate = clampToPast(
    addHours(new Date(order.lastUpdatedTime), randomInt(random, SHIPMENT_POST_DELAY_HOURS_MIN, SHIPMENT_POST_DELAY_HOURS_MAX)),
    anchor,
  );

  const items: TransactionItem[] = eligibleItems.map((item) => ({
    description: item.orderItem.product.title,
    totalAmount: money(item.netCents),
    breakdowns: [
      { breakdownType: "Product Charges", breakdownAmount: money(item.principalCents) },
      { breakdownType: "Commission", breakdownAmount: money(-item.referralFeeCents) },
      { breakdownType: "FBAPerUnitFulfillmentFee", breakdownAmount: money(-item.fbaFeeCents) },
    ],
    contexts: [productContextFor(item)],
  }));

  return {
    transactionId: `TXN-${order.orderId}-SHIP`,
    transactionType: "Shipment",
    transactionStatus: "DEFERRED", // overwritten once settlement grouping runs
    description: "Order Payment",
    postedDate: iso(postedDate),
    totalAmount: money(totalNetCents),
    sellingPartnerMetadata: sellingPartnerMetadata(),
    marketplaceDetails: marketplaceDetails(),
    relatedIdentifiers: [{ relatedIdentifierName: "ORDER_ID", relatedIdentifierValue: order.orderId }],
    items,
    breakdowns: [
      { breakdownType: "Sales", breakdownAmount: money(totalPrincipalCents) },
      { breakdownType: "Commission", breakdownAmount: money(-totalReferralCents) },
      { breakdownType: "FBAPerUnitFulfillmentFee", breakdownAmount: money(-totalFbaCents) },
    ],
  };
}

/** Refunds the first eligible item in full; Amazon credits back the commission it took, but not the FBA fee. */
function buildRefundTransaction(order: OrderRecord, eligibleItems: EligibleItem[], shipmentPostedDate: Date, anchor: Date, random: () => number): Transaction {
  const item = eligibleItems[0];
  const referralCreditCents = item.referralFeeCents;
  const netRefundCents = -(item.principalCents - referralCreditCents);

  const postedDate = clampToPast(addHours(shipmentPostedDate, randomInt(random, REFUND_DELAY_DAYS_MIN, REFUND_DELAY_DAYS_MAX) * 24), anchor);

  return {
    transactionId: `TXN-${order.orderId}-REFUND`,
    transactionType: "Refund",
    transactionStatus: "DEFERRED",
    description: "Refund Order",
    postedDate: iso(postedDate),
    totalAmount: money(netRefundCents),
    sellingPartnerMetadata: sellingPartnerMetadata(),
    marketplaceDetails: marketplaceDetails(),
    relatedIdentifiers: [
      { relatedIdentifierName: "ORDER_ID", relatedIdentifierValue: order.orderId },
      { relatedIdentifierName: "REFUND_ID", relatedIdentifierValue: `REF-${order.orderId}` },
    ],
    items: [
      {
        description: item.orderItem.product.title,
        totalAmount: money(netRefundCents),
        breakdowns: [
          { breakdownType: "Product Charges", breakdownAmount: money(-item.principalCents) },
          { breakdownType: "Commission", breakdownAmount: money(referralCreditCents) },
        ],
        contexts: [productContextFor(item)],
      },
    ],
    breakdowns: [
      { breakdownType: "Returns", breakdownAmount: money(-item.principalCents) },
      { breakdownType: "Commission", breakdownAmount: money(referralCreditCents) },
    ],
  };
}

/** Credits back half the order's total FBA fee, simulating a post-hoc fee correction. */
function buildAdjustmentTransaction(
  order: OrderRecord,
  eligibleItems: EligibleItem[],
  shipmentPostedDate: Date,
  anchor: Date,
  random: () => number,
): Transaction {
  const totalFbaCents = eligibleItems.reduce((sum, i) => sum + i.fbaFeeCents, 0);
  const creditCents = Math.round(totalFbaCents * 0.5);

  const postedDate = clampToPast(addHours(shipmentPostedDate, randomInt(random, ADJUSTMENT_DELAY_DAYS_MIN, ADJUSTMENT_DELAY_DAYS_MAX) * 24), anchor);

  return {
    transactionId: `TXN-${order.orderId}-ADJ`,
    transactionType: "Adjustment",
    transactionStatus: "DEFERRED",
    description: "FBA Fulfillment Fee Correction",
    postedDate: iso(postedDate),
    totalAmount: money(creditCents),
    sellingPartnerMetadata: sellingPartnerMetadata(),
    marketplaceDetails: marketplaceDetails(),
    relatedIdentifiers: [{ relatedIdentifierName: "ORDER_ID", relatedIdentifierValue: order.orderId }],
    breakdowns: [{ breakdownType: "FBAPerUnitFulfillmentFee", breakdownAmount: money(creditCents) }],
  };
}

// --- Settlement period computation ---

interface SettlementPeriod {
  index: number; // 0 = current/open, 1 = most recently closed, 2 = before that, ...
  start: Date;
  end: Date;
  isOpen: boolean;
}

/** Hard cap on generated periods (~38 years of bi-weekly cycles) so a bad input can't loop forever. */
const MAX_SETTLEMENT_PERIODS = 1000;

/** Builds consecutive 14-day periods, newest (index 0, open) first, back to before the earliest activity. */
function buildSettlementPeriods(anchor: Date, earliestActivity: Date): SettlementPeriod[] {
  const periods: SettlementPeriod[] = [];
  let end = anchor;
  for (let index = 0; index < MAX_SETTLEMENT_PERIODS; index++) {
    const start = new Date(end.getTime() - SETTLEMENT_PERIOD_DAYS * 24 * 3600 * 1000);
    periods.push({ index, start, end, isOpen: index === 0 });
    if (start.getTime() <= earliestActivity.getTime()) break;
    end = start;
  }
  return periods;
}

function periodFor(periods: SettlementPeriod[], date: Date): SettlementPeriod {
  const time = date.getTime();
  // Newest-first search; the oldest period's start is inclusive of everything before it too.
  for (const period of periods) {
    if (time >= period.start.getTime() && (time < period.end.getTime() || period.index === 0)) return period;
  }
  return periods[periods.length - 1];
}

// --- Top-level generator ---

export function generateFinancialData(orders: OrderRecord[], options: GenerateFinancialDataOptions = {}): FinancialDataResult {
  const anchor = options.anchor ?? new Date(Math.floor(Date.now() / 3600000) * 3600000);
  const random = createRandom(options.seed ?? DEFAULT_FINANCES_SEED);
  const catalogBySku = new Map(DEMO_CATALOG.map((p) => [p.sellerSku, p] as const));

  // --- Per-order transactions (Shipment, sampled Refund / Adjustment) ---
  const transactions: Transaction[] = [];
  let eligibleOrderCount = 0;

  for (const order of orders) {
    if (order.fulfillment.fulfillmentStatus !== "SHIPPED" && order.fulfillment.fulfillmentStatus !== "PARTIALLY_SHIPPED") {
      continue; // PENDING / UNSHIPPED / CANCELLED: no proceeds have posted yet
    }

    const eligibleItems = computeEligibleItems(order, catalogBySku);
    const shipment = buildShipmentTransaction(order, eligibleItems, anchor, random);
    if (!shipment) continue;

    transactions.push(shipment);
    const shipmentPostedDate = new Date(shipment.postedDate);
    eligibleOrderCount++;

    if (eligibleOrderCount % REFUND_SAMPLE_EVERY === REFUND_SAMPLE_RESIDUE) {
      transactions.push(buildRefundTransaction(order, eligibleItems, shipmentPostedDate, anchor, random));
    } else if (eligibleOrderCount % ADJUSTMENT_SAMPLE_EVERY === ADJUSTMENT_SAMPLE_RESIDUE) {
      transactions.push(buildAdjustmentTransaction(order, eligibleItems, shipmentPostedDate, anchor, random));
    }
  }

  if (transactions.length === 0) {
    return { transactions: [], settlementGroups: [] };
  }

  // --- Settlement periods ---
  const earliestActivity = transactions.reduce(
    (earliest, t) => (new Date(t.postedDate).getTime() < earliest.getTime() ? new Date(t.postedDate) : earliest),
    new Date(transactions[0].postedDate),
  );
  const periods = buildSettlementPeriods(anchor, earliestActivity);

  // --- Reserve holdback per closed period, based on that period's gross Shipment principal ---
  const grossPrincipalByPeriodIndex = new Map<number, number>();
  for (const t of transactions) {
    if (t.transactionType !== "Shipment") continue;
    const period = periodFor(periods, new Date(t.postedDate));
    if (period.isOpen) continue;
    const salesBreakdown = t.breakdowns.find((b) => b.breakdownType === "Sales");
    const principalCents = salesBreakdown ? parseCents(salesBreakdown.breakdownAmount.amount) : 0;
    grossPrincipalByPeriodIndex.set(period.index, (grossPrincipalByPeriodIndex.get(period.index) ?? 0) + principalCents);
  }

  const reserveHoldCentsByPeriodIndex = new Map<number, number>();
  for (const period of periods) {
    if (period.isOpen) continue;
    const grossPrincipal = grossPrincipalByPeriodIndex.get(period.index);
    if (!grossPrincipal) continue;
    const holdCents = Math.round(grossPrincipal * RESERVE_RATE);
    reserveHoldCentsByPeriodIndex.set(period.index, holdCents);

    transactions.push({
      transactionId: `TXN-RESERVE-HOLD-${String(period.index).padStart(4, "0")}`,
      transactionType: "Reserve",
      transactionStatus: "DEFERRED",
      description: "Reserve holdback",
      // One hour before the period's end, not exactly on it: periodFor()'s boundary is
      // start-inclusive/end-exclusive, and the next period's start equals this period's end,
      // so a timestamp of exactly `period.end` would be reassigned to the wrong (newer) group.
      postedDate: iso(addHours(period.end, -1)),
      totalAmount: money(-holdCents),
      sellingPartnerMetadata: sellingPartnerMetadata(),
      marketplaceDetails: marketplaceDetails(),
      relatedIdentifiers: [], // account-level, not tied to a specific order
      breakdowns: [{ breakdownType: "Reserve", breakdownAmount: money(-holdCents) }],
    });

    const releasePeriod = periods.find((p) => p.index === period.index - RESERVE_RELEASE_PERIODS_LATER && !p.isOpen);
    if (releasePeriod) {
      transactions.push({
        transactionId: `TXN-RESERVE-RELEASE-${String(period.index).padStart(4, "0")}`,
        transactionType: "Reserve",
        transactionStatus: "DEFERRED",
        description: "Reserve release",
        postedDate: iso(addHours(releasePeriod.end, -1)), // see the holdback's comment on boundary timing
        totalAmount: money(holdCents),
        sellingPartnerMetadata: sellingPartnerMetadata(),
        marketplaceDetails: marketplaceDetails(),
        relatedIdentifiers: [],
        breakdowns: [{ breakdownType: "Reserve", breakdownAmount: money(holdCents) }],
      });
    }
  }

  // --- Assign every transaction to its settlement group; fill in status + FINANCIAL_EVENT_GROUP_ID ---
  const usedPeriods = new Set(transactions.map((t) => periodFor(periods, new Date(t.postedDate)).index));
  const activePeriods = periods.filter((p) => p.isOpen || usedPeriods.has(p.index)).sort((a, b) => b.index - a.index); // oldest first

  const groupIdByPeriodIndex = new Map<number, string>();
  activePeriods.forEach((period, position) => {
    groupIdByPeriodIndex.set(period.index, `FEG-${String(position + 1).padStart(8, "0")}`);
  });

  for (const t of transactions) {
    const period = periodFor(periods, new Date(t.postedDate));
    const groupId = groupIdByPeriodIndex.get(period.index);
    if (!groupId) continue;
    t.transactionStatus = period.isOpen ? "DEFERRED" : "RELEASED";
    t.relatedIdentifiers.push({ relatedIdentifierName: "FINANCIAL_EVENT_GROUP_ID", relatedIdentifierValue: groupId });
  }

  // --- Build the settlement group records themselves ---
  const settlementGroups: FinancialEventGroup[] = activePeriods.map((period, position) => {
    const groupId = groupIdByPeriodIndex.get(period.index);
    if (!groupId) throw new Error(`Internal error: settlement period ${String(period.index)} has no assigned group id`);

    const groupTransactions = transactions.filter((t) => t.relatedIdentifiers.some((ri) => ri.relatedIdentifierName === "FINANCIAL_EVENT_GROUP_ID" && ri.relatedIdentifierValue === groupId));
    const totalCents = groupTransactions.reduce((sum, t) => sum + parseCents(t.totalAmount.amount), 0);

    const group: FinancialEventGroup = {
      FinancialEventGroupId: groupId,
      ProcessingStatus: period.isOpen ? "Open" : "Closed",
      FundTransferStatus: period.isOpen ? "Pending" : "Settled",
      OriginalTotal: currency(totalCents),
      ConvertedTotal: currency(totalCents),
      TraceId: `TRACE-${String(position + 1).padStart(8, "0")}`,
      AccountTail: "6789",
      BeginningBalance: currency(0),
      FinancialEventGroupStart: iso(period.start),
    };
    if (!period.isOpen) {
      group.FinancialEventGroupEnd = iso(period.end);
      group.FundTransferDate = iso(addHours(period.end, SETTLEMENT_PROCESSING_BUFFER_DAYS * 24));
    }
    return group;
  });

  return { transactions, settlementGroups };
}

// --- Reconciliation check (used by both tests and the live verify CLI) ---

export interface ReconciliationDiscrepancy {
  kind: "order" | "group";
  id: string;
  expectedCents: number;
  actualCents: number;
}

/**
 * Verifies, independent of how the data was built, that:
 * - every transaction's totalAmount equals the sum of its own breakdowns,
 * - every settlement group's OriginalTotal equals the sum of its member transactions.
 * Returns an empty array when everything reconciles.
 */
export function checkReconciliation(transactions: Transaction[], settlementGroups: FinancialEventGroup[]): ReconciliationDiscrepancy[] {
  const discrepancies: ReconciliationDiscrepancy[] = [];

  for (const t of transactions) {
    const expected = sumBreakdowns(t.breakdowns);
    const actual = parseCents(t.totalAmount.amount);
    if (expected !== actual) {
      discrepancies.push({ kind: "order", id: t.transactionId, expectedCents: expected, actualCents: actual });
    }
    for (const item of t.items ?? []) {
      const itemExpected = sumBreakdowns(item.breakdowns);
      const itemActual = parseCents(item.totalAmount.amount);
      if (itemExpected !== itemActual) {
        discrepancies.push({ kind: "order", id: `${t.transactionId}:${item.description}`, expectedCents: itemExpected, actualCents: itemActual });
      }
    }
  }

  for (const group of settlementGroups) {
    const memberTotal = transactions
      .filter((t) => t.relatedIdentifiers.some((ri) => ri.relatedIdentifierName === "FINANCIAL_EVENT_GROUP_ID" && ri.relatedIdentifierValue === group.FinancialEventGroupId))
      .reduce((sum, t) => sum + parseCents(t.totalAmount.amount), 0);
    const expectedCents = Math.round(group.OriginalTotal.CurrencyAmount * 100);
    if (memberTotal !== expectedCents) {
      discrepancies.push({ kind: "group", id: group.FinancialEventGroupId, expectedCents, actualCents: memberTotal });
    }
  }

  return discrepancies;
}
