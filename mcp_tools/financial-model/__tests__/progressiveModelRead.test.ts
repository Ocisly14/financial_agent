import assert from "node:assert/strict";
import test from "node:test";
import type { FinancialModelSnapshot } from "../../../src/financial-model/operations.ts";
import type { RevisionChangeSummary } from "../../../src/financial-model/service.ts";
import { financialModelSnapshotCodec } from "../../../src/financial-model/snapshotCodec.ts";
import { InMemoryModelStore } from "../../../src/financial-model/store.ts";
import { InMemoryFilingInsightStore } from "../../../src/infra/filing-insights/store.ts";
import { InMemorySourceReviewStore } from "../../../src/infra/xbrl/sourceReviewStore.ts";
import { FinancialModelService } from "../../../src/financial-model/service.ts";
import { projectFinancialModelProgress } from "../../../src/framework/subagent.ts";
import { createFinancialModelTools, type FinancialModelToolDeps } from "../financialModelTools.ts";
import type { RegisteredTool } from "../../toolRegistry.ts";
import type { JsonObject } from "../../../src/framework/types.ts";

/**
 * Reading the model is a three-step narrowing, the same shape list_unified_statements set for the
 * unified rows: orient, then take a section, then take named rows. Before that, the untargeted read
 * answered with the whole workbook — 68k tokens on a live AAPL model, three quarters of it
 * diagnostics that all said `missing_input` — and the agent, having no cheaper way to ask where it
 * stood, read it six times.
 */

const PERIODS = [
  { id: "FY2024", label: "FY2024", start: "2024-01-01", end: "2024-12-31", cls: "actual" as const },
  { id: "FY2025", label: "FY2025", start: "2025-01-01", end: "2025-12-31", cls: "forecast" as const },
];

const CONTEXT = { agentId: "owner-1", sessionId: "s1" };

function setup(): { tools: Map<string, RegisteredTool>; deps: FinancialModelToolDeps; modelId: string } {
  const sourceReviewStore = new InMemorySourceReviewStore();
  const deps: FinancialModelToolDeps = {
    modelStore: new InMemoryModelStore<FinancialModelSnapshot, RevisionChangeSummary>(financialModelSnapshotCodec),
    insightStore: new InMemoryFilingInsightStore(), sourceReviewStore, ingestionStore: sourceReviewStore,
  };
  const modelId = "model-1";
  new FinancialModelService(deps.modelStore, "s1").createModel({
    modelId, ownerAgentId: "owner-1", originSessionId: "s1", symbol: "TEST",
    metadata: {}, reportingCurrency: "USD", periods: PERIODS, preparedStatementRows: [],
  });
  return { tools: new Map(createFinancialModelTools(deps).map((tool) => [tool.name, tool])), deps, modelId };
}

const read = async (tools: Map<string, RegisteredTool>, input: JsonObject) =>
  tools.get("get_financial_model")!.execute(input, CONTEXT);

test("modelId alone answers with an overview, not the workbook", async () => {
  const { tools, modelId } = setup();

  const result = await read(tools, { modelId });
  const data = result.generation_context!.data as JsonObject;
  const summary = data["model_overview"] as JsonObject;

  assert.equal(result.error, undefined);
  assert.ok(summary, "the overview rides in model_overview");
  assert.equal(data["current_workbook"], undefined, "the whole workbook is no longer the default answer");
  // Counts, not rows: enough to choose what to read next.
  const sections = summary["sections"] as Record<string, { rows: number; cells_filled: number; cells_empty: number }>;
  assert.ok(sections["history"]!.rows > 0);
  assert.equal(typeof sections["history"]!.cells_filled, "number");
});

/**
 * Completeness is measured over the selected historical periods, so a model with none selected has
 * nothing to measure and no gaps to report. Passing that through as "complete" would be a lie the
 * gate immediately contradicts — it refuses an empty selection before it looks at any cell.
 */
test("a model with no history selected says so rather than reporting itself complete", async () => {
  const { tools, modelId } = setup();

  const result = await read(tools, { modelId });
  const required = ((result.generation_context!.data as JsonObject)["model_overview"] as JsonObject)["required_history"] as
    { complete: boolean; missing: string[]; blocked_by?: string };

  assert.equal(required.complete, false);
  assert.match(required.blocked_by ?? "", /no historical periods are selected/);
  assert.match(result.summary, /no historical periods are selected/,
    "the shortfall is in the summary line, before any payload is read");
});

