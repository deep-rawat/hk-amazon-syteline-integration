/**
 * Synthetic FBA order generator for the HubKor SyteLine integration demo.
 *
 * Pure and deterministic: given the same seed and anchor date it always produces the same
 * orders, so the demo data set can be cleared and regenerated at will. Nothing here touches
 * the network or the database; scripts/demoData.ts drives the sandbox over HTTP.
 *
 * Every record is FBA only (fulfillment.fulfilledBy = "AMAZON"), US marketplace, and carries
 * no buyer or recipient PII. Order IDs use the clearly synthetic 999 prefix while still
 * satisfying the Orders 2026-01-01 3-7-7 pattern. Product titles are generic, true-to-life
 * consumer goods (invented brand names, not HubKor-branded and not real trademarks) so the
 * data reads naturally in a customer-facing demo; order aliases, promotion IDs, and SKUs
 * still carry a plain "DEMO" marker so the data set is recognizably synthetic on inspection.
 */

// --- Constants ---

/** US marketplace (Amazon.com). */
export const US_MARKETPLACE_ID = "ATVPDKIKX0DER";
export const US_MARKETPLACE_NAME = "Amazon.com";
export const CURRENCY_CODE = "USD";

/** Marks every generated record as demo data (not customer-brand specific). */
export const DEMO_PREFIX = "DEMO";

/** Default number of orders in the demo data set. */
export const DEFAULT_ORDER_COUNT = 270;

/** Default PRNG seed. Change it to get a different, still repeatable, data set. */
export const DEFAULT_SEED = 20260101;

/** Marketplace facilitator tax rate applied to taxable amounts. */
const TAX_RATE = 0.086;

/** Shipping charged on non-Prime orders, in cents. */
const STANDARD_SHIPPING_CENTS = 599;

/** Share of orders placed by Prime members (free shipping). */
const PRIME_SHARE = 0.7;

/** Every fifth order carries a promotional discount of this fraction of the item subtotal. */
const PROMOTION_RATE = 0.1;

/** Orders are spread across this many days, oldest to newest, scaled to whatever count is requested. */
const ORDER_WINDOW_DAYS = 90;

/**
 * The newest order is placed this many days before the anchor, not right at it — status
 * fields derived from createdTime (lastUpdatedTime, shipByWindow) add up to a few days on
 * top, and none of that is allowed to land in the future relative to the anchor.
 */
const NEWEST_ORDER_BUFFER_DAYS = 3;

// --- Types ---

/** Money as the Orders 2026-01-01 model defines it: a decimal rendered as a string. */
export interface Money {
  amount: string;
  currencyCode: string;
}

export interface DemoProduct {
  sellerSku: string;
  asin: string;
  title: string;
  /** List price per unit, in cents. */
  unitPriceCents: number;
  /** Amazon referral commission rate for the category. Used by the finances generator. */
  referralFeeRate: number;
  /** FBA fulfillment fee per unit, in cents. Used by the finances generator. */
  fbaFulfillmentFeeCents: number;
}

export interface GenerateOptions {
  /** Most recent point in the generated timeline. Defaults to the current hour. */
  anchor?: Date;
  /** PRNG seed. Defaults to DEFAULT_SEED. */
  seed?: number;
  /** How many orders to generate. Defaults to DEFAULT_ORDER_COUNT. */
  count?: number;
}

export type FulfillmentStatus = "PENDING" | "UNSHIPPED" | "PARTIALLY_SHIPPED" | "SHIPPED" | "CANCELLED";

interface ProceedsBreakdown {
  type: string;
  subtotal: Money;
}

export interface OrderItemRecord {
  orderItemId: string;
  quantityOrdered: number;
  product: {
    asin: string;
    title: string;
    sellerSku: string;
    condition: { conditionType: string };
    price: { unitPrice: Money };
  };
  proceeds: { proceedsTotal: Money; breakdowns: ProceedsBreakdown[] };
  promotion?: { breakdowns: { promotionId: string }[] };
  cancellation?: { cancellationRequest: { requester: string; cancelReason: string } };
  fulfillment: { quantityFulfilled: number; quantityUnfulfilled: number };
  tax: { taxCollections: { model: string; responsibleParty: string }[] };
}

