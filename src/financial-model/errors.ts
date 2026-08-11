import type { JsonObject } from "../framework/types.ts";

export type FinancialModelErrorCode =
  | "financial_model_not_found"
  | "revision_conflict"
  | "invalid_snapshot"
  | "fact_conflict"
  | "invalid_model_operation"
  | "invalid_model_query"
  | "invalid_assumption"
  | "invalid_formula"
  | "circular_dependency"
  | "incompatible_units"
  | "incompatible_periods"
  | "history_review_required"
  | "unresolved_reconciliation"
  | "invalid_terminal_assumptions"
  | "incomplete_equity_bridge"
  | "missing_formula_input";

/** Mirrors the SecApiError pattern in mcp_tools/sec/secClient.ts: a typed code
 * plus structured details, so callers branch on `code` rather than on message
 * text. A thrown error means nothing was written. */
export class FinancialModelError extends Error {
  readonly code: FinancialModelErrorCode;
  readonly details?: JsonObject;

  constructor(code: FinancialModelErrorCode, message: string, details?: JsonObject) {
    super(message);
    this.name = "FinancialModelError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
