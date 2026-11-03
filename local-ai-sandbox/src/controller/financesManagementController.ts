import { Request, Response } from "express";
import { Api, Context } from "../database/Context.js";

/**
 * Finances test-data management endpoints, mirroring ordersManagementController.ts.
 *
 * Amazon's real Finances API has no "create a transaction" operation — transactions and
 * settlement groups are produced by Amazon's backend from real purchase/shipment/payout
 * events, and sellers can only query them. Exactly like Orders, this side channel exists
 * purely so synthetic test data can be seeded into the sandbox; it is not part of the SP-API
 * surface and is not validated against the Finances OpenAPI models.
 *
 * Both entity shapes share the Api.FINANCES partition (distinguished by which ID field is
 * present, the same shape-based convention used for Reports' reports/schedules), so both
 * handlers below key on a caller-supplied ID field rather than generating one.
 */

/** Builds create/update/delete handlers for one entity shape within a shared partition. */
function makeManagementHandlers(idField: string, entityLabel: string) {
  const create = async (req: Request, res: Response): Promise<void> => {
    try {
      const body: unknown = req.body;
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        res.status(400).json({ error: "Request body must be a valid JSON object" });
        return;
      }

      const entity = body as Record<string, unknown>;
      const id = entity[idField] as string | undefined;

      if (!id) {
        res.status(400).json({ error: `Request body must contain a ${idField} field` });
        return;
      }

      const existing = Context.instance.engine.get(Api.FINANCES, id);
      if (existing) {
        res.status(409).json({ error: `${entityLabel} with ${idField} '${id}' already exists` });
        return;
      }

      Context.instance.engine.put(Api.FINANCES, id, entity);
      res.status(201).json({ [idField]: id });
    } catch (error) {
      console.error(`Error creating ${entityLabel}:`, error);
      res.status(500).json({ error: "Internal server error" });
    }
  };

  const update = async (req: Request, res: Response): Promise<void> => {
    try {
      const body: unknown = req.body;
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        res.status(400).json({ error: "Request body must be a valid JSON object" });
        return;
      }

      const entity = body as Record<string, unknown>;
      const id = entity[idField] as string | undefined;

      if (!id) {
        res.status(400).json({ error: `Request body must contain a ${idField} field` });
        return;
      }

      const existing = Context.instance.engine.get(Api.FINANCES, id);
      if (!existing) {
        res.status(404).json({ error: `${entityLabel} with ${idField} '${id}' not found` });
        return;
      }

      Context.instance.engine.put(Api.FINANCES, id, entity);
      const updated = Context.instance.engine.get(Api.FINANCES, id);
      res.status(200).json({ [entityLabel]: updated });
    } catch (error) {
      console.error(`Error updating ${entityLabel}:`, error);
      res.status(500).json({ error: "Internal server error" });
    }
  };

  const remove = async (req: Request, res: Response): Promise<void> => {
    try {
      const id = req.params.id as string | undefined;

      if (!id) {
        res.status(400).json({ error: `${idField} path parameter is required` });
        return;
      }

      const existing = Context.instance.engine.get(Api.FINANCES, id);
      if (!existing) {
        res.status(404).json({ error: `${entityLabel} with ${idField} '${id}' not found` });
        return;
      }

      await Context.instance.engine.remove(Api.FINANCES, id);
      res.status(200).json({ message: `${entityLabel} '${id}' deleted successfully` });
    } catch (error) {
      console.error(`Error deleting ${entityLabel}:`, error);
      res.status(500).json({ error: "Internal server error" });
    }
  };

  return { create, update, remove };
}

const transactionHandlers = makeManagementHandlers("transactionId", "Transaction");
export const createTransaction = transactionHandlers.create;
export const updateTransaction = transactionHandlers.update;
export const deleteTransaction = transactionHandlers.remove;

// PascalCase ID field, matching the Finances v0 (financialEventGroups) schema's own casing.
const financialEventGroupHandlers = makeManagementHandlers("FinancialEventGroupId", "Financial event group");
export const createFinancialEventGroup = financialEventGroupHandlers.create;
export const updateFinancialEventGroup = financialEventGroupHandlers.update;
export const deleteFinancialEventGroup = financialEventGroupHandlers.remove;