export interface OrderRecord {
  orderId: string;
  orderAliases: { aliasId: string; aliasType: string }[];
  createdTime: string;
  lastUpdatedTime: string;
  programs?: string[];
  salesChannel: { channelName: string; marketplaceId: string; marketplaceName: string };
  fulfillment: {
    fulfillmentStatus: FulfillmentStatus;
    fulfilledBy: string;
    fulfillmentServiceLevel: string;
    shipByWindow: { earliestDateTime: string; latestDateTime: string };
    deliverByWindow: { earliestDateTime: string; latestDateTime: string };
  };
  proceeds: { grandTotal: Money; breakdowns: ProceedsBreakdown[] };
  payment?: { paymentExecutions: { paymentMethod: string; paymentAmount: Money }[] };
  orderItems: OrderItemRecord[];
}

// --- Catalog ---

/**
 * The synthetic product catalog the orders draw from: generic, true-to-life consumer goods
 * across a normal multi-category FBA seller's range (invented brand names, not real
 * trademarks, and not HubKor-branded) so a customer demo reads naturally. Referral and
 * fulfillment fee figures are plausible per-category values (Amazon's published referral fee
 * rate for the category, and a size-tier-appropriate FBA fee), carried here so the Finances
 * generator charges fees against the same basis the order lines were priced from.
 */
