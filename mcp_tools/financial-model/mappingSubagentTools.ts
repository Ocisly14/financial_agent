import { validate } from "./schemas.ts";
import type { JsonObject, JsonSchema, JsonValue, ToolDefinition } from "../../src/framework/types.ts";
import type { ModelStore } from "../../src/financial-model/store.ts";
import type { FinancialModelSnapshot } from "../../src/financial-model/operations.ts";
import type { RevisionChangeSummary } from "../../src/financial-model/service.ts";
import { buildConceptInventory } from "../../src/infra/xbrl/conceptInventory.ts";
import { buildAxisCatalog, buildAxisBreakdown } from "../../src/infra/xbrl/dimensionInventory.ts";
import type { SourceReviewStore } from "../../src/infra/xbrl/sourceReviewStore.ts";
import type { FilingTableStore } from "../../src/infra/xbrl/filingTableStore.ts";

export type LoopTool = ToolDefinition & { execute(input: JsonObject): JsonValue };

export type MappingSubagentDeps = {
  modelStore: ModelStore<FinancialModelSnapshot, RevisionChangeSummary>;
  sourceReviewStore: SourceReviewStore;
  ownerAgentId: string;
  /** Absent: the dimension-exploration tools are not registered (older callers / tests are unaffected). */
  tableStore?: FilingTableStore;
};

/**
 * What a mapping subagent loaded, so the host can check it against the model the orchestrator named.
 * A subagent that loads the wrong issuer would otherwise map one company's statements onto another's
 * workbook, and every downstream check would pass — the numbers are internally consistent, just not
 * this company's.
 */
export type LoadedWorkingSet = { symbol: string; modelId: string };

const SYMBOL_INPUT: JsonSchema = { type: "object", additionalProperties: false, required: ["symbol"],
  properties: { symbol: { type: "string", description: "Ticker named in the orchestrator's instruction." } } };

const AXIS_INPUT: JsonSchema = { type: "object", additionalProperties: false, required: ["symbol", "axisQName", "conceptQName"],
  properties: { symbol: { type: "string" }, axisQName: { type: "string" }, conceptQName: { type: "string" },
    memberFilter: { type: "string" }, cursor: { type: "number" } } };

/** Resolves the ticker the subagent was told to work on to the one owned model holding its data. */
function resolveModel(deps: MappingSubagentDeps, raw: JsonObject, schema: JsonSchema): { modelId: string; symbol: string } {
  validate(raw, schema, "$", true);
  const symbol = String(raw["symbol"]).trim().toUpperCase();
  const owned = deps.modelStore.list({ ownerAgentId: deps.ownerAgentId, symbol });
  if (owned.length === 0) throw new Error(`no model holds extracted data for ${symbol}; run extract_filing_statements and create_financial_model first`);
  // Ambiguity is the orchestrator's to resolve, not something to guess at: picking the newest model
  // would silently map into a workbook nobody asked for.
  if (owned.length > 1) throw new Error(`${owned.length} models exist for ${symbol}; the orchestrator must archive the stale ones first`);
  return { modelId: owned[0]!.modelId, symbol };
}

/** Shared setup for the two dimension-exploration tools: resolve the model, then the run's tables and periods. */
function runContext(deps: MappingSubagentDeps, raw: JsonObject, schema: JsonSchema) {
  const { modelId, symbol } = resolveModel(deps, raw, schema);
  const review = deps.sourceReviewStore.get(modelId);
  if (!review) throw new Error(`no source review stored for ${symbol}`);
  return { symbol, review,
    tables: deps.tableStore!.getRunTables(review.ingestionRunId),
    requestedPeriods: review.statementViews.income_statement.candidate.periods };
}

/**
 * The statement_unification subagent's initialization tool. It is the subagent's first move: the host
 * hands it only the orchestrator's instruction, and it calls this to pull the issuer's concept
 * inventory out of the store. Nothing is passed in the prompt, so the working set is always what
 * extraction actually persisted rather than a copy that could drift from it.
 */
