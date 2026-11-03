import { describe, it, expect, vi } from "vitest";
import type { UnifiedValidationPass } from "../../src/validation/validationTypes.js";

// Mock find()/getCollection() so the handlers read our controlled data instead of a real
// LokiJS collection. Both transactions and settlement groups live in the same "finances"
// partition (shape-distinguished), exactly as the handlers expect.
const mockFind = vi.fn<() => Record<string, unknown>[]>().mockReturnValue([]);

vi.mock("../../src/database/Context.js", () => ({
  Api: { FINANCES: "finances" },
  Context: {
    get instance() {
      return {
        engine: {
          getCollection: () => ({ find: mockFind }),
        },
      };
    },
  },
}));

import { listTransactionsHandler, listFinancialEventGroupsHandler } from "../../src/operation/financesOperations.js";

function makeValidationResult(operationId: string, apiVersion: string, queryParams: Record<string, string | string[] | undefined> = {}): UnifiedValidationPass {
  return {
    pass: true,
    operationId,
    apiName: "Finances",
    apiVersion,
    pathParams: {},
    queryParams,
    body: undefined,
    resolvedEntities: {},
    operation: {},
  };
}

function makeTransaction(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    transactionId: "TXN-999-0000000-0000000-SHIP",
    transactionType: "Shipment",
    transactionStatus: "RELEASED",
    postedDate: "2026-09-01T00:00:00Z",
    totalAmount: { amount: "10.00", currencyCode: "USD" },
    marketplaceDetails: { marketplaceId: "ATVPDKIKX0DER", marketplaceName: "Amazon.com" },
    relatedIdentifiers: [{ relatedIdentifierName: "ORDER_ID", relatedIdentifierValue: "999-0000000-0000000" }],
    ...overrides,
  };
}

function makeSettlementGroup(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    FinancialEventGroupId: "FEG-00000001",
    ProcessingStatus: "Closed",
    FundTransferStatus: "Settled",
    OriginalTotal: { CurrencyCode: "USD", CurrencyAmount: 10 },
    ConvertedTotal: { CurrencyCode: "USD", CurrencyAmount: 10 },
    BeginningBalance: { CurrencyCode: "USD", CurrencyAmount: 0 },
    FinancialEventGroupStart: "2026-08-01T00:00:00Z",
    FinancialEventGroupEnd: "2026-08-15T00:00:00Z",
    ...overrides,
  };
}