export const DEMO_CATALOG: DemoProduct[] = [
  // Electronics & accessories (referral 8%)
  { title: "Vantrix Wireless Earbuds with Charging Case", unitPriceCents: 3499, referralFeeRate: 0.08, fbaFulfillmentFeeCents: 398 },
  { title: "Corevolt 65W USB-C Fast Charger Power Adapter", unitPriceCents: 1999, referralFeeRate: 0.08, fbaFulfillmentFeeCents: 345 },
  { title: "Corevolt 10000mAh Portable Power Bank", unitPriceCents: 2499, referralFeeRate: 0.08, fbaFulfillmentFeeCents: 412 },
  { title: "Lumitone Portable Bluetooth Speaker, Waterproof", unitPriceCents: 4299, referralFeeRate: 0.08, fbaFulfillmentFeeCents: 485 },
  { title: "Nordvale 4-Port USB-C Hub Adapter", unitPriceCents: 2899, referralFeeRate: 0.08, fbaFulfillmentFeeCents: 365 },
  { title: "Brightwell Noise Cancelling Over-Ear Headphones", unitPriceCents: 7999, referralFeeRate: 0.08, fbaFulfillmentFeeCents: 585 },
  // Home & kitchen (referral 15%)
  { title: "Oakmere Stainless Steel French Press, 34 oz", unitPriceCents: 2899, referralFeeRate: 0.15, fbaFulfillmentFeeCents: 512 },
  { title: "Oakmere Silicone Baking Mat Set, 3-Pack", unitPriceCents: 1499, referralFeeRate: 0.15, fbaFulfillmentFeeCents: 388 },
  { title: "Kettlewood Electric Milk Frother, Handheld", unitPriceCents: 1299, referralFeeRate: 0.15, fbaFulfillmentFeeCents: 365 },
  { title: "Kettlewood Bamboo Cutting Board Set, 3-Piece", unitPriceCents: 3299, referralFeeRate: 0.15, fbaFulfillmentFeeCents: 612 },
  { title: "Oakmere Digital Kitchen Scale, 11 lb Capacity", unitPriceCents: 1399, referralFeeRate: 0.15, fbaFulfillmentFeeCents: 375 },
  // Office & stationery (referral 15%)
  { title: "Deskline Adjustable Aluminum Laptop Stand", unitPriceCents: 3699, referralFeeRate: 0.15, fbaFulfillmentFeeCents: 677 },
  { title: "Deskline Wireless Ergonomic Mouse", unitPriceCents: 1899, referralFeeRate: 0.15, fbaFulfillmentFeeCents: 388 },
  { title: "Deskline Mechanical Keyboard, RGB Backlit", unitPriceCents: 5999, referralFeeRate: 0.15, fbaFulfillmentFeeCents: 677 },
  { title: "Deskline Desk Organizer with Drawer", unitPriceCents: 2299, referralFeeRate: 0.15, fbaFulfillmentFeeCents: 475 },
  // Outdoor & sporting goods (referral 15%)
  { title: "Trailmark Insulated Stainless Steel Water Bottle, 32 oz", unitPriceCents: 2199, referralFeeRate: 0.15, fbaFulfillmentFeeCents: 475 },
  { title: "Trailmark Resistance Bands Set with Door Anchor", unitPriceCents: 1699, referralFeeRate: 0.15, fbaFulfillmentFeeCents: 412 },
  { title: "Trailmark Rechargeable LED Camping Lantern", unitPriceCents: 1999, referralFeeRate: 0.15, fbaFulfillmentFeeCents: 412 },
  { title: "Trailmark Non-Slip Yoga Mat, 6mm", unitPriceCents: 2499, referralFeeRate: 0.15, fbaFulfillmentFeeCents: 585 },
  // Pet supplies (referral 15%)
  { title: "Pawfield Durable Rubber Dog Chew Toy", unitPriceCents: 1199, referralFeeRate: 0.15, fbaFulfillmentFeeCents: 345 },
  { title: "Pawfield Cat Scratching Post with Hammock", unitPriceCents: 2999, referralFeeRate: 0.15, fbaFulfillmentFeeCents: 721 },
  { title: "Pawfield Self-Cleaning Pet Grooming Brush", unitPriceCents: 1399, referralFeeRate: 0.15, fbaFulfillmentFeeCents: 365 },
  { title: "Pawfield Elevated Dog Feeder, Stainless Steel Bowls", unitPriceCents: 2799, referralFeeRate: 0.15, fbaFulfillmentFeeCents: 612 },
  // Beauty & personal care (referral 8%)
  { title: "Glowrise Rechargeable Facial Cleansing Brush", unitPriceCents: 1999, referralFeeRate: 0.08, fbaFulfillmentFeeCents: 398 },
  { title: "Glowrise Ionic Hair Dryer, 1875W", unitPriceCents: 3499, referralFeeRate: 0.08, fbaFulfillmentFeeCents: 475 },
  { title: "Glowrise Electric Toothbrush with 4 Brush Heads", unitPriceCents: 2799, referralFeeRate: 0.08, fbaFulfillmentFeeCents: 412 },
  { title: "Glowrise LED Makeup Mirror, 10x Magnification", unitPriceCents: 2399, referralFeeRate: 0.08, fbaFulfillmentFeeCents: 412 },
  // Toys & games (referral 15%)
  { title: "Brickforge Building Blocks Set, 500 Pieces", unitPriceCents: 2999, referralFeeRate: 0.15, fbaFulfillmentFeeCents: 585 },
  { title: "Brickforge Off-Road Remote Control Car", unitPriceCents: 3999, referralFeeRate: 0.15, fbaFulfillmentFeeCents: 677 },
  { title: "Brickforge 1000-Piece Landscape Jigsaw Puzzle", unitPriceCents: 1499, referralFeeRate: 0.15, fbaFulfillmentFeeCents: 398 },
  // Tools & home improvement (referral 15%)
  { title: "Ironbridge Cordless Drill Driver Kit, 20V", unitPriceCents: 5999, referralFeeRate: 0.15, fbaFulfillmentFeeCents: 721 },
  { title: "Ironbridge Rechargeable LED Work Light", unitPriceCents: 1799, referralFeeRate: 0.15, fbaFulfillmentFeeCents: 412 },
  { title: "Ironbridge Tool Organizer Bag, 16 Inch", unitPriceCents: 2499, referralFeeRate: 0.15, fbaFulfillmentFeeCents: 585 },
  { title: "Ironbridge Digital Tire Pressure Gauge", unitPriceCents: 999, referralFeeRate: 0.15, fbaFulfillmentFeeCents: 345 },
  // Health & household (referral 15%)
  { title: "Clearhaven Cool Mist Humidifier, 2.5L", unitPriceCents: 3199, referralFeeRate: 0.15, fbaFulfillmentFeeCents: 585 },
  { title: "Clearhaven Adjustable Posture Corrector Brace", unitPriceCents: 1899, referralFeeRate: 0.15, fbaFulfillmentFeeCents: 365 },
  { title: "Clearhaven 100-Piece First Aid Kit", unitPriceCents: 1699, referralFeeRate: 0.15, fbaFulfillmentFeeCents: 412 },
].map((product, index) => ({
  ...product,
  sellerSku: `${DEMO_PREFIX}-SKU-${String(1001 + index)}`,
  asin: `B0DEMO${String(index + 1).padStart(4, "0")}`,
}));

/**
 * Fulfillment status per order position. The oldest orders are shipped and the newest are
 * still working through the pipeline, which is what a real order feed looks like and what
 * makes "financials appear after fulfillment" demonstrable.
 */
const STATUS_PLAN: FulfillmentStatus[] = [
  "SHIPPED",
  "SHIPPED",
  "SHIPPED",
  "SHIPPED",
  "SHIPPED",
  "SHIPPED",
  "SHIPPED",
  "SHIPPED",
  "SHIPPED",
  "SHIPPED",
  "SHIPPED",
  "SHIPPED",
  "SHIPPED",
  "SHIPPED",
  "SHIPPED",
  "PARTIALLY_SHIPPED",
  "UNSHIPPED",
  "UNSHIPPED",
  "PENDING",
  "CANCELLED",
];

