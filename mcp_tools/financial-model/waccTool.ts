import path from "node:path";
import type { JsonObject, JsonSchema, JsonValue, ToolExecutionResult } from "../../src/framework/types.ts";
import { FinancialModelError } from "../../src/financial-model/errors.ts";
import { FinancialModelService } from "../../src/financial-model/service.ts";
import { deriveWaccParameters, type BetaOptions, type DerivationDeps } from "../../src/financial-model/waccDerivation.ts";
import {
  resolveWacc,
  SqliteWaccParameterStore,
  WACC_PARAMETER_NAMES,
  type WaccParameterInput,
  type WaccParameterName,
  type WaccParameterStore,
} from "../../src/financial-model/waccStore.ts";
import { getSharedBarRepository, type BarRepository } from "../../src/data/stock/index.ts";
import type { RegisteredTool, ToolExecutionContext } from "../toolRegistry.ts";
import type { FinancialModelToolDeps } from "./financialModelTools.ts";
import { validate } from "./schemas.ts";

export const COMPUTE_WACC_TOOL = "compute_wacc";

/** Overrides the agent may state. Each replaces the engine's derived value for that term. */
const OVERRIDE_PROPERTIES: Record<WaccParameterName, JsonSchema> = {
  beta: { type: "number" },
  riskFreeRate: { type: "number", description: "30-year Treasury yield as a decimal, e.g. 0.0465." },
  equityRiskPremium: { type: "number", description: "As a decimal. No measurable source — you must state this one." },
  costOfDebt: { type: "number", description: "Pre-tax bond yield as a decimal. Search the issuer's bond rate when the filings cannot give it." },
  taxRate: { type: "number" },
  equityValue: { type: "number", description: "Market value of equity in reporting currency." },
  totalDebt: { type: "number", description: "Book total debt, NOT net of cash." },
};

const INPUT_SCHEMA: JsonSchema = { type: "object", additionalProperties: false, required: ["modelId"], properties: {
  modelId: { type: "string" },
  expectedRevision: { type: "number", description: "Required to finalize. Omit to preview without touching the model." },
  overrides: { type: "object", additionalProperties: false, properties: OVERRIDE_PROPERTIES as unknown as Record<string, JsonSchema> },
  rationale: { type: "string", description: "Why the overrides are what they are. Required to finalize." },
  sourceRefs: { type: "array", items: { type: "string" }, description: "Evidence for the overrides, e.g. the bond-yield search result." },
  betaYears: { type: "number", description: "Beta history window in years. Default 5." },
  marketProxy: { type: "string", description: "Beta's market benchmark. Default SPY." },
} };

export type WaccToolDeps = {
  financial: FinancialModelToolDeps;
  parameterStore?: WaccParameterStore;
  barRepository?: () => Promise<BarRepository | undefined>;
  now?: () => Date;
};

/**
 * WACC as one deliberate act.
 *
 * Calling this recomputes every term the engine can reach from the model and the bar cache, lays the
 * agent's overrides on top, and — when the set is complete and a revision is named — writes the
 * result into the model as the official WACC. That is the point of the tool: WACC stops being a
 * number in someone's working notes and becomes a committed assumption whose seven inputs are all
 * stored with their provenance, so a later session can audit it and a changed premium can be re-run
 * rather than re-guessed.
 *
 * Learning what is derived and what is missing does NOT require calling this: the engine refreshes
 * the parameters whenever committed facts change and reports them as `wacc_status` on that commit and
 * on every `get_financial_model`. This tool re-derives before computing so a stale term cannot slip
 * through, but its purpose is the decision, not the lookup. A call without `expectedRevision`
 * previews the arithmetic; a call with one commits it.
 */
export function createComputeWaccTool(deps: WaccToolDeps): RegisteredTool {
  let store = deps.parameterStore;
  const parameterStore = () => store ??= SqliteWaccParameterStore.open(
    path.resolve(process.env["FINANCIAL_MODEL_DB_PATH"] ?? "data/financial-models.sqlite"));
  const now = deps.now ?? (() => new Date());
  return {
    name: COMPUTE_WACC_TOOL,
    description: "Finalize a model's WACC. The engine has already derived every term it can reach and reported it in wacc_status; supply the rest as overrides here. Pass expectedRevision to commit the result as the model's official WACC. Omitting expectedRevision previews the arithmetic without committing.",
    category: "non_trading",
    inputSchema: INPUT_SCHEMA,
    async execute(input, context) {
      try { validate(input, INPUT_SCHEMA, "$", true); }
      catch (error) { return failure("invalid_tool_input", message(error)); }
      try { return await run(deps, parameterStore(), now, input, context); }
      catch (error) {
        if (error instanceof FinancialModelError) return failure(error.code, error.message);
        return failure("wacc_computation_failed", message(error));
      }
    },
  };
}

