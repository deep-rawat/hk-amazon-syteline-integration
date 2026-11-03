/**
 * HubKor demo data utility for the Amazon FBA to SyteLine integration simulator.
 *
 * Seeds, clears and verifies the synthetic demo data set against a running sandbox, using
 * only the sandbox's existing data management endpoints (/manage/orders, /manage/finances/*)
 * and its public SP-API routes. It never writes to the database directly, so it works against
 * a sandbox running on this machine or on another host.
 *
 * Usage (the sandbox must be running, see "npm run dev"):
 *   npm run demo:seed          seed the synthetic FBA orders (replaces any existing demo orders)
 *   npm run demo:clear         remove the demo orders, leaving everything else untouched
 *   npm run demo:reset         clear, then seed
 *   npm run demo:verify        check that the Orders API returns the expected records
 *   npm run demo:status        show which demo orders are currently loaded
 *   npm run finances:seed      generate transactions/settlements for the orders already seeded
 *   npm run finances:clear     remove generated finance records, leaving orders untouched
 *   npm run finances:reset     clear, then seed finances
 *   npm run finances:verify    check the Finances APIs reconcile against the seeded orders
 *
 * Finances seeding reads whatever orders are currently in the sandbox (via the Orders API,
 * not by re-deriving them), so run demo:seed (or otherwise have orders present) first.
 *
 * Environment:
 *   SANDBOX_URL   base URL of the sandbox (default http://localhost:9001)
 *   DEMO_SEED     PRNG seed for the generated orders (default 20260101)
 *   DEMO_COUNT    number of orders to generate (default 270)
 *   FINANCES_SEED PRNG seed for the generated financial data (default 20260615)
 */
import {
  DEFAULT_ORDER_COUNT,
  DEFAULT_SEED,
  DEMO_PREFIX,
  US_MARKETPLACE_ID,
  demoOrderIds,
  generateFbaOrders,
  parseCents,
  type OrderRecord,
} from "./demo/syntheticFbaOrders.js";
import { DEFAULT_FINANCES_SEED, generateFinancialData, checkReconciliation, type Transaction, type FinancialEventGroup } from "./demo/syntheticFinances.js";

const BASE_URL = (process.env.SANDBOX_URL ?? "http://localhost:9001").replace(/\/+$/, "");
const SEED = Number.parseInt(process.env.DEMO_SEED ?? String(DEFAULT_SEED), 10);
const COUNT = Number.parseInt(process.env.DEMO_COUNT ?? String(DEFAULT_ORDER_COUNT), 10);
const FINANCES_SEED = Number.parseInt(process.env.FINANCES_SEED ?? String(DEFAULT_FINANCES_SEED), 10);

/** 3-7-7, the identifier format the Orders 2026-01-01 model requires. */
const ID_PATTERN = /^\d{3}-\d{7}-\d{7}$/;

/** Order sections the verifier asks for. Everything the demo data populates. */
const INCLUDED_DATA = "FULFILLMENT,PROCEEDS,TAX,PAYMENT,PROMOTION,CANCELLATION";

// --- HTTP helpers ---

interface HttpResult {
  status: number;
  body: unknown;
}

async function request(method: string, path: string, body?: unknown): Promise<HttpResult> {
  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    throw new Error(`Cannot reach the sandbox at ${BASE_URL}. Is it running? (${String(error)})`);
  }

  const text = await response.text();
  let parsed: unknown = undefined;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: response.status, body: parsed };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** ISO timestamp far enough in the past to catch every demo order. */