// --- Deterministic PRNG ---

/** mulberry32: small, fast, and repeatable across runs and platforms. */
export function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer in the inclusive range [min, max]. */
export function randomInt(random: () => number, min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1));
}

// --- Money helpers ---

/** Renders cents as the decimal string the Orders model expects, for example 1234 to "12.34". */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const absolute = Math.abs(Math.round(cents));
  return `${sign}${String(Math.floor(absolute / 100))}.${String(absolute % 100).padStart(2, "0")}`;
}

/** Parses a decimal string from the Orders model back into cents. */
export function parseCents(amount: string): number {
  return Math.round(Number.parseFloat(amount) * 100);
}

export function money(cents: number): Money {
  return { amount: formatCents(cents), currencyCode: CURRENCY_CODE };
}

// --- Identifier and date helpers ---

function pad7(value: number): string {
  return String(value).padStart(7, "0");
}

/** The middle segment of an order's 3-7-7 identifier, stable across runs. */
function orderMiddleSegment(index: number): string {
  return pad7(3100000 + index * 101);
}

export function demoOrderId(index: number): string {
  return `999-${orderMiddleSegment(index)}-${pad7(5200000 + index * 7919)}`;
}

function demoOrderItemId(index: number, line: number): string {
  return `999-${orderMiddleSegment(index)}-${pad7(7100000 + index * 100 + line)}`;
}

/** All order IDs the generator produces, without building the orders themselves. */
export function demoOrderIds(count: number = DEFAULT_ORDER_COUNT): string[] {
  return Array.from({ length: count }, (_value, index) => demoOrderId(index));
}

function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * 3600 * 1000);
}