async function run(deps: WaccToolDeps, store: WaccParameterStore, now: () => Date,
  input: JsonObject, context: ToolExecutionContext): Promise<ToolExecutionResult> {
  const modelId = String(input["modelId"]);
  const meta = deps.financial.modelStore.getMeta(modelId);
  if (!meta || meta.ownerAgentId !== context.agentId) return failure("financial_model_not_found", `model not found: ${modelId}`);
  const stored = deps.financial.modelStore.getRevision(modelId);
  if (!stored) return failure("financial_model_not_found", `model not found: ${modelId}`);
  const snapshot = stored.snapshot;
  const asOfDate = now().toISOString().slice(0, 10);

  const repository = await (deps.barRepository ?? getSharedBarRepository)();
  const derivationDeps: DerivationDeps = {
    dailyCloses: async (symbol, from, to) => repository === undefined ? []
      : (await repository.getBarsBetween(symbol, "1Day", from, to)).map((bar) => ({ t: bar.t, c: bar.c })),
  };
  const beta: BetaOptions = {
    ...(typeof input["betaYears"] === "number" ? { years: input["betaYears"] } : {}),
    ...(typeof input["marketProxy"] === "string" ? { marketProxy: input["marketProxy"] } : {}),
  };

  const { derived, unreachable } = await deriveWaccParameters({ symbol: meta.symbol, asOfDate, beta,
    facts: snapshot.facts, lineItems: snapshot.lineItems, periods: snapshot.periods, deps: derivationDeps });
  for (const parameter of derived) store.put(modelId, parameter);

  // Overrides land after derivation, so a term the engine also computed is replaced rather than raced.
  const overrides = (input["overrides"] ?? {}) as Partial<Record<WaccParameterName, number>>;
  const overridden = Object.entries(overrides).filter(([, value]) => typeof value === "number");
  const rationale = typeof input["rationale"] === "string" ? input["rationale"] : "";
  const sourceRefs = Array.isArray(input["sourceRefs"])
    ? input["sourceRefs"].filter((entry): entry is string => typeof entry === "string") : [];
  if (overridden.length > 0 && rationale.trim().length === 0) {
    return failure("wacc_override_needs_rationale", "an override replaces a term the engine derived; state why");
  }
  for (const [name, value] of overridden) {
    const parameter: WaccParameterInput = { name: name as WaccParameterName, value: value as number,
      sourceType: name === "equityRiskPremium" ? "agent_estimate" : sourceRefs.length > 0 ? "search" : "agent_estimate",
      sourceRefs, derivation: { overrides: "engine derivation" }, asOfDate, rationale };
    store.put(modelId, parameter);
  }

  const resolved = resolveWacc(store, modelId);
  const parameters = resolved.parameters.map((parameter) => ({
    name: parameter.name, value: parameter.value, sourceType: parameter.sourceType,
    sourceRefs: parameter.sourceRefs, derivation: parameter.derivation, rationale: parameter.rationale,
  }));

  if (!resolved.complete) {
    const reasons = new Map(unreachable.map((entry) => [entry.name, entry.reason]));
    const missing = resolved.missing.map((name) => ({ name, reason: reasons.get(name) ?? "not derived and not supplied" }));
    return {
      summary: `WACC is not yet determined: ${resolved.missing.length} of ${WACC_PARAMETER_NAMES.length} term(s) missing `
        + `(${resolved.missing.join(", ")}). ${parameters.length} term(s) derived and stored. `
        + `Supply the rest through overrides and call ${COMPUTE_WACC_TOOL} again with expectedRevision.`,
      generation_context: { data: { wacc: { modelId, complete: false, parameters, missing } as unknown as JsonObject } },
    };
  }

  const breakdown = {
    wacc: resolved.result.wacc, costOfEquity: resolved.result.costOfEquity,
    afterTaxCostOfDebt: resolved.result.afterTaxCostOfDebt,
    equityWeight: resolved.result.equityWeight, debtWeight: resolved.result.debtWeight,
  };
  const percent = (value: number) => `${(value * 100).toFixed(2)}%`;

  // A preview: every term is present, but the caller has not asked to commit it.
  if (input["expectedRevision"] === undefined) {
    return {
      summary: `WACC would be ${percent(resolved.result.wacc)} (cost of equity ${percent(resolved.result.costOfEquity)}, `
        + `after-tax cost of debt ${percent(resolved.result.afterTaxCostOfDebt)}, equity weight ${percent(resolved.result.equityWeight)}). `
        + `Not yet committed — call ${COMPUTE_WACC_TOOL} again with expectedRevision to make it the model's official WACC.`,
      generation_context: { data: { wacc: { modelId, complete: true, committed: false, ...breakdown, parameters } as unknown as JsonObject } },
    };
  }

  if (rationale.trim().length === 0) return failure("wacc_needs_rationale", "finalizing a WACC requires a rationale");
  const forecastPeriods = snapshot.periods.filter((period) => period.cls === "forecast").map((period) => period.id);
  if (forecastPeriods.length === 0) return failure("no_forecast_periods", "the model has no forecast periods to discount");

  const service = new FinancialModelService(deps.financial.modelStore, context.sessionId);
  const committed = service.applyOperations(modelId, Number(input["expectedRevision"]), [{
    kind: "set_assumption",
    assumption: {
      assumptionId: `wacc-${modelId}`,
      lineItemId: "wacc",
      periods: forecastPeriods,
      payload: { kind: "values", values: forecastPeriods.map(() => resolved.result.wacc), unit: { kind: "percent" } },
      sourceType: "analyst_inference",
      // The stored parameters are the real evidence; these refs point at them by name so a reader of
      // the assumption alone knows the WACC was computed rather than chosen.
      sourceRefs: [...sourceRefs, ...resolved.parameters.map((parameter) => `wacc_parameter:${parameter.name}`)],
      asOfDate,
      rationale: `WACC ${percent(resolved.result.wacc)} computed from stored parameters. ${rationale}`,
    },
  }]);

  return {
    summary: `WACC finalized at ${percent(resolved.result.wacc)} for ${forecastPeriods.length} forecast period(s), `
      + `model ${modelId} revision ${committed.revision}. Cost of equity ${percent(resolved.result.costOfEquity)}, `
      + `after-tax cost of debt ${percent(resolved.result.afterTaxCostOfDebt)}, equity weight ${percent(resolved.result.equityWeight)}.`,
    generation_context: { data: { wacc: { modelId, complete: true, committed: true,
      revision: committed.revision, ...breakdown, parameters } as unknown as JsonObject } },
  };
}

function failure(code: string, detail: string): ToolExecutionResult {
  return { summary: detail, error: { code, message: detail } };
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
