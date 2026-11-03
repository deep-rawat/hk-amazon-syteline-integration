import { describe, it, expect } from "vitest";
import { generateFinancialData, checkReconciliation } from "../../scripts/demo/syntheticFinances.js";
import { DEMO_CATALOG, US_MARKETPLACE_ID, US_MARKETPLACE_NAME, money, formatCents, type OrderRecord, type FulfillmentStatus } from "../../scripts/demo/syntheticFbaOrders.js";

/**
 * Builds a minimal but schema-shaped order fixture, drawing real fee rates from the shared
 * demo catalog so the finances generator's fee lookups succeed exactly as they would against
 * a live-seeded order.
 */
function buildOrderFixture(options: {
  orderId: string;
  status: FulfillmentStatus;
  createdDaysAgo: number;
  items: { catalogIndex: number; quantityOrdered: number; quantityFulfilled: number }[];
}): OrderRecord {
  const now = new Date("2026-11-01T00:00:00Z");
  const createdTime = new Date(now.getTime() - options.createdDaysAgo * 24 * 3600 * 1000);
  const lastUpdatedTime = new Date(createdTime.getTime() + 36 * 3600 * 1000);

  return {
    orderId: options.orderId,
    orderAliases: [{ aliasId: `DEMO-${options.orderId}`, aliasType: "SELLER_ORDER_ID" }],
    createdTime: createdTime.toISOString().replace(/\.\d{3}Z$/, "Z"),
    lastUpdatedTime: lastUpdatedTime.toISOString().replace(/\.\d{3}Z$/, "Z"),
    salesChannel: { channelName: "AMAZON", marketplaceId: US_MARKETPLACE_ID, marketplaceName: US_MARKETPLACE_NAME },
    fulfillment: {
      fulfillmentStatus: options.status,
      fulfilledBy: "AMAZON",
      fulfillmentServiceLevel: "STANDARD",
      shipByWindow: { earliestDateTime: "", latestDateTime: "" },
      deliverByWindow: { earliestDateTime: "", latestDateTime: "" },
    },
    proceeds: { grandTotal: money(0), breakdowns: [] },
    orderItems: options.items.map((item, index) => {
      const product = DEMO_CATALOG[item.catalogIndex];
      return {
        orderItemId: `${options.orderId.replace(/-/g, "")}-ITEM${String(index)}`,
        quantityOrdered: item.quantityOrdered,
        product: {
          asin: product.asin,
          title: product.title,
          sellerSku: product.sellerSku,
          condition: { conditionType: "NEW" },
          price: { unitPrice: money(product.unitPriceCents) },
        },
        proceeds: { proceedsTotal: money(0), breakdowns: [] },
        fulfillment: { quantityFulfilled: item.quantityFulfilled, quantityUnfulfilled: item.quantityOrdered - item.quantityFulfilled },
        tax: { taxCollections: [] },
      };
    }),
  };
}

/**
 * Ten SHIPPED orders (enough to trigger both the refund and adjustment sampling), spread from
 * 60 days ago down to 4 days ago so the set covers both an older, already-Closed settlement
 * period and the current, still-Open one — plus one of each other status.
 */
function buildFixtureOrders(): OrderRecord[] {
  const daysAgoByIndex = [60, 54, 48, 42, 36, 30, 24, 18, 10, 4];
  const shipped = daysAgoByIndex.map((daysAgo, i) =>
    buildOrderFixture({
      orderId: `999-000000${String(i)}-0000000`,
      status: "SHIPPED",
      createdDaysAgo: daysAgo,
      items: [{ catalogIndex: i % DEMO_CATALOG.length, quantityOrdered: 2, quantityFulfilled: 2 }],
    }),
  );

  const partiallyShipped = buildOrderFixture({
    orderId: "999-0000010-0000000",
    status: "PARTIALLY_SHIPPED",
    createdDaysAgo: 20,
    items: [
      { catalogIndex: 0, quantityOrdered: 1, quantityFulfilled: 1 },
      { catalogIndex: 1, quantityOrdered: 1, quantityFulfilled: 0 },
    ],
  });

  const pending = buildOrderFixture({ orderId: "999-0000011-0000000", status: "PENDING", createdDaysAgo: 1, items: [{ catalogIndex: 2, quantityOrdered: 1, quantityFulfilled: 0 }] });
  const unshipped = buildOrderFixture({ orderId: "999-0000012-0000000", status: "UNSHIPPED", createdDaysAgo: 2, items: [{ catalogIndex: 3, quantityOrdered: 1, quantityFulfilled: 0 }] });
  const cancelled = buildOrderFixture({ orderId: "999-0000013-0000000", status: "CANCELLED", createdDaysAgo: 5, items: [{ catalogIndex: 4, quantityOrdered: 1, quantityFulfilled: 0 }] });

  return [...shipped, partiallyShipped, pending, unshipped, cancelled];
}

const ANCHOR = new Date("2026-11-02T00:00:00Z");