function iso(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

// --- Order construction ---

interface LineAmounts {
  itemCents: number;
  shippingCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
}

/** Turns line amounts into the ordered breakdown list, dropping categories worth nothing. */
function breakdownsFor(amounts: LineAmounts): ProceedsBreakdown[] {
  const entries: ProceedsBreakdown[] = [
    { type: "ITEM", subtotal: money(amounts.itemCents) },
    { type: "SHIPPING", subtotal: money(amounts.shippingCents) },
    { type: "TAX", subtotal: money(amounts.taxCents) },
  ];
  if (amounts.discountCents !== 0) {
    entries.push({ type: "DISCOUNT", subtotal: money(amounts.discountCents) });
  }
  return entries;
}

/**
 * Builds one synthetic FBA order. `index` drives the stable identifiers and the position in
 * the timeline; `random` supplies the varying but repeatable details. `count` is the total
 * number of orders being generated, so the timeline spacing scales to however many are asked
 * for instead of assuming a fixed data set size.
 */
function buildOrder(index: number, count: number, anchor: Date, random: () => number): OrderRecord {
  const status = STATUS_PLAN[index % STATUS_PLAN.length];
  const isPrime = random() < PRIME_SHARE;
  const hasPromotion = (index + 1) % 5 === 0;

  // Oldest order first (index 0), newest last (index count - 1), spread evenly across the
  // window with a small per-order jitter. Guaranteed to stay in the past: even the newest
  // order lands NEWEST_ORDER_BUFFER_DAYS before the anchor.
  const positionFraction = count > 1 ? index / (count - 1) : 0;
  const daysAgo = NEWEST_ORDER_BUFFER_DAYS + (1 - positionFraction) * ORDER_WINDOW_DAYS;
  const createdTime = addHours(anchor, -(daysAgo * 24 + randomInt(random, 0, 20)));

  // PARTIALLY_SHIPPED only means something on an order with more than one line.
  const lineCount = status === "PARTIALLY_SHIPPED" ? 2 : randomInt(random, 1, 3);

  const orderItems: OrderItemRecord[] = [];
  const total: LineAmounts = { itemCents: 0, shippingCents: 0, discountCents: 0, taxCents: 0, totalCents: 0 };
  // Random per line, but never the same product twice within one order.
  const usedCatalogIndexes = new Set<number>();

  for (let line = 1; line <= lineCount; line++) {
    let catalogIndex = randomInt(random, 0, DEMO_CATALOG.length - 1);
    while (usedCatalogIndexes.has(catalogIndex)) {
      catalogIndex = randomInt(random, 0, DEMO_CATALOG.length - 1);
    }
    usedCatalogIndexes.add(catalogIndex);
    const product = DEMO_CATALOG[catalogIndex];
    const quantityOrdered = randomInt(random, 1, 3);

    const itemCents = product.unitPriceCents * quantityOrdered;
    // Shipping is charged once per order, on the first line.
    const shippingCents = isPrime || line > 1 ? 0 : STANDARD_SHIPPING_CENTS;
    const discountCents = hasPromotion ? -Math.round(itemCents * PROMOTION_RATE) : 0;
    const taxCents = Math.round((itemCents + shippingCents + discountCents) * TAX_RATE);
    const lineTotalCents = itemCents + shippingCents + discountCents + taxCents;

    const amounts: LineAmounts = { itemCents, shippingCents, discountCents, taxCents, totalCents: lineTotalCents };

    const fullyShipped = status === "SHIPPED";
    const partiallyShippedLine = status === "PARTIALLY_SHIPPED" && line === 1;
    const quantityFulfilled = fullyShipped || partiallyShippedLine ? quantityOrdered : 0;

    const item: OrderItemRecord = {
      orderItemId: demoOrderItemId(index, line),
      quantityOrdered,
      product: {
        asin: product.asin,
        title: product.title,
        sellerSku: product.sellerSku,
        condition: { conditionType: "NEW" },
        price: { unitPrice: money(product.unitPriceCents) },
      },
      proceeds: { proceedsTotal: money(lineTotalCents), breakdowns: breakdownsFor(amounts) },
      fulfillment: {
        quantityFulfilled,
        quantityUnfulfilled: status === "CANCELLED" ? 0 : quantityOrdered - quantityFulfilled,
      },
      tax: { taxCollections: [{ model: "MARKETPLACE_FACILITATOR", responsibleParty: "Amazon Services LLC" }] },
    };

    if (hasPromotion) {
      item.promotion = { breakdowns: [{ promotionId: `${DEMO_PREFIX}-PROMO-${String(index + 1).padStart(4, "0")}` }] };
    }
    if (status === "CANCELLED") {
      item.cancellation = { cancellationRequest: { requester: "BUYER", cancelReason: "Ordered by mistake" } };
    }

    orderItems.push(item);

    total.itemCents += itemCents;
    total.shippingCents += shippingCents;
    total.discountCents += discountCents;
    total.taxCents += taxCents;
    total.totalCents += lineTotalCents;
  }

  const shipByStart = addHours(createdTime, 24);
  const deliverByStart = addHours(createdTime, 72);
  const shipped = status === "SHIPPED" || status === "PARTIALLY_SHIPPED";
  const lastUpdatedTime = shipped ? addHours(createdTime, 36) : createdTime;

  const order: OrderRecord = {
    orderId: demoOrderId(index),
    orderAliases: [{ aliasId: `${DEMO_PREFIX}-${String(index + 1).padStart(4, "0")}`, aliasType: "SELLER_ORDER_ID" }],
    createdTime: iso(createdTime),
    lastUpdatedTime: iso(lastUpdatedTime),
    salesChannel: { channelName: "AMAZON", marketplaceId: US_MARKETPLACE_ID, marketplaceName: US_MARKETPLACE_NAME },
    fulfillment: {
      fulfillmentStatus: status,
      fulfilledBy: "AMAZON",
      fulfillmentServiceLevel: isPrime ? "SECOND_DAY" : "STANDARD",
      shipByWindow: { earliestDateTime: iso(shipByStart), latestDateTime: iso(addHours(shipByStart, 24)) },
      deliverByWindow: { earliestDateTime: iso(deliverByStart), latestDateTime: iso(addHours(deliverByStart, 48)) },
    },
    proceeds: { grandTotal: money(total.totalCents), breakdowns: breakdownsFor(total) },
    orderItems,
  };

  if (isPrime) {
    order.programs = ["PRIME"];
  }
  // A cancelled order was never charged, and a pending one is not yet authorized.
  if (status !== "CANCELLED" && status !== "PENDING") {
    order.payment = { paymentExecutions: [{ paymentMethod: "CreditCard", paymentAmount: money(total.totalCents) }] };
  }

  return order;
}

/** Generates the full demo order set, oldest first. */
export function generateFbaOrders(options: GenerateOptions = {}): OrderRecord[] {
  const count = options.count ?? DEFAULT_ORDER_COUNT;
  const seed = options.seed ?? DEFAULT_SEED;
  // Round the anchor to the hour so a run's timestamps are tidy.
  const anchor = options.anchor ?? new Date(Math.floor(Date.now() / 3600000) * 3600000);
  const random = createRandom(seed);

  return Array.from({ length: count }, (_value, index) => buildOrder(index, count, anchor, random));
}
