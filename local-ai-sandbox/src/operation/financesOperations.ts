import { OperationHandler } from "./operationTypes.js";
import { Api, Context } from "../database/Context.js";
import { Paginator } from "../service/Paginator.js";

// Finances 2024-06-19 listTransactions has no documented page-size parameter (nextToken only,
// server decides page size); 100 matches the other local handlers' conservative page caps.
const transactionsPaginator = new Paginator({ defaultPageSize: 100, maxPageSize: 100 });

// Finances v0 listFinancialEventGroups: "MaxResultsPerPage ... Default: 10 ... maximum: 100."
const eventGroupsPaginator = new Paginator({ defaultPageSize: 10, maxPageSize: 100 });

/** Strips LokiJS internal fields from every document in a partition. */
function allDocsIn(api: Api): Record<string, unknown>[] {
  const collection = Context.instance.engine.getCollection(api);
  if (!collection) return [];
  return collection.find().map((d) => {
    const { $loki, meta, _key, ...rest } = d as Record<string, unknown>;
    return rest;
  });
}

// --- listTransactions (Finances 2024-06-19) ---

interface RelatedIdentifier {
  relatedIdentifierName?: string;
  relatedIdentifierValue?: string;
}

interface StoredTransaction extends Record<string, unknown> {
  transactionId: string;
  postedDate?: string;
  transactionStatus?: string;
  marketplaceDetails?: { marketplaceId?: string };
  relatedIdentifiers?: RelatedIdentifier[];
}

/** Transactions share the "finances" partition with settlement groups; this is the shape marker. */
function isTransaction(doc: Record<string, unknown>): doc is StoredTransaction {
  return typeof doc.transactionId === "string";
}

function hasRelatedIdentifier(transaction: StoredTransaction, name: string, value: string): boolean {
  return (transaction.relatedIdentifiers ?? []).some((ri) => ri.relatedIdentifierName === name && ri.relatedIdentifierValue === value);
}

export const listTransactionsHandler: OperationHandler = async (validationResult) => {
  const { queryParams } = validationResult;
  const postedAfter = queryParams.postedAfter as string | undefined;
  const postedBefore = queryParams.postedBefore as string | undefined;
  const marketplaceId = queryParams.marketplaceId as string | undefined;
  const transactionStatus = queryParams.transactionStatus as string | undefined;
  const relatedIdentifierName = queryParams.relatedIdentifierName as string | undefined;
  const relatedIdentifierValue = queryParams.relatedIdentifierValue as string | undefined;
  const nextToken = queryParams.nextToken as string | undefined;

  let transactions = allDocsIn(Api.FINANCES).filter(isTransaction);

  // "The response includes financial events posted on or after this date."
  if (postedAfter !== undefined) {
    const after = new Date(postedAfter).getTime();
    transactions = transactions.filter((t) => t.postedDate !== undefined && new Date(t.postedDate).getTime() >= after);
  }
  // "...posted before (but not on) this date."
  if (postedBefore !== undefined) {
    const before = new Date(postedBefore).getTime();
    transactions = transactions.filter((t) => t.postedDate !== undefined && new Date(t.postedDate).getTime() < before);
  }
  if (marketplaceId !== undefined) {
    transactions = transactions.filter((t) => t.marketplaceDetails?.marketplaceId === marketplaceId);
  }
  if (transactionStatus !== undefined) {
    transactions = transactions.filter((t) => t.transactionStatus === transactionStatus);
  }
  // Per the model: "FINANCIAL_EVENT_GROUP_ID and ORDER_ID are the only relatedIdentifier with
  // filtering capabilities at the moment" — both are supported here via the same mechanism.
  if (relatedIdentifierName !== undefined && relatedIdentifierValue !== undefined) {
    transactions = transactions.filter((t) => hasRelatedIdentifier(t, relatedIdentifierName, relatedIdentifierValue));
  }

  // Stable, deterministic ordering (oldest posted first) so paging through nextToken never
  // skips or repeats a record between calls.
  transactions.sort((a, b) => new Date(a.postedDate ?? 0).getTime() - new Date(b.postedDate ?? 0).getTime());

  const paginationResult = transactionsPaginator.paginate(transactions, { pageToken: nextToken });

  const payload: Record<string, unknown> = { transactions: paginationResult.page };
  if (paginationResult.nextToken) payload.nextToken = paginationResult.nextToken;

  return {
    statusCode: 200,
    operationId: validationResult.operationId,
    apiName: validationResult.apiName,
    apiVersion: validationResult.apiVersion,
    pathParams: validationResult.pathParams,
    queryParams: validationResult.queryParams,
    body: undefined,
    operation: validationResult.operation,
    resolvedEntities: validationResult.resolvedEntities,
    data: { body: { payload } },
  };
};

// --- listFinancialEventGroups (Finances v0) ---

interface StoredFinancialEventGroup extends Record<string, unknown> {
  FinancialEventGroupId: string;
  FinancialEventGroupStart?: string;
}

/** Settlement groups share the "finances" partition with transactions; this is the shape marker. */
function isFinancialEventGroup(doc: Record<string, unknown>): doc is StoredFinancialEventGroup {
  return typeof doc.FinancialEventGroupId === "string";
}

export const listFinancialEventGroupsHandler: OperationHandler = async (validationResult) => {
  const { queryParams } = validationResult;
  const maxResultsPerPage = queryParams.MaxResultsPerPage as string | undefined;
  const startedAfter = queryParams.FinancialEventGroupStartedAfter as string | undefined;
  const startedBefore = queryParams.FinancialEventGroupStartedBefore as string | undefined;
  const nextToken = queryParams.NextToken as string | undefined;

  let groups = allDocsIn(Api.FINANCES).filter(isFinancialEventGroup);

  // "...opened after (or at) a specified date and time."
  if (startedAfter !== undefined) {
    const after = new Date(startedAfter).getTime();
    groups = groups.filter((g) => g.FinancialEventGroupStart !== undefined && new Date(g.FinancialEventGroupStart).getTime() >= after);
  }
  // "...opened before (but not at) a specified date and time."
  if (startedBefore !== undefined) {
    const before = new Date(startedBefore).getTime();
    groups = groups.filter((g) => g.FinancialEventGroupStart !== undefined && new Date(g.FinancialEventGroupStart).getTime() < before);
  }

  // Oldest first, same rationale as listTransactions: deterministic paging.
  groups.sort((a, b) => new Date(a.FinancialEventGroupStart ?? 0).getTime() - new Date(b.FinancialEventGroupStart ?? 0).getTime());

  const paginationResult = eventGroupsPaginator.paginate(groups, { pageSize: maxResultsPerPage, pageToken: nextToken });

  const payload: Record<string, unknown> = { FinancialEventGroupList: paginationResult.page };
  if (paginationResult.nextToken) payload.NextToken = paginationResult.nextToken;

  return {
    statusCode: 200,
    operationId: validationResult.operationId,
    apiName: validationResult.apiName,
    apiVersion: validationResult.apiVersion,
    pathParams: validationResult.pathParams,
    queryParams: validationResult.queryParams,
    body: undefined,
    operation: validationResult.operation,
    resolvedEntities: validationResult.resolvedEntities,
    data: { body: { payload } },
  };
};