test("diagnostics arrive grouped by code, with the refs capped", async () => {
  const { tools, modelId } = setup();

  const grouped = ((( await read(tools, { modelId })).generation_context!.data as JsonObject)["model_overview"] as JsonObject)["diagnostics_by_code"] as
    Array<{ code: string; count: number; refs: string[] }>;

  assert.ok(grouped.length > 0);
  for (const entry of grouped) {
    assert.ok(entry.count >= entry.refs.length);
    assert.ok(entry.refs.length <= 12, "a few hundred refs of one code are a count, not a list");
  }
});

test("section narrows to one section's rows; selector narrows to named ones", async () => {
  const { tools, modelId } = setup();

  const section = await read(tools, { modelId, section: "history" });
  const slice = (section.generation_context!.data as JsonObject)["workbook_slice"] as JsonObject;
  assert.ok(slice, "a section read is a slice, not an overview");

  const named = await read(tools, { modelId, selector: { lineItemIds: ["revenue.total"] } });
  const rows = ((named.generation_context!.data as JsonObject)["workbook_slice"] as { rows: unknown[] }).rows;
  assert.equal(rows.length, 1, "selector.lineItemIds reaches a single row");
});

test("cross-section named reads fail with the row's actual section", async () => {
  const { tools, modelId } = setup();

  const result = await read(tools, { modelId, section: "dcf", selector: { lineItemIds: ["nopat"] } });

  assert.ok(result.error, "a contradictory section and row selector is not an empty success");
  assert.equal(result.error!.code, "invalid_model_query");
  assert.match(result.error!.message, /nopat \(section operations\)/);
  assert.match(result.error!.message, /Read their named section/);
});

/**
 * `income_statement` is the guess to beat: it is what the unified rows and the spine call that
 * statement everywhere else, and the readable section is `source_income_statement`. A real run
 * spent four steps on this family of guess and then stopped narrowing altogether, falling back to
 * the untargeted read for the rest of its life.
 */
test("a section name that does not exist is refused with the real ones listed", async () => {
  const { tools, modelId } = setup();

  const result = await read(tools, { modelId, section: "income_statement" });

  // Caught by the schema now, ahead of the engine's own check — and either way the message carries
  // the list, so the next attempt is informed rather than another guess.
  assert.ok(result.error, "an unknown section is not silently ignored");
  assert.match(result.error!.message, /source_income_statement/);
  assert.match(result.error!.message, /history, metrics, revenue, operations, dcf/);
});

/**
 * A write answers with the same overview a read does. The agent has just written the model, so what
 * it is owed is where the write left things — not the workbook it wrote, echoed back. On an AAPL run
 * that echo cost ~71k tokens a write and still did not say why the model was stuck, and the agent
 * read the model five more times anyway.
 */
test("a write answers with the overview, and names the sections that moved", async () => {
  const { tools, modelId } = setup();

  const result = await tools.get("apply_financial_model_operations")!.execute({
    modelId, expectedRevision: 0,
    operations: [{ kind: "set_wacc_input", rowId: "equity_risk_premium", value: 0.043,
      sourceType: "macro_research", sourceRefs: ["damodaran"], rationale: "implied ERP" }],
  }, CONTEXT);
  const data = result.generation_context!.data as JsonObject;

  assert.equal(result.error, undefined);
  assert.ok(data["model_overview"], "the write answers with the overview");
  assert.equal(data["current_workbook"], undefined, "and never with the workbook");
  // revision_summary is how the agent knows what to narrow to next, so it stays alongside.
  assert.ok((data["revision_summary"] as { changedSections?: unknown }).changedSections);
});

test("a write's summary line carries the shortfall, the same as a read's", async () => {
  const { tools, modelId } = setup();

  const result = await tools.get("apply_financial_model_operations")!.execute({
    modelId, expectedRevision: 0,
    operations: [{ kind: "set_wacc_input", rowId: "equity_risk_premium", value: 0.043,
      sourceType: "macro_research", sourceRefs: ["damodaran"], rationale: "implied ERP" }],
  }, CONTEXT);

  assert.match(result.summary, /no historical periods are selected/);
});

/**
 * The progress projection rebuilds the agent's model context from a fixed set of key names, and a
 * payload key it does not know is dropped without a word — the overview would reach the agent as
 * a lifecycle stage and nothing else.
 */
test("the overview survives the progress projection the agent actually reads", async () => {
  const { tools, modelId } = setup();
  const result = await read(tools, { modelId });

  const progress = projectFinancialModelProgress(
    [{ name: "get_financial_model", summary: result.summary, generation_context: result.generation_context }] as never,
    [] as never, []);

  assert.match(progress, /model_overview/);
  assert.match(progress, /required_history/);
});