describe("listTransactionsHandler", () => {
  it("returns only transactions, even when settlement groups share the same partition", async () => {
    mockFind.mockReturnValue([makeTransaction(), makeSettlementGroup()]);

    const result = await listTransactionsHandler(makeValidationResult("listTransactions", "2024-06-19"), {} as any);

    const body = result.data.body as Record<string, unknown>;
    const payload = body.payload as Record<string, unknown>;
    expect(payload.transactions).toHaveLength(1);
    expect((payload.transactions as Record<string, unknown>[])[0].transactionId).toBe("TXN-999-0000000-0000000-SHIP");
  });

  it("filters by postedAfter / postedBefore", async () => {
    mockFind.mockReturnValue([
      makeTransaction({ transactionId: "TXN-A", postedDate: "2026-01-01T00:00:00Z" }),
      makeTransaction({ transactionId: "TXN-B", postedDate: "2026-06-01T00:00:00Z" }),
      makeTransaction({ transactionId: "TXN-C", postedDate: "2026-12-01T00:00:00Z" }),
    ]);

    const result = await listTransactionsHandler(
      makeValidationResult("listTransactions", "2024-06-19", { postedAfter: "2026-02-01T00:00:00Z", postedBefore: "2026-11-01T00:00:00Z" }),
      {} as any,
    );

    const body = result.data.body as Record<string, unknown>;
    const transactions = (body.payload as Record<string, unknown>).transactions as Record<string, unknown>[];
    expect(transactions.map((t) => t.transactionId)).toEqual(["TXN-B"]);
  });

  it("postedBefore is exclusive of the boundary date", async () => {
    mockFind.mockReturnValue([makeTransaction({ transactionId: "TXN-ON-BOUNDARY", postedDate: "2026-06-01T00:00:00Z" })]);

    const result = await listTransactionsHandler(makeValidationResult("listTransactions", "2024-06-19", { postedBefore: "2026-06-01T00:00:00Z" }), {} as any);

    const body = result.data.body as Record<string, unknown>;
    expect((body.payload as Record<string, unknown>).transactions).toEqual([]);
  });

  it("filters by marketplaceId", async () => {
    mockFind.mockReturnValue([
      makeTransaction({ transactionId: "TXN-US", marketplaceDetails: { marketplaceId: "ATVPDKIKX0DER" } }),
      makeTransaction({ transactionId: "TXN-CA", marketplaceDetails: { marketplaceId: "A2EUQ1WTGCTBG2" } }),
    ]);

    const result = await listTransactionsHandler(makeValidationResult("listTransactions", "2024-06-19", { marketplaceId: "ATVPDKIKX0DER" }), {} as any);

    const body = result.data.body as Record<string, unknown>;
    const transactions = (body.payload as Record<string, unknown>).transactions as Record<string, unknown>[];
    expect(transactions.map((t) => t.transactionId)).toEqual(["TXN-US"]);
  });

  it("filters by transactionStatus", async () => {
    mockFind.mockReturnValue([makeTransaction({ transactionId: "TXN-RELEASED", transactionStatus: "RELEASED" }), makeTransaction({ transactionId: "TXN-DEFERRED", transactionStatus: "DEFERRED" })]);

    const result = await listTransactionsHandler(makeValidationResult("listTransactions", "2024-06-19", { transactionStatus: "DEFERRED" }), {} as any);

    const body = result.data.body as Record<string, unknown>;
    const transactions = (body.payload as Record<string, unknown>).transactions as Record<string, unknown>[];
    expect(transactions.map((t) => t.transactionId)).toEqual(["TXN-DEFERRED"]);
  });

  it("filters by relatedIdentifierName=ORDER_ID and relatedIdentifierValue", async () => {
    mockFind.mockReturnValue([
      makeTransaction({ transactionId: "TXN-ORDER-1", relatedIdentifiers: [{ relatedIdentifierName: "ORDER_ID", relatedIdentifierValue: "111-1111111-1111111" }] }),
      makeTransaction({ transactionId: "TXN-ORDER-2", relatedIdentifiers: [{ relatedIdentifierName: "ORDER_ID", relatedIdentifierValue: "222-2222222-2222222" }] }),
    ]);

    const result = await listTransactionsHandler(
      makeValidationResult("listTransactions", "2024-06-19", { relatedIdentifierName: "ORDER_ID", relatedIdentifierValue: "222-2222222-2222222" }),
      {} as any,
    );

    const body = result.data.body as Record<string, unknown>;
    const transactions = (body.payload as Record<string, unknown>).transactions as Record<string, unknown>[];
    expect(transactions.map((t) => t.transactionId)).toEqual(["TXN-ORDER-2"]);
  });

  it("filters by relatedIdentifierName=FINANCIAL_EVENT_GROUP_ID and relatedIdentifierValue", async () => {
    mockFind.mockReturnValue([
      makeTransaction({
        transactionId: "TXN-IN-GROUP",
        relatedIdentifiers: [
          { relatedIdentifierName: "ORDER_ID", relatedIdentifierValue: "111-1111111-1111111" },
          { relatedIdentifierName: "FINANCIAL_EVENT_GROUP_ID", relatedIdentifierValue: "FEG-00000001" },
        ],
      }),
      makeTransaction({
        transactionId: "TXN-OTHER-GROUP",
        relatedIdentifiers: [
          { relatedIdentifierName: "ORDER_ID", relatedIdentifierValue: "222-2222222-2222222" },
          { relatedIdentifierName: "FINANCIAL_EVENT_GROUP_ID", relatedIdentifierValue: "FEG-00000002" },
        ],
      }),
    ]);

    const result = await listTransactionsHandler(
      makeValidationResult("listTransactions", "2024-06-19", { relatedIdentifierName: "FINANCIAL_EVENT_GROUP_ID", relatedIdentifierValue: "FEG-00000001" }),
      {} as any,
    );

    const body = result.data.body as Record<string, unknown>;
    const transactions = (body.payload as Record<string, unknown>).transactions as Record<string, unknown>[];
    expect(transactions.map((t) => t.transactionId)).toEqual(["TXN-IN-GROUP"]);
  });

  describe("pagination", () => {
    it("returns nextToken when results exceed the page size (100)", async () => {
      mockFind.mockReturnValue(Array.from({ length: 150 }, (_value, i) => makeTransaction({ transactionId: `TXN-${String(i)}`, postedDate: `2026-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z` })));

      const result = await listTransactionsHandler(makeValidationResult("listTransactions", "2024-06-19"), {} as any);

      const body = result.data.body as Record<string, unknown>;
      const payload = body.payload as Record<string, unknown>;
      expect(payload.transactions).toHaveLength(100);
      expect(typeof payload.nextToken).toBe("string");
    });

    it("omits nextToken when everything fits on one page", async () => {
      mockFind.mockReturnValue([makeTransaction()]);
      const result = await listTransactionsHandler(makeValidationResult("listTransactions", "2024-06-19"), {} as any);
      const body = result.data.body as Record<string, unknown>;
      expect((body.payload as Record<string, unknown>).nextToken).toBeUndefined();
    });

    it("traverses all transactions across pages without duplicates or omissions", async () => {
      const total = 250;
      mockFind.mockReturnValue(Array.from({ length: total }, (_value, i) => makeTransaction({ transactionId: `TXN-${String(i).padStart(4, "0")}`, postedDate: `2026-01-01T00:${String(i % 60).padStart(2, "0")}:00Z` })));

      const collected: string[] = [];
      let nextToken: string | undefined;
      for (let page = 0; page < 10; page++) {
        const queryParams: Record<string, string | string[] | undefined> = {};
        if (nextToken) queryParams.nextToken = nextToken;

        const result = await listTransactionsHandler(makeValidationResult("listTransactions", "2024-06-19", queryParams), {} as any);
        const body = result.data.body as Record<string, unknown>;
        const payload = body.payload as Record<string, unknown>;
        const transactions = payload.transactions as Record<string, unknown>[];
        collected.push(...transactions.map((t) => String(t.transactionId)));

        nextToken = payload.nextToken as string | undefined;
        if (!nextToken) break;
      }

      expect(collected).toHaveLength(total);
      expect(new Set(collected).size).toBe(total);
    });
  });
});

