import { validate } from "./schemas.ts";
import type { RegisteredTool } from "../toolRegistry.ts";
import type { JsonObject, JsonSchema, JsonValue, ToolExecutionResult } from "../../src/framework/types.ts";
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
  body: (input: JsonObject) => JsonValue,
): RegisteredTool {
  return {
    ...definition,
    execute: async (input: JsonObject): Promise<ToolExecutionResult> => {
      try {
        return { summary: `${definition.name} ok`, generation_context: { data: body(input) as JsonObject } };
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
  ownerTenantId: string;
  /** The model the orchestrator named. Pins resolution when several versions of one issuer coexist;
   *  absent, the ticker must resolve to exactly one owned model. */
  modelId?: string;
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
  if (deps.modelId !== undefined) {
    const meta = deps.modelStore.getMeta(deps.modelId);
    if (!meta || meta.ownerTenantId !== deps.ownerTenantId) throw new Error(`model ${deps.modelId} is not available to this agent`);
    if (meta.symbol !== symbol) {
      throw new Error(`${symbol} is not the issuer of model ${deps.modelId} (${meta.symbol}); restate the instruction with the right ticker`);
    }
    return { modelId: deps.modelId, symbol };
  }
  const owned = deps.modelStore.list({ ownerTenantId: deps.ownerTenantId, symbol });
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
  tools: RegisteredTool[];
  /** Set once the subagent loads; the host reads it back to verify what it worked on. */
  loaded: () => LoadedWorkingSet | undefined;
} {
  let loaded: LoadedWorkingSet | undefined;
  const tool = subagentTool({
    name: "load_concept_inventory", category: "non_trading",
    description: "Load the XBRL concept inventory and requested periods for one ticker's extracted filings.",
    inputSchema: SYMBOL_INPUT,
  }, (raw) => {
      const { modelId, symbol } = resolveModel(deps, raw, SYMBOL_INPUT);
      const review = deps.sourceReviewStore.get(modelId);
      if (!review) throw new Error(`no source review stored for ${symbol}`);
      if (!review.presentationExtracts?.length) throw new Error(`${symbol} has no presentation extracts; re-run extract_filing_statements`);
      const requestedPeriods = review.statementViews.income_statement.candidate.periods;
      const inventory = buildConceptInventory({ filings: review.presentationExtracts, requestedPeriods });
      loaded = { symbol, modelId };
      return { symbol, requestedPeriods: requestedPeriods.map((period) => period.id),
        inventory } as unknown as JsonValue;
  });
  const tools = [tool];
  if (deps.tableStore) {
    // Progressive disclosure: the concept inventory alone doesn't surface segment/geography axes,
    // so a subagent that needs a dimensional breakdown asks for it explicitly, one axis at a time.
    const axesTool = subagentTool({
      name: "list_dimension_axes", category: "non_trading",
      description: "List every XBRL dimension axis present in one ticker's extracted filings, with member counts and top concepts.",
      inputSchema: SYMBOL_INPUT,
    }, (raw) => {
        const c = runContext(deps, raw, SYMBOL_INPUT);
        return { symbol: c.symbol, axes: buildAxisCatalog({ tables: c.tables, requestedPeriods: c.requestedPeriods }) } as unknown as JsonValue;
    });
    const breakdownTool = subagentTool({
      name: "get_axis_breakdown", category: "non_trading",
      description: "Member-level values for one axis and concept, resolved latest-filing-wins.",
      inputSchema: AXIS_INPUT,
    }, (raw) => {
        const c = runContext(deps, raw, AXIS_INPUT);
        const cursor = raw["cursor"];
        if (cursor !== undefined && (typeof cursor !== "number" || !Number.isInteger(cursor) || cursor < 0)) {
          throw new Error("cursor must be a non-negative integer from a previous response's nextCursor");
        }
        const breakdown = buildAxisBreakdown({ tables: c.tables, requestedPeriods: c.requestedPeriods,
          axisQName: String(raw["axisQName"]), conceptQName: String(raw["conceptQName"]),
          ...(typeof raw["memberFilter"] === "string" ? { memberFilter: raw["memberFilter"] } : {}),
          ...(cursor !== undefined ? { cursor } : {}) });
        // A zero result from a fuzzy member search is information.  A zero result from the exact
        // axis/concept pair is instead a bad lookup, and should point the agent back to the catalog.
        if (breakdown.members.length === 0 && raw["memberFilter"] === undefined) {
          throw new Error(`no dimensional members for ${breakdown.axisQName}/${breakdown.conceptQName}; `
            + "call list_dimension_axes and use one of its axis/concept pairs");
        }
        return { symbol: c.symbol, ...breakdown } as unknown as JsonValue;
    });
    tools.push(axesTool, breakdownTool);
  }
  return { tools, loaded: () => loaded };
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
function spineTargets(): { required: string[]; optional: string[]; semantics: Record<string, string> } {
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

/** The spine_mapping subagent's initialization tool: the unified statements the previous stage stored. */
export function createSpineMappingTools(deps: MappingSubagentDeps): {
  tools: RegisteredTool[];
  loaded: () => LoadedWorkingSet | undefined;
} {
  let loaded: LoadedWorkingSet | undefined;
  const tool = subagentTool({
    name: "load_unified_statements", category: "non_trading",
    description: "Load the unified multi-year statements statement_unification stored for one ticker, "
      + "including any disclosed dimension breakdown rows that may be selected as revenue detail rows, "
      + "with the canonical spine target ids you map them onto — required ones separated from optional.",
    inputSchema: SYMBOL_INPUT,
  }, (raw) => {
      const { modelId, symbol } = resolveModel(deps, raw, SYMBOL_INPUT);
      const review = deps.sourceReviewStore.get(modelId);
      if (!review?.unifiedStatements) throw new Error(`${symbol} has no unified statements; run statement_unification first`);
      loaded = { symbol, modelId };
      return { symbol, periods: review.unifiedStatements.periods,
        rows: review.unifiedStatements.rows,
        breakdownRows: review.unifiedStatements.breakdownRows ?? [],
        spineTargets: spineTargets() } as unknown as JsonValue;
  });
  return { tools: [tool], loaded: () => loaded };
}
