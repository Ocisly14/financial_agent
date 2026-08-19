import { validate } from "./schemas.ts";
import type { RegisteredTool } from "../toolRegistry.ts";
import type { JsonObject, JsonSchema, JsonValue, ToolExecutionResult } from "../../src/framework/types.ts";
import type { ToolExecutionContext } from "../toolRegistry.ts";
export { runKey, runStateStore } from "../toolRegistry.ts";
import type { ModelStore } from "../../src/financial-model/store.ts";
import type { FinancialModelSnapshot } from "../../src/financial-model/operations.ts";
import type { RevisionChangeSummary } from "../../src/financial-model/service.ts";
import { CANONICAL_MAPPING_IDS, REQUIRED_MAPPING_IDS } from "../../src/financial-model/skeleton.ts";
import { identitiesByLineItem } from "../../src/financial-model/reconciliation.ts";
import { buildConceptInventory } from "../../src/infra/xbrl/conceptInventory.ts";
import { buildAxisCatalog, buildAxisBreakdown } from "../../src/infra/xbrl/dimensionInventory.ts";
import type { SourceReviewStore } from "../../src/infra/xbrl/sourceReviewStore.ts";
import type { FilingTableStore } from "../../src/infra/xbrl/filingTableStore.ts";
import { FinancialModelError } from "../../src/financial-model/errors.ts";

/**
 * Wraps a synchronous body — these read from stores already in memory — as an ordinary MCP tool, so
 * the DCF subagents call the same shape of tool as every other agent and can reach the shared ones
 * (`invoke_skill`, `read_skill_reference`) without an adapter. A thrown error becomes an error
 * result: the subagent reads the message and corrects on its next round.
 */
export function subagentTool(
  definition: Omit<RegisteredTool, "execute">,
  body: (input: JsonObject, context: ToolExecutionContext) => JsonValue | Promise<JsonValue>,
): RegisteredTool {
  return {
    ...definition,
    execute: async (input: JsonObject, context: ToolExecutionContext): Promise<ToolExecutionResult> => {
      try {
        return { summary: `${definition.name} ok`, generation_context: { data: await body(input, context) as JsonObject } };
      } catch (error) {
        // Returned rather than thrown: the subagent reads the message and corrects on its next round.
        const message = error instanceof Error ? error.message : String(error);
        // Do not flatten a typed model error into `subagent_tool_failed`: callers
        // use its code and details to decide whether to refresh, reconcile, or
        // correct a specific cell. Generic mapping failures retain their stable
        // wrapper code and still expose the message.
        const code = error instanceof FinancialModelError ? error.code : "subagent_tool_failed";
        const details = error instanceof FinancialModelError ? error.details ?? {} : {};
        return { summary: message, error: { code, message }, generation_context: { data: { error: code, ...details } } };
      }
    },
  };
}


export type MappingSubagentDeps = {
  modelStore: ModelStore<FinancialModelSnapshot, RevisionChangeSummary>;
  sourceReviewStore: SourceReviewStore;
  /** Absent: the dimension-exploration tools refuse with a clear message instead of exploring. */
  tableStore?: FilingTableStore;
};

export const SYMBOL_INPUT: JsonSchema = { type: "object", additionalProperties: false, required: ["symbol"],
  properties: { symbol: { type: "string", description: "Ticker named in the orchestrator's instruction." } } };

export const AXIS_INPUT: JsonSchema = { type: "object", additionalProperties: false, required: ["symbol", "axisQName", "conceptQName"],
  properties: { symbol: { type: "string" }, axisQName: { type: "string" }, conceptQName: { type: "string" },
    memberFilter: { type: "string" }, cursor: { type: "number" } } };

/**
 * Resolves the ticker the subagent was told to work on to the one owned model holding its data.
 * Ownership is the caller's tenant, read from the execution context — the same value the rest of the
 * model tools scope by.
 */