describe("listFinancialEventGroupsHandler", () => {
  it("returns only settlement groups, even when transactions share the same partition", async () => {
    mockFind.mockReturnValue([makeTransaction(), makeSettlementGroup()]);

    const result = await listFinancialEventGroupsHandler(makeValidationResult("listFinancialEventGroups", "v0"), {} as any);

    const body = result.data.body as Record<string, unknown>;
    const payload = body.payload as Record<string, unknown>;
    expect(payload.FinancialEventGroupList).toHaveLength(1);
    expect((payload.FinancialEventGroupList as Record<string, unknown>[])[0].FinancialEventGroupId).toBe("FEG-00000001");
  });

  it("filters by FinancialEventGroupStartedAfter / FinancialEventGroupStartedBefore", async () => {
    mockFind.mockReturnValue([
      makeSettlementGroup({ FinancialEventGroupId: "FEG-A", FinancialEventGroupStart: "2026-01-01T00:00:00Z" }),
      makeSettlementGroup({ FinancialEventGroupId: "FEG-B", FinancialEventGroupStart: "2026-06-01T00:00:00Z" }),
      makeSettlementGroup({ FinancialEventGroupId: "FEG-C", FinancialEventGroupStart: "2026-12-01T00:00:00Z" }),
    ]);

    const result = await listFinancialEventGroupsHandler(
      makeValidationResult("listFinancialEventGroups", "v0", { FinancialEventGroupStartedAfter: "2026-02-01T00:00:00Z", FinancialEventGroupStartedBefore: "2026-11-01T00:00:00Z" }),
      {} as any,
    );

    const body = result.data.body as Record<string, unknown>;
    const groups = (body.payload as Record<string, unknown>).FinancialEventGroupList as Record<string, unknown>[];
    expect(groups.map((g) => g.FinancialEventGroupId)).toEqual(["FEG-B"]);
  });

  it("defaults to a page size of 10, per the published model's documented default", async () => {
    mockFind.mockReturnValue(Array.from({ length: 15 }, (_value, i) => makeSettlementGroup({ FinancialEventGroupId: `FEG-${String(i)}`, FinancialEventGroupStart: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z` })));

    const result = await listFinancialEventGroupsHandler(makeValidationResult("listFinancialEventGroups", "v0"), {} as any);

    const body = result.data.body as Record<string, unknown>;
    const payload = body.payload as Record<string, unknown>;
    expect(payload.FinancialEventGroupList).toHaveLength(10);
    expect(typeof payload.NextToken).toBe("string");
  });

  it("honors MaxResultsPerPage up to its documented maximum of 100", async () => {
    mockFind.mockReturnValue(Array.from({ length: 50 }, (_value, i) => makeSettlementGroup({ FinancialEventGroupId: `FEG-${String(i)}`, FinancialEventGroupStart: `2026-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z` })));

    const result = await listFinancialEventGroupsHandler(makeValidationResult("listFinancialEventGroups", "v0", { MaxResultsPerPage: "50" }), {} as any);

    const body = result.data.body as Record<string, unknown>;
    const payload = body.payload as Record<string, unknown>;
    expect(payload.FinancialEventGroupList).toHaveLength(50);
    expect(payload.NextToken).toBeUndefined();
  });
});