function searchWindowStart(): string {
  return new Date(Date.now() - 400 * 24 * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Follows searchOrders' pagination.nextToken until exhausted, so this works for any COUNT. */
async function searchDemoOrders(extraQuery = ""): Promise<Record<string, unknown>[]> {
  const baseQuery = `createdAfter=${searchWindowStart()}&marketplaceIds=${US_MARKETPLACE_ID}&includedData=${INCLUDED_DATA}${extraQuery}`;
  const expected = new Set(demoOrderIds(COUNT));
  const collected: Record<string, unknown>[] = [];

  let paginationToken: string | undefined;
  do {
    const query = paginationToken ? `${baseQuery}&paginationToken=${encodeURIComponent(paginationToken)}` : baseQuery;
    const result = await request("GET", `/orders/2026-01-01/orders?${query}`);
    if (result.status !== 200) {
      throw new Error(`searchOrders returned ${String(result.status)}: ${JSON.stringify(result.body)}`);
    }
    const body = asRecord(result.body);
    collected.push(...asArray(body.orders).map(asRecord));
    paginationToken = asRecord(body.pagination).nextToken as string | undefined;
  } while (paginationToken !== undefined);

  return collected.filter((order) => expected.has(String(order.orderId)));
}

/**
 * Every order currently in the sandbox, not just the known demo ID set — finances are
 * generated from whatever orders actually exist, generically, the same way a real
 * integration would read them.
 */
async function fetchAllOrders(): Promise<OrderRecord[]> {
  const baseQuery = `createdAfter=${searchWindowStart()}&marketplaceIds=${US_MARKETPLACE_ID}&includedData=FULFILLMENT`;
  const collected: OrderRecord[] = [];

  let paginationToken: string | undefined;
  do {
    const query = paginationToken ? `${baseQuery}&paginationToken=${encodeURIComponent(paginationToken)}` : baseQuery;
    const result = await request("GET", `/orders/2026-01-01/orders?${query}`);
    if (result.status !== 200) {
      throw new Error(`searchOrders returned ${String(result.status)}: ${JSON.stringify(result.body)}`);
    }
    const body = asRecord(result.body);
    collected.push(...(asArray(body.orders) as OrderRecord[]));
    paginationToken = asRecord(body.pagination).nextToken as string | undefined;
  } while (paginationToken !== undefined);

  return collected;
}

/** Follows listTransactions' pagination.nextToken until exhausted, for an exact query string (no implicit base param). */
async function fetchAllTransactionsByQuery(query: string): Promise<Record<string, unknown>[]> {
  const collected: Record<string, unknown>[] = [];

  let nextToken: string | undefined;
  do {
    const pageQuery = nextToken ? `${query}&nextToken=${encodeURIComponent(nextToken)}` : query;
    const result = await request("GET", `/finances/2024-06-19/transactions?${pageQuery}`);
    if (result.status !== 200) {
      throw new Error(`listTransactions returned ${String(result.status)}: ${JSON.stringify(result.body)}`);
    }
    const payload = asRecord(asRecord(result.body).payload);
    collected.push(...asArray(payload.transactions).map(asRecord));
    nextToken = payload.nextToken as string | undefined;
  } while (nextToken !== undefined);

  return collected;
}

/** Follows listTransactions' pagination.nextToken until exhausted, widened to catch every demo transaction. */
async function fetchAllTransactions(extraQuery = ""): Promise<Record<string, unknown>[]> {
  return fetchAllTransactionsByQuery(`postedAfter=${searchWindowStart()}${extraQuery}`);
}

/** Follows listFinancialEventGroups' pagination.NextToken until exhausted. */
async function fetchAllSettlementGroups(): Promise<Record<string, unknown>[]> {
  const collected: Record<string, unknown>[] = [];

  let nextToken: string | undefined;
  do {
    const query = nextToken ? `NextToken=${encodeURIComponent(nextToken)}` : "MaxResultsPerPage=100";
    const result = await request("GET", `/finances/v0/financialEventGroups?${query}`);
    if (result.status !== 200) {
      throw new Error(`listFinancialEventGroups returned ${String(result.status)}: ${JSON.stringify(result.body)}`);
    }
    const payload = asRecord(asRecord(result.body).payload);
    collected.push(...asArray(payload.FinancialEventGroupList).map(asRecord));
    nextToken = payload.NextToken as string | undefined;
  } while (nextToken !== undefined);

  return collected;
}

// --- Commands ---

async function clear(quiet = false): Promise<number> {
  let removed = 0;
  for (const orderId of demoOrderIds(COUNT)) {
    const result = await request("DELETE", `/manage/orders/${orderId}`);
    if (result.status === 200) removed++;
  }
  if (!quiet) {
    console.log(`Removed ${String(removed)} demo order(s) from ${BASE_URL}.`);
  }
  return removed;
}

async function seed(): Promise<void> {
  const orders = generateFbaOrders({ seed: SEED, count: COUNT });
  // Re-seeding is meant to be repeatable, so retire the previous set first:
  // /manage/orders rejects an orderId that already exists.
  await clear(true);

  let created = 0;
  for (const order of orders) {
    const result = await request("POST", "/manage/orders", order);
    if (result.status === 201) {
      created++;
    } else {
      console.error(`FAILED ${order.orderId}: HTTP ${String(result.status)} ${JSON.stringify(result.body)}`);
    }
  }

  console.log(`Seeded ${String(created)} of ${String(orders.length)} synthetic FBA orders into ${BASE_URL}.`);
  printSummary(orders);
}

function printSummary(orders: OrderRecord[]): void {
  const statusCounts = new Map<string, number>();
  let grandTotalCents = 0;
  let lineCount = 0;

  for (const order of orders) {
    const status = order.fulfillment.fulfillmentStatus;
    statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1);
    grandTotalCents += parseCents(order.proceeds.grandTotal.amount);
    lineCount += order.orderItems.length;
  }

  console.log("");
  console.log(`  Orders:          ${String(orders.length)} (all FBA, marketplace ${US_MARKETPLACE_ID})`);
  console.log(`  Order lines:     ${String(lineCount)}`);
  console.log(`  Order ID range:  ${orders[0].orderId} to ${orders[orders.length - 1].orderId}`);
  console.log(`  Date range:      ${orders[0].createdTime} to ${orders[orders.length - 1].createdTime}`);
  console.log(`  Gross proceeds:  ${(grandTotalCents / 100).toFixed(2)} USD`);
  console.log(`  Statuses:        ${[...statusCounts].map(([status, n]) => `${status}=${String(n)}`).join(", ")}`);
  console.log("");
}

async function status(): Promise<void> {
  const orders = await searchDemoOrders();
  console.log(`${String(orders.length)} of ${String(COUNT)} demo orders are loaded in ${BASE_URL}.`);
  for (const order of orders) {
    const fulfillment = asRecord(order.fulfillment);
    const proceeds = asRecord(order.proceeds);
    const grandTotal = asRecord(proceeds.grandTotal);
    console.log(
      `  ${String(order.orderId)}  ${String(order.createdTime)}  ${String(fulfillment.fulfillmentStatus).padEnd(18)}` +
        `  lines=${String(asArray(order.orderItems).length)}  total=${String(grandTotal.amount)} ${String(grandTotal.currencyCode)}`,
    );
  }
}

// --- Verification ---

interface Check {
  name: string;
  passed: boolean;
  detail: string;
}

function check(results: Check[], name: string, passed: boolean, detail = ""): void {
  results.push({ name, passed, detail });
}

/** Sums an array of proceeds breakdowns, in cents. */
function sumBreakdowns(breakdowns: unknown): number {
  return asArray(breakdowns).reduce<number>((total, entry) => total + parseCents(String(asRecord(asRecord(entry).subtotal).amount)), 0);
}

function verifyOrderShape(order: Record<string, unknown>, results: Check[]): void {
  const orderId = String(order.orderId);
  const fulfillment = asRecord(order.fulfillment);
  const salesChannel = asRecord(order.salesChannel);
  const items = asArray(order.orderItems).map(asRecord);

  check(results, `${orderId} identifier is 3-7-7`, ID_PATTERN.test(orderId), orderId);
  check(results, `${orderId} is fulfilled by Amazon`, fulfillment.fulfilledBy === "AMAZON", String(fulfillment.fulfilledBy));
  check(results, `${orderId} is on the US marketplace`, salesChannel.marketplaceId === US_MARKETPLACE_ID, String(salesChannel.marketplaceId));
  check(results, `${orderId} carries no buyer or recipient PII`, !("buyer" in order) && !("recipient" in order));
  check(results, `${orderId} has at least one order line`, items.length > 0, `lines=${String(items.length)}`);

  let itemTotalCents = 0;
  for (const item of items) {
    const itemId = String(item.orderItemId);
    const product = asRecord(item.product);
    const proceeds = asRecord(item.proceeds);
    const quantityOrdered = Number(item.quantityOrdered);
    const unitPriceCents = parseCents(String(asRecord(asRecord(product.price).unitPrice).amount));
    const lineTotalCents = parseCents(String(asRecord(proceeds.proceedsTotal).amount));

    const itemSubtotal = asArray(proceeds.breakdowns)
      .map(asRecord)
      .find((entry) => entry.type === "ITEM");
    const itemSubtotalCents = parseCents(String(asRecord(itemSubtotal?.subtotal).amount));

    check(results, `${itemId} identifier is 3-7-7`, ID_PATTERN.test(itemId), itemId);
    check(results, `${itemId} SKU is demo data`, String(product.sellerSku).startsWith(DEMO_PREFIX), String(product.sellerSku));
    check(results, `${itemId} ITEM subtotal equals unit price times quantity`, itemSubtotalCents === unitPriceCents * quantityOrdered, `${String(itemSubtotalCents)} vs ${String(unitPriceCents * quantityOrdered)}`);
    check(results, `${itemId} line total equals the sum of its breakdowns`, lineTotalCents === sumBreakdowns(proceeds.breakdowns), `${String(lineTotalCents)} vs ${String(sumBreakdowns(proceeds.breakdowns))}`);

    itemTotalCents += lineTotalCents;
  }

  const orderProceeds = asRecord(order.proceeds);
  const grandTotalCents = parseCents(String(asRecord(orderProceeds.grandTotal).amount));
  check(results, `${orderId} grand total equals the sum of its lines`, grandTotalCents === itemTotalCents, `${String(grandTotalCents)} vs ${String(itemTotalCents)}`);
  check(results, `${orderId} grand total equals the sum of its breakdowns`, grandTotalCents === sumBreakdowns(orderProceeds.breakdowns), `${String(grandTotalCents)} vs ${String(sumBreakdowns(orderProceeds.breakdowns))}`);
}

async function verify(): Promise<void> {
  const results: Check[] = [];
  const expectedIds = demoOrderIds(COUNT);

  // 1. Batch retrieval through searchOrders.
  const found = await searchDemoOrders();
  const foundIds = new Set(found.map((order) => String(order.orderId)));
  const missing = expectedIds.filter((id) => !foundIds.has(id));
  check(results, `searchOrders returns all ${String(COUNT)} demo orders`, missing.length === 0, missing.length > 0 ? `missing ${missing.join(", ")}` : "");

  // 2. Per-order structure and arithmetic.
  for (const order of found) {
    verifyOrderShape(order, results);
  }

  // 3. getOrder returns the same record as searchOrders.
  if (expectedIds.length > 0) {
    const sampleId = expectedIds[0];
    const single = await request("GET", `/orders/2026-01-01/orders/${sampleId}?includedData=${INCLUDED_DATA}`);
    const singleOrder = asRecord(asRecord(single.body).order);
    check(results, `getOrder retrieves ${sampleId}`, single.status === 200 && singleOrder.orderId === sampleId, `HTTP ${String(single.status)}`);
  }

  // 4. The data set contains no merchant fulfilled orders.
  const merchantOrders = await searchDemoOrders("&fulfilledBy=MERCHANT");
  check(results, "no demo order is merchant fulfilled", merchantOrders.length === 0, `found ${String(merchantOrders.length)}`);

  // 5. Without includedData the API returns base sections only.
  const baseQuery = `createdAfter=${searchWindowStart()}&marketplaceIds=${US_MARKETPLACE_ID}`;
  const baseResult = await request("GET", `/orders/2026-01-01/orders?${baseQuery}`);
  const baseOrder = asArray(asRecord(baseResult.body).orders)
    .map(asRecord)
    .find((order) => String(order.orderId) === expectedIds[0]);
  check(results, "includedData filtering omits unrequested sections", baseOrder !== undefined && !("proceeds" in baseOrder) && !("fulfillment" in baseOrder));

  // --- Report ---
  const failures = results.filter((result) => !result.passed);
  const summary = new Map<string, { passed: number; failed: number }>();
  for (const result of results) {
    // Collapse the per-order checks into one line per check kind.
    const kind = result.name.replace(/^\d{3}-\d{7}-\d{7} /, "");
    const entry = summary.get(kind) ?? { passed: 0, failed: 0 };
    if (result.passed) entry.passed++;
    else entry.failed++;
    summary.set(kind, entry);
  }

  console.log(`Verifying the demo data set against ${BASE_URL}`);
  console.log("");
  for (const [kind, counts] of summary) {
    const mark = counts.failed === 0 ? "PASS" : "FAIL";
    console.log(`  ${mark}  ${kind} (${String(counts.passed)} passed, ${String(counts.failed)} failed)`);
  }
  console.log("");

  if (failures.length > 0) {
    console.log("Failures:");
    for (const failure of failures.slice(0, 20)) {
      console.log(`  ${failure.name}${failure.detail ? `: ${failure.detail}` : ""}`);
    }
    console.log("");
    console.log(`${String(failures.length)} check(s) failed.`);
    process.exitCode = 1;
    return;
  }

  console.log(`All ${String(results.length)} checks passed.`);
}

// --- Finances Commands ---

/** Removes every generated transaction and settlement group, leaving orders untouched. */
async function clearFinances(quiet = false): Promise<number> {
  const result = await request("GET", "/data");
  const finances = asRecord(asRecord(result.body).finances);
  const records = Object.values(finances).map(asRecord);

  let removed = 0;
  for (const record of records) {
    if (typeof record.transactionId === "string") {
      const del = await request("DELETE", `/manage/finances/transactions/${record.transactionId}`);
      if (del.status === 200) removed++;
    } else if (typeof record.FinancialEventGroupId === "string") {
      const del = await request("DELETE", `/manage/finances/eventGroups/${record.FinancialEventGroupId}`);
      if (del.status === 200) removed++;
    }
  }

  if (!quiet) {
    console.log(`Removed ${String(removed)} finance record(s) from ${BASE_URL}.`);
  }
  return removed;
}

/** Generates transactions/settlement groups from whatever orders currently exist, and seeds them. */
async function seedFinances(): Promise<void> {
  const orders = await fetchAllOrders();
  if (orders.length === 0) {
    console.log(`No orders found in ${BASE_URL}. Run "npm run demo:seed" first.`);
    process.exitCode = 1;
    return;
  }

  const { transactions, settlementGroups } = generateFinancialData(orders, { seed: FINANCES_SEED });
  const discrepancies = checkReconciliation(transactions, settlementGroups);
  if (discrepancies.length > 0) {
    console.error(`Refusing to seed: ${String(discrepancies.length)} generated record(s) do not reconcile.`, discrepancies.slice(0, 5));
    process.exitCode = 1;
    return;
  }

  // Re-seeding is meant to be repeatable, so retire the previous set first.
  await clearFinances(true);

  let createdTransactions = 0;
  for (const transaction of transactions) {
    const result = await request("POST", "/manage/finances/transactions", transaction);
    if (result.status === 201) createdTransactions++;
    else console.error(`FAILED ${transaction.transactionId}: HTTP ${String(result.status)} ${JSON.stringify(result.body)}`);
  }

  let createdGroups = 0;
  for (const group of settlementGroups) {
    const result = await request("POST", "/manage/finances/eventGroups", group);
    if (result.status === 201) createdGroups++;
    else console.error(`FAILED ${group.FinancialEventGroupId}: HTTP ${String(result.status)} ${JSON.stringify(result.body)}`);
  }

  console.log(`Seeded ${String(createdTransactions)} of ${String(transactions.length)} transactions and ${String(createdGroups)} of ${String(settlementGroups.length)} settlement groups into ${BASE_URL}.`);
  printFinancialSummary(transactions, settlementGroups);
}

function printFinancialSummary(transactions: Transaction[], settlementGroups: FinancialEventGroup[]): void {
  const byType = new Map<string, number>();
  const byStatus = new Map<string, number>();
  for (const t of transactions) {
    byType.set(t.transactionType, (byType.get(t.transactionType) ?? 0) + 1);
    byStatus.set(t.transactionStatus, (byStatus.get(t.transactionStatus) ?? 0) + 1);
  }
  const closedGroups = settlementGroups.filter((g) => g.ProcessingStatus === "Closed");
  const totalPayoutCents = closedGroups.reduce((sum, g) => sum + Math.round(g.OriginalTotal.CurrencyAmount * 100), 0);

  console.log("");
  console.log(`  Transactions:       ${String(transactions.length)} (${[...byType].map(([k, n]) => `${k}=${String(n)}`).join(", ")})`);
  console.log(`  Transaction status: ${[...byStatus].map(([k, n]) => `${k}=${String(n)}`).join(", ")}`);
  console.log(`  Settlement groups:  ${String(settlementGroups.length)} (${String(closedGroups.length)} closed, ${String(settlementGroups.length - closedGroups.length)} open)`);
  console.log(`  Total closed payout: ${(totalPayoutCents / 100).toFixed(2)} USD`);
  console.log("");
}

async function financesStatus(): Promise<void> {
  const transactions = await fetchAllTransactions();
  const groups = await fetchAllSettlementGroups();
  console.log(`${String(transactions.length)} transaction(s) and ${String(groups.length)} settlement group(s) loaded in ${BASE_URL}.`);
  if (transactions.length > 0 || groups.length > 0) {
    printFinancialSummary(transactions as unknown as Transaction[], groups as unknown as FinancialEventGroup[]);
  }
}

async function verifyFinances(): Promise<void> {
  const results: Check[] = [];

  const orders = await fetchAllOrders();
  const orderIds = new Set(orders.map((o) => o.orderId));
  const orderById = new Map(orders.map((o) => [o.orderId, o]));

  // 1. Every transaction's ORDER_ID corresponds to an existing, real order.
  const transactions = await fetchAllTransactions();
  const orderRelatedIds = transactions
    .flatMap((t) => asArray(t.relatedIdentifiers).map(asRecord))
    .filter((ri) => ri.relatedIdentifierName === "ORDER_ID")
    .map((ri) => String(ri.relatedIdentifierValue));
  const danglingOrderIds = orderRelatedIds.filter((id) => !orderIds.has(id));
  check(results, "every transaction's ORDER_ID corresponds to an existing order", danglingOrderIds.length === 0, danglingOrderIds.length > 0 ? `dangling: ${danglingOrderIds.slice(0, 5).join(", ")}` : "");

  // 2a. Query by individual order ID returns exactly that order's transactions.
  const shipmentTxn = transactions.find((t) => t.transactionType === "Shipment");
  if (shipmentTxn) {
    const relatedOrderId = asArray(shipmentTxn.relatedIdentifiers)
      .map(asRecord)
      .find((ri) => ri.relatedIdentifierName === "ORDER_ID")?.relatedIdentifierValue as string;
    const byOrder = await fetchAllTransactions(`&relatedIdentifierName=ORDER_ID&relatedIdentifierValue=${encodeURIComponent(relatedOrderId)}`);
    const allMatchOrder = byOrder.every((t) => asArray(t.relatedIdentifiers).map(asRecord).some((ri) => ri.relatedIdentifierName === "ORDER_ID" && ri.relatedIdentifierValue === relatedOrderId));
    check(results, "querying by relatedIdentifierName=ORDER_ID returns only that order's transactions", byOrder.length > 0 && allMatchOrder, `found ${String(byOrder.length)}`);
  }

  // 2b. Query by date range returns only transactions posted within it, and actually narrows
  // the result (not just a no-op): split the known set at its midpoint posted date and confirm
  // the "after" query returns strictly fewer records, all of them on or after the cutoff.
  if (transactions.length > 1) {
    const sortedByDate = [...transactions].sort((a, b) => new Date(String(a.postedDate)).getTime() - new Date(String(b.postedDate)).getTime());
    const midpoint = sortedByDate[Math.floor(sortedByDate.length / 2)];
    const postedAfter = String(midpoint.postedDate);
    const windowed = await fetchAllTransactionsByQuery(`postedAfter=${encodeURIComponent(postedAfter)}`);
    const allWithinWindow = windowed.every((t) => new Date(String(t.postedDate)).getTime() >= new Date(postedAfter).getTime());
    const actuallyNarrowed = windowed.length < transactions.length;
    check(
      results,
      "querying by postedAfter returns only (and strictly fewer) transactions posted on or after it",
      allWithinWindow && actuallyNarrowed,
      `windowed=${String(windowed.length)} of ${String(transactions.length)}`,
    );
  }

  // 3. Pagination: listTransactions has no caller-controlled page size, so a large result set
  // is what actually forces multiple pages. Confirm a raw first page is capped (pagination is
  // really happening, not one giant page) and that `transactions` above — already assembled by
  // following nextToken — has no duplicates and matches the single-page count when it fits.
  const firstPage = await request("GET", `/finances/2024-06-19/transactions?postedAfter=${searchWindowStart()}`);
  const firstPagePayload = asRecord(asRecord(firstPage.body).payload);
  const firstPageCount = asArray(firstPagePayload.transactions).length;
  const nextTokenPresent = typeof firstPagePayload.nextToken === "string";
  check(
    results,
    "a result set larger than one page is split across pages (nextToken present)",
    transactions.length <= firstPageCount || nextTokenPresent,
    `firstPage=${String(firstPageCount)}, total=${String(transactions.length)}`,
  );
  const pagedIds = transactions.map((t) => String(t.transactionId));
  check(results, "pagination returns all transactions without duplicates", new Set(pagedIds).size === pagedIds.length, `${String(pagedIds.length)} records, ${String(new Set(pagedIds).size)} unique`);

  // 4 & 5. Fees/adjustments reconcile per order, and settlement groups reconcile to payouts.
  const groups = await fetchAllSettlementGroups();
  const discrepancies = checkReconciliation(transactions as unknown as Transaction[], groups as unknown as FinancialEventGroup[]);
  check(results, "every transaction's totalAmount equals the sum of its breakdowns", discrepancies.filter((d) => d.kind === "order").length === 0, JSON.stringify(discrepancies.filter((d) => d.kind === "order").slice(0, 3)));
  check(results, "every settlement group's OriginalTotal equals the sum of its transactions", discrepancies.filter((d) => d.kind === "group").length === 0, JSON.stringify(discrepancies.filter((d) => d.kind === "group").slice(0, 3)));

  // 6. Only SHIPPED/PARTIALLY_SHIPPED orders have a Shipment transaction; nothing posted early.
  const shipmentOrderIds = new Set(
    transactions.filter((t) => t.transactionType === "Shipment").flatMap((t) => asArray(t.relatedIdentifiers).map(asRecord).filter((ri) => ri.relatedIdentifierName === "ORDER_ID").map((ri) => String(ri.relatedIdentifierValue))),
  );
  const wronglyEligible = [...shipmentOrderIds].filter((id) => {
    const order = orderById.get(id);
    const status = order?.fulfillment.fulfillmentStatus;
    return status !== "SHIPPED" && status !== "PARTIALLY_SHIPPED";
  });
  check(results, "only SHIPPED/PARTIALLY_SHIPPED orders have a Shipment transaction", wronglyEligible.length === 0, `unexpected: ${wronglyEligible.slice(0, 5).join(", ")}`);

  const now = Date.now();
  const futurePosted = transactions.filter((t) => new Date(String(t.postedDate)).getTime() > now);
  check(results, "no transaction is posted in the future", futurePosted.length === 0, `found ${String(futurePosted.length)}`);

  // --- Report ---
  const failures = results.filter((r) => !r.passed);
  console.log(`Verifying finances data against ${BASE_URL}`);
  console.log("");
  for (const result of results) {
    console.log(`  ${result.passed ? "PASS" : "FAIL"}  ${result.name}${result.detail ? ` (${result.detail})` : ""}`);
  }
  console.log("");

  if (failures.length > 0) {
    console.log(`${String(failures.length)} check(s) failed.`);
    process.exitCode = 1;
    return;
  }
  console.log(`All ${String(results.length)} checks passed.`);
}

// --- Entry point ---

async function main(): Promise<void> {
  const command = process.argv[2] ?? "help";

  switch (command) {
    case "seed":
      await seed();
      break;
    case "clear":
      await clear();
      break;
    case "reset":
      await clear();
      await seed();
      break;
    case "verify":
      await verify();
      break;
    case "status":
      await status();
      break;
    case "seed-finances":
      await seedFinances();
      break;
    case "clear-finances":
      await clearFinances();
      break;
    case "reset-finances":
      await clearFinances();
      await seedFinances();
      break;
    case "verify-finances":
      await verifyFinances();
      break;
    case "status-finances":
      await financesStatus();
      break;
    default:
      console.log("Usage: tsx scripts/demoData.ts <seed|clear|reset|verify|status|seed-finances|clear-finances|reset-finances|verify-finances|status-finances>");
      console.log("Environment: SANDBOX_URL, DEMO_SEED, DEMO_COUNT, FINANCES_SEED");
      process.exitCode = command === "help" ? 0 : 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