export function resolveModel(deps: MappingSubagentDeps, tenantId: string, raw: JsonObject, schema: JsonSchema): { modelId: string; symbol: string } {
  validate(raw, schema, "$", true);
  const symbol = String(raw["symbol"]).trim().toUpperCase();
  const owned = deps.modelStore.list({ ownerTenantId: tenantId, symbol });
  if (owned.length === 0) throw new Error(`no model holds extracted data for ${symbol}; run extract_filing_statements and create_financial_model first`);
  // Ambiguity is the orchestrator's to resolve, not something to guess at: picking the newest model
  // would silently map into a workbook nobody asked for.
  if (owned.length > 1) throw new Error(`${owned.length} models exist for ${symbol}; the orchestrator must archive the stale ones first`);
  return { modelId: owned[0]!.modelId, symbol };
}

/** Shared setup for the two dimension-exploration tools: resolve the model, then the run's tables and periods. */
export function dimensionContext(deps: MappingSubagentDeps, tenantId: string, raw: JsonObject, schema: JsonSchema) {
  if (!deps.tableStore) throw new Error("dimension exploration is unavailable: no filing table store is configured");
  const { modelId, symbol } = resolveModel(deps, tenantId, raw, schema);
  const review = deps.sourceReviewStore.get(modelId);
  if (!review) throw new Error(`no source review stored for ${symbol}`);
  return { symbol, review,
    tables: deps.tableStore.getRunTables(review.ingestionRunId),
    requestedPeriods: review.statementViews.income_statement.candidate.periods };
}

/**
 * The spine target vocabulary, as the mapping subagent needs to see it. It is handed over with the
 * statements rather than through a tool of its own because the two are read together: a mapping
 * decision is rows on one side, ids on the other, and an agent that has to ask twice will sometimes
 * only ask once. Required ids come first because they are the ones it owes an answer for — mapped,
 * or written up as a spine gap.
 */
/**
 * Scope notes for targets an issuer's own statement names the same way but means differently. The
 * identities below say what the engine checks; these say what the id covers, which is the half the
 * label cannot carry. Amazon prints "Total operating expenses" INCLUDING cost of sales, and mapping
 * that onto `operating_expenses` double-counts COGS against the operating_income identity.
 */
const TARGET_SCOPE: Record<string, string> = {
  operating_expenses: "Operating costs EXCLUDING cost_of_revenue. An issuer line named \"total operating "
    + "expenses\" usually includes cost of sales and is NOT this row — map the non-COGS components, or a "
    + "total net of them.",
  cost_of_revenue: "Cost of sales / cost of revenue only. Everything else operating belongs to operating_expenses.",
  gross_profit: "Revenue less cost_of_revenue. Derive it when the issuer presents no gross profit line.",
  cash_available_for_bridge: "Cash the equity bridge may net against debt — not every balance labelled cash.",
};

/**
 * The canonical targets, each with the identity that will judge the mapping.
 *
 * The ids used to travel alone. A mapper reading `operating_expenses` next to an issuer line labelled
 * "Total operating expenses" maps them together, and only downstream — when the engine checks
 * `operating_income = gross_profit - operating_expenses` — does the double-counted COGS surface, as
 * five failed reconciliations for someone else to diagnose. The rule that decides correctness has to
 * travel with the thing being decided.
 */
export function spineTargets(): { required: string[]; optional: string[]; semantics: Record<string, string> } {
  const required = [...CANONICAL_MAPPING_IDS].filter((id) => REQUIRED_MAPPING_IDS.has(id));
  const identities = identitiesByLineItem();
  const semantics: Record<string, string> = {};
  for (const id of CANONICAL_MAPPING_IDS) {
    const parts = [TARGET_SCOPE[id], ...(identities.get(id) ?? []).map((equation) => `The engine checks: ${equation}.`)]
      .filter((part): part is string => part !== undefined && part.length > 0);
    if (parts.length > 0) semantics[id] = parts.join(" ");
  }
  return { required, optional: [...CANONICAL_MAPPING_IDS].filter((id) => !REQUIRED_MAPPING_IDS.has(id)), semantics };
}
