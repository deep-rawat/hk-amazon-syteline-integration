import { describe, it, expect, vi } from "vitest";
import type { UnifiedValidationPass } from "../../src/validation/validationTypes.js";

// Mock find() so searchOrdersHandler's buildQuery filters are irrelevant here — the
// mock always returns the full synthetic order set, and the handler is responsible
// for slicing it into pages.
const mockFind = vi.fn<() => Record<string, unknown>[]>().mockReturnValue([]);

vi.mock("../../src/database/Context.js", () => ({
  Api: { ORDERS: "orders" },
  Context: {
    get instance() {
      return {
        engine: {
          find: mockFind,
        },
      };
    },
  },
}));

import { searchOrdersHandler } from "../../src/operation/ordersOperations.js";

/** Minimal valid UnifiedValidationPass for searchOrders, with caller-supplied query params. */
function makeValidationResult(queryParams: Record<string, string | string[] | undefined> = {}): UnifiedValidationPass {
  return {
    pass: true,
    operationId: "searchOrders",
    apiName: "Orders",
    apiVersion: "2026-01-01",
    pathParams: {},
    queryParams,
    body: undefined,
    resolvedEntities: {},
    operation: {},
  };
}

/** A minimal but well-formed synthetic FBA order, in 3-7-7 identifier format. */
function makeOrder(index: number): Record<string, unknown> {
  return {
    orderId: `999-${String(3100000 + index).padStart(7, "0")}-${String(5200000 + index).padStart(7, "0")}`,
    createdTime: "2026-09-01T00:00:00Z",
    lastUpdatedTime: "2026-09-01T00:00:00Z",
    salesChannel: { channelName: "AMAZON", marketplaceId: "ATVPDKIKX0DER" },
    fulfillment: { fulfillmentStatus: "SHIPPED", fulfilledBy: "AMAZON" },
    orderItems: [],
  };
}

describe("searchOrdersHandler pagination", () => {
  it("returns pagination.nextToken when results exceed maxResultsPerPage", async () => {
    mockFind.mockReturnValue(Array.from({ length: 20 }, (_value, index) => makeOrder(index)));

    const result = await searchOrdersHandler(makeValidationResult({ maxResultsPerPage: "5" }), {} as any);

    expect(result.statusCode).toBe(200);
    const body = result.data.body as Record<string, unknown>;
    expect(body.orders).toHaveLength(5);
    expect(body).toHaveProperty("pagination");
    expect(typeof (body.pagination as Record<string, unknown>).nextToken).toBe("string");
  });

  it("omits pagination when every result fits on one page", async () => {
    mockFind.mockReturnValue(Array.from({ length: 5 }, (_value, index) => makeOrder(index)));

    const result = await searchOrdersHandler(makeValidationResult({ maxResultsPerPage: "10" }), {} as any);

    const body = result.data.body as Record<string, unknown>;
    expect(body.orders).toHaveLength(5);
    expect(body).not.toHaveProperty("pagination");
  });

  it("retrieves 20 orders across four pages of five without duplicates or missing records", async () => {
    const totalOrders = 20;
    const pageSize = 5;
    mockFind.mockReturnValue(Array.from({ length: totalOrders }, (_value, index) => makeOrder(index)));

    const collectedOrderIds: string[] = [];
    let paginationToken: string | undefined;
    let pagesFetched = 0;

    do {
      const queryParams: Record<string, string | string[] | undefined> = { maxResultsPerPage: String(pageSize) };
      if (paginationToken) queryParams.paginationToken = paginationToken;

      const result = await searchOrdersHandler(makeValidationResult(queryParams), {} as any);
      pagesFetched++;

      const body = result.data.body as Record<string, unknown>;
      const orders = body.orders as Record<string, unknown>[];

      // Every page except possibly the last is full.
      expect(orders.length).toBeLessThanOrEqual(pageSize);
      collectedOrderIds.push(...orders.map((order) => order.orderId as string));

      const pagination = body.pagination as { nextToken?: string } | undefined;
      paginationToken = pagination?.nextToken;
    } while (paginationToken !== undefined);

    // Four pages of five orders each, none missing and none duplicated.
    expect(pagesFetched).toBe(4);
    expect(collectedOrderIds).toHaveLength(totalOrders);
    expect(new Set(collectedOrderIds).size).toBe(totalOrders);

    const expectedIds = Array.from({ length: totalOrders }, (_value, index) => makeOrder(index).orderId as string);
    expect(new Set(collectedOrderIds)).toEqual(new Set(expectedIds));
  });

  it("returns an empty page for an invalid paginationToken (graceful degradation)", async () => {
    mockFind.mockReturnValue(Array.from({ length: 20 }, (_value, index) => makeOrder(index)));

    const result = await searchOrdersHandler(makeValidationResult({ maxResultsPerPage: "5", paginationToken: "not-a-real-token" }), {} as any);

    const body = result.data.body as Record<string, unknown>;
    expect(body.orders).toEqual([]);
  });
});