describe("generateFinancialData", () => {
  const orders = buildFixtureOrders();
  const { transactions, settlementGroups } = generateFinancialData(orders, { anchor: ANCHOR, seed: 42 });

  it("produces a Shipment transaction only for SHIPPED/PARTIALLY_SHIPPED orders", () => {
    const shipmentOrderIds = new Set(
      transactions.filter((t) => t.transactionType === "Shipment").flatMap((t) => t.relatedIdentifiers.filter((ri) => ri.relatedIdentifierName === "ORDER_ID").map((ri) => ri.relatedIdentifierValue)),
    );
    expect(shipmentOrderIds.has("999-0000011-0000000")).toBe(false); // PENDING
    expect(shipmentOrderIds.has("999-0000012-0000000")).toBe(false); // UNSHIPPED
    expect(shipmentOrderIds.has("999-0000013-0000000")).toBe(false); // CANCELLED
    expect(shipmentOrderIds.has("999-0000010-0000000")).toBe(true); // PARTIALLY_SHIPPED
    expect(shipmentOrderIds.has("999-0000000-0000000")).toBe(true); // SHIPPED
  });

  it("only includes fulfilled lines for a partially shipped order", () => {
    const shipment = transactions.find((t) => t.relatedIdentifiers.some((ri) => ri.relatedIdentifierName === "ORDER_ID" && ri.relatedIdentifierValue === "999-0000010-0000000"));
    expect(shipment?.items).toHaveLength(1);
    expect(shipment?.items?.[0].contexts[0].sku).toBe(DEMO_CATALOG[0].sellerSku); // the fulfilled line, not the unfulfilled one
  });

  it("every transaction references an order that was actually passed in", () => {
    const orderIds = new Set(orders.map((o) => o.orderId));
    for (const t of transactions) {
      for (const ri of t.relatedIdentifiers.filter((r) => r.relatedIdentifierName === "ORDER_ID")) {
        expect(orderIds.has(ri.relatedIdentifierValue)).toBe(true);
      }
    }
  });

  it("includes at least one Refund and one fee-reversal Adjustment (the requested test scenarios)", () => {
    expect(transactions.some((t) => t.transactionType === "Refund")).toBe(true);
    expect(transactions.some((t) => t.transactionType === "Adjustment")).toBe(true);
  });

  it("includes both RELEASED (settled) and DEFERRED (unsettled) transactions", () => {
    expect(transactions.some((t) => t.transactionStatus === "RELEASED")).toBe(true);
    expect(transactions.some((t) => t.transactionStatus === "DEFERRED")).toBe(true);
  });

  it("never posts a transaction in the future relative to the anchor", () => {
    for (const t of transactions) {
      expect(new Date(t.postedDate).getTime()).toBeLessThanOrEqual(ANCHOR.getTime());
    }
  });

  it("produces exactly one Open settlement group and the rest Closed", () => {
    const open = settlementGroups.filter((g) => g.ProcessingStatus === "Open");
    expect(open).toHaveLength(1);
    expect(settlementGroups.filter((g) => g.ProcessingStatus === "Closed").length).toBeGreaterThan(0);
  });

  it("gives every Closed group a FundTransferDate and FinancialEventGroupEnd, and the Open group neither", () => {
    const closed = settlementGroups.filter((g) => g.ProcessingStatus === "Closed");
    const open = settlementGroups.filter((g) => g.ProcessingStatus === "Open");

    expect(closed.every((g) => g.FundTransferDate !== undefined)).toBe(true);
    expect(closed.every((g) => g.FinancialEventGroupEnd !== undefined)).toBe(true);
    expect(open.every((g) => g.FundTransferDate === undefined)).toBe(true);
    expect(open.every((g) => g.FinancialEventGroupEnd === undefined)).toBe(true);
  });

  it("reconciles exactly: every transaction and every settlement group (fees/adjustments/reserves/refunds)", () => {
    const discrepancies = checkReconciliation(transactions, settlementGroups);
    expect(discrepancies).toEqual([]);
  });

  it("is deterministic: the same orders, seed, and anchor always produce the same output", () => {
    const again = generateFinancialData(orders, { anchor: ANCHOR, seed: 42 });
    expect(again.transactions).toEqual(transactions);
    expect(again.settlementGroups).toEqual(settlementGroups);
  });

  it("produces nothing when no orders have proceeds yet", () => {
    const onlyPending = orders.filter((o) => o.fulfillment.fulfillmentStatus === "PENDING");
    const result = generateFinancialData(onlyPending, { anchor: ANCHOR, seed: 42 });
    expect(result.transactions).toEqual([]);
    expect(result.settlementGroups).toEqual([]);
  });
});

describe("a Shipment transaction's own arithmetic", () => {
  it("nets principal minus referral commission minus FBA fee, matching the catalog's rates", () => {
    const orders = [
      buildOrderFixture({
        orderId: "999-0000099-0000000",
        status: "SHIPPED",
        createdDaysAgo: 60,
        items: [{ catalogIndex: 0, quantityOrdered: 2, quantityFulfilled: 2 }],
      }),
    ];
    const { transactions } = generateFinancialData(orders, { anchor: ANCHOR, seed: 1 });
    const shipment = transactions.find((t) => t.transactionType === "Shipment")!;

    const product = DEMO_CATALOG[0];
    const principalCents = product.unitPriceCents * 2;
    const referralFeeCents = Math.round(principalCents * product.referralFeeRate);
    const fbaFeeCents = product.fbaFulfillmentFeeCents * 2;
    const expectedNetCents = principalCents - referralFeeCents - fbaFeeCents;

    expect(shipment.totalAmount.amount).toBe(formatCents(expectedNetCents));
  });
});