export function createStatementUnificationTools(deps: MappingSubagentDeps): {
  tools: Map<string, LoopTool>;
  /** Set once the subagent loads; the host reads it back to verify what it worked on. */
  loaded: () => LoadedWorkingSet | undefined;
} {
  let loaded: LoadedWorkingSet | undefined;
  const tool: LoopTool = {
    name: "load_concept_inventory", category: "non_trading",
    description: "Load the XBRL concept inventory and requested periods for one ticker's extracted filings.",
    inputSchema: SYMBOL_INPUT,
    execute(raw) {
      const { modelId, symbol } = resolveModel(deps, raw, this.inputSchema);
      const review = deps.sourceReviewStore.get(modelId);
      if (!review) throw new Error(`no source review stored for ${symbol}`);
      if (!review.presentationExtracts?.length) throw new Error(`${symbol} has no presentation extracts; re-run extract_filing_statements`);
      const requestedPeriods = review.statementViews.income_statement.candidate.periods;
      const inventory = buildConceptInventory({ filings: review.presentationExtracts, requestedPeriods });
      loaded = { symbol, modelId };
      return { symbol, requestedPeriods: requestedPeriods.map((period) => period.id),
        inventory } as unknown as JsonValue;
    },
  };
  const tools = new Map([[tool.name, tool]]);
  if (deps.tableStore) {
    // Progressive disclosure: the concept inventory alone doesn't surface segment/geography axes,
    // so a subagent that needs a dimensional breakdown asks for it explicitly, one axis at a time.
    const axesTool: LoopTool = {
      name: "list_dimension_axes", category: "non_trading",
      description: "List every XBRL dimension axis present in one ticker's extracted filings, with member counts and top concepts.",
      inputSchema: SYMBOL_INPUT,
      execute(raw) {
        const c = runContext(deps, raw, this.inputSchema);
        return { symbol: c.symbol, axes: buildAxisCatalog({ tables: c.tables, requestedPeriods: c.requestedPeriods }) } as unknown as JsonValue;
      },
    };
    const breakdownTool: LoopTool = {
      name: "get_axis_breakdown", category: "non_trading",
      description: "Member-level values for one axis and concept, resolved latest-filing-wins.",
      inputSchema: AXIS_INPUT,
      execute(raw) {
        const c = runContext(deps, raw, this.inputSchema);
        const cursor = raw["cursor"];
        if (cursor !== undefined && (typeof cursor !== "number" || !Number.isInteger(cursor) || cursor < 0)) {
          throw new Error("cursor must be a non-negative integer from a previous response's nextCursor");
        }
        return { symbol: c.symbol, ...buildAxisBreakdown({ tables: c.tables, requestedPeriods: c.requestedPeriods,
          axisQName: String(raw["axisQName"]), conceptQName: String(raw["conceptQName"]),
          ...(typeof raw["memberFilter"] === "string" ? { memberFilter: raw["memberFilter"] } : {}),
          ...(cursor !== undefined ? { cursor } : {}) }) } as unknown as JsonValue;
      },
    };
    tools.set(axesTool.name, axesTool);
    tools.set(breakdownTool.name, breakdownTool);
  }
  return { tools, loaded: () => loaded };
}

/** The spine_mapping subagent's initialization tool: the unified statements the previous stage stored. */
export function createSpineMappingTools(deps: MappingSubagentDeps): {
  tools: Map<string, LoopTool>;
  loaded: () => LoadedWorkingSet | undefined;
} {
  let loaded: LoadedWorkingSet | undefined;
  const tool: LoopTool = {
    name: "load_unified_statements", category: "non_trading",
    description: "Load the unified multi-year statements statement_unification stored for one ticker.",
    inputSchema: SYMBOL_INPUT,
    execute(raw) {
      const { modelId, symbol } = resolveModel(deps, raw, this.inputSchema);
      const review = deps.sourceReviewStore.get(modelId);
      if (!review?.unifiedStatements) throw new Error(`${symbol} has no unified statements; run statement_unification first`);
      loaded = { symbol, modelId };
      return { symbol, periods: review.unifiedStatements.periods,
        rows: review.unifiedStatements.rows } as unknown as JsonValue;
    },
  };
  return { tools: new Map([[tool.name, tool]]), loaded: () => loaded };
}
