import test from "node:test";
import assert from "node:assert/strict";
import { projectFinancialModelProgress } from "../../agent/financial-modeling/dcfBehavior.ts";

/**
 * [PROGRESS SO FAR] is the financial_modeling agent's ENTIRE context between
 * steps. A tool result this projection drops did not happen as far as the agent
 * can tell — and it will redo the work, from the evidence it can see, until its
 * step budget runs out. These tests pin the two ways that used to happen.
 */

type Output = Parameters<typeof projectFinancialModelProgress>[0][number];

function extractionOutput(runId: string, diagnostics = 309): Output {
  return {
    name: "extract_filing_statements",
    summary: `Extracted 5 filing(s) into ingestion ${runId}; period coverage income_statement 5/5. Pass ingestionRunId to create_financial_model.`,
    generation_context: {
      data: {
        extraction: {
          ingestionRunId: runId,
          accessions: ["0000320193-24-000123"],
          statementCoverage: { statements: [] },
          filingInsightSetId: null,
          diagnostics: Array.from({ length: diagnostics }, (_, i) => ({ code: "d", message: `diag ${i}` })),
        },
      },
    },
  } as Output;
}

test("an extraction result survives the projection, so the agent can see it already ran", () => {
  const projected = JSON.parse(projectFinancialModelProgress([extractionOutput("ing_abc")], [], []));

  // The regression: extract_filing_statements matched none of the allowlists, so
  // its ingestionRunId never reached the agent and it re-extracted every step.
  assert.equal(projected.latest_extraction.ingestionRunId, "ing_abc");
});

test("re-running extraction keeps one slot rather than stacking payloads", () => {
  const projected = JSON.parse(projectFinancialModelProgress(
    [extractionOutput("ing_first"), extractionOutput("ing_second")], [], []));

  assert.equal(projected.latest_extraction.ingestionRunId, "ing_second");
});

test("extraction diagnostics are counted and sampled, not carried whole", () => {
  const projected = JSON.parse(projectFinancialModelProgress([extractionOutput("ing_abc", 309)], [], []));

  assert.equal(projected.latest_extraction.diagnostic_count, 309);
  assert.equal(projected.latest_extraction.diagnostic_sample.length, 5);
});

test("a tool matching no allowlist still reports that it ran", () => {
  const projected = JSON.parse(projectFinancialModelProgress(
    [{ name: "some_new_tool", summary: "did the thing" } as Output], [], []));

  // The class of bug, not just the one instance: an allowlist that silently
  // drops the unknown makes every future tool a candidate for the same loop.
  assert.deepEqual(projected.other_results, [{ tool: "some_new_tool", summary: "did the thing" }]);
});

test("unclassified tool results retain one latest entry per tool instead of falling out of an event window", () => {
  const outputs = Array.from({ length: 12 }, (_, index) => ({
    name: `tool_${index}`, summary: `completed ${index}`,
  } as Output));
  outputs.push({ name: "tool_3", summary: "completed again" } as Output);

  const projected = JSON.parse(projectFinancialModelProgress(outputs, [], []));
  assert.equal(projected.other_results.length, 12);
  assert.deepEqual(projected.other_results.find((result: { tool: string }) => result.tool === "tool_3"),
    { tool: "tool_3", summary: "completed again" });
});

test("results the specific branches already captured are not duplicated into other_results", () => {
  const projected = JSON.parse(projectFinancialModelProgress(
    [{ name: "get_financial_model", summary: "s", generation_context: { data: { model_id: "fm-1", revision: 3 } } } as Output],
    [], []));

  assert.equal(projected.active_model_context.model_id, "fm-1");
  assert.deepEqual(projected.other_results, []);
});

test("narrow workbook reads accumulate for the current revision rather than overwriting each other", () => {
  const modelRead = (revision: number, section: string): Output => ({
    name: "get_financial_model",
    summary: `Loaded ${section}.`,
    generation_context: { data: {
      model_id: "fm-1", revision,
      workbook_slice: { modelId: "fm-1", revision, rows: [{ lineItemId: `${section}.row` }] },
    } },
  } as Output);

  const projected = JSON.parse(projectFinancialModelProgress([
    modelRead(3, "history"), modelRead(3, "revenue"), modelRead(3, "history"),
  ], [], []));

  assert.deepEqual(projected.active_model_context.workbook_slices.map((slice: { rows: Array<{ lineItemId: string }> }) =>
    slice.rows[0]!.lineItemId), ["revenue.row", "history.row"]);
});

test("a newer revision clears stale workbook slices", () => {
  const output = (revision: number, section: string): Output => ({
    name: "get_financial_model", summary: `Loaded ${section}.`, generation_context: { data: {
      model_id: "fm-1", revision,
      workbook_slice: { modelId: "fm-1", revision, rows: [{ lineItemId: `${section}.row` }] },
    } },
  } as Output);

  const projected = JSON.parse(projectFinancialModelProgress([
    output(3, "history"), output(3, "revenue"), output(4, "operations"),
  ], [], []));

  // The live revision is stated below the progress region, not in it — it changes on every mutation
  // and inside the projection it split everything under it. What must still be right here is that
  // the projection TRACKED the advance: the stale slices are gone.
  assert.ok(!Object.hasOwn(projected.active_model_context, "revision"));
  assert.deepEqual(projected.active_model_context.workbook_slices.map((slice: { rows: Array<{ lineItemId: string }> }) =>
    slice.rows[0]!.lineItemId), ["operations.row"]);
});

test("a mutation keeps prior slices and carries its compact change context", () => {
  const read = (revision: number, section: string, value: number): Output => ({
    name: "get_financial_model", summary: `Loaded ${section}.`, generation_context: { data: {
      model_id: "fm-1", revision,
      workbook_slice: { modelId: "fm-1", revision, rows: [{ lineItemId: `${section}.row`, section, value }] },
    } },
  } as Output);
  const mutation: Output = {
    name: "apply_financial_model_operations", summary: "Updated model.", generation_context: { data: {
      model_id: "fm-1", revision: 4, model_change_context: {
        changed_sections: ["operations"], changed_rows: [{ line_item_id: "operations.row" }],
      },
    } },
  } as Output;

  const projected = JSON.parse(projectFinancialModelProgress([
    read(3, "revenue", 1), read(3, "operations", 1), mutation,
  ], [], []));

  assert.ok(!Object.hasOwn(projected.active_model_context, "revision"), "stated below the region instead");
  assert.deepEqual(projected.active_model_context.workbook_slices.map((slice: { revision: number; rows: Array<{ lineItemId: string; value: number }> }) =>
    [slice.revision, slice.rows[0]!.lineItemId, slice.rows[0]!.value]), [
    [3, "revenue.row", 1], [3, "operations.row", 1],
  ]);
  assert.deepEqual(projected.active_model_context.model_change_context.changed_sections, ["operations"]);
  assert.match(projected.active_model_context.workbook_slices_notice, /historical context/);
});

test("narrow reads retain the latest overview and its lifecycle blockers", () => {
  const overview: Output = {
    name: "apply_financial_model_operations", summary: "Updated model.", generation_context: { data: {
      model_id: "fm-1", revision: 3, lifecycle_stage: "operations_fcff",
      model_overview: { lifecycle_blockers: [{ code: "incomplete_equity_bridge" }] },
    } },
  } as Output;
  const slice: Output = {
    name: "get_financial_model", summary: "Loaded revenue.", generation_context: { data: {
      model_id: "fm-1", revision: 3,
      workbook_slice: { modelId: "fm-1", revision: 3, rows: [{ lineItemId: "revenue.total" }] },
    } },
  } as Output;

  const projected = JSON.parse(projectFinancialModelProgress([overview, slice], [], []));

  assert.equal(projected.active_model_context.lifecycle_stage, "operations_fcff");
  assert.deepEqual(projected.active_model_context.model_overview.lifecycle_blockers,
    [{ code: "incomplete_equity_bridge" }]);
});

test("workbook slice working set keeps sixteen recent slices and reports evictions", () => {
  const outputs = Array.from({ length: 18 }, (_, index) => ({
    name: "get_financial_model", summary: `Loaded row ${index}.`, generation_context: { data: {
      model_id: "fm-1", revision: 3,
      workbook_slice: { modelId: "fm-1", revision: 3, rows: [{ lineItemId: `row.${index}` }] },
    } },
  } as Output));

  const projected = JSON.parse(projectFinancialModelProgress(outputs, [], []));
  assert.deepEqual(projected.active_model_context.workbook_slices.map((slice: { rows: Array<{ lineItemId: string }> }) =>
    slice.rows[0]!.lineItemId), Array.from({ length: 16 }, (_, index) => `row.${index + 2}`));
  assert.equal(projected.active_model_context.workbook_slices_evicted, 2);
});

test("workbook slices also obey a total context budget while retaining the current read", () => {
  const output = (id: string): Output => ({
    name: "get_financial_model", summary: `Loaded ${id}.`, generation_context: { data: {
      model_id: "fm-1", revision: 3,
      workbook_slice: { modelId: "fm-1", revision: 3, rows: [{ lineItemId: id, evidence: "x".repeat(70_000) }] },
    } },
  } as Output);

  const projected = JSON.parse(projectFinancialModelProgress([output("first"), output("second")], [], []));
  assert.deepEqual(projected.active_model_context.workbook_slices.map((slice: { rows: Array<{ lineItemId: string }> }) =>
    slice.rows[0]!.lineItemId), ["second"]);
  assert.equal(projected.active_model_context.workbook_slices_evicted, 1);
  assert.ok(projected.active_model_context.workbook_slices_context_chars <= 120_000);
});

// ── delegated rounds ─────────────────────────────────────────────────────

function delegationOutput(thread: string, taskId: string, summary: string): Output {
  return {
    name: "delegate_to_agent",
    summary: `market_research (thread ${thread}): ${summary}`,
    generation_context: {
      data: { delegation: { agent: "market_research", thread, task_id: taskId, status: "ok", summary } },
    },
  } as Output;
}

test("separate delegated conversations all survive the projection", () => {
  // The fallback bucket keys by TOOL NAME, which is right for a tool asked one question and wrong
  // for this one: delegation is called repeatedly by construction. Landing there, three research
  // questions would collapse to the last answer — and the two the agent could no longer see are, to
  // it, questions it never asked. It would ask them again until its step budget ran out.
  const projected = JSON.parse(projectFinancialModelProgress([
    delegationOutput("s:market_research:1", "t1", "capacity is the constraint"),
    delegationOutput("s:market_research:2", "t2", "the pricing case is weaker than guidance implies"),
    delegationOutput("s:market_research:3", "t3", "no regulatory change lands inside the horizon"),
  ], [], []));

  assert.equal(projected.latest_delegated_results.length, 3);
  assert.deepEqual(
    projected.latest_delegated_results.map((r: { summary: string }) => r.summary),
    ["capacity is the constraint", "the pricing case is weaker than guidance implies",
      "no regulatory change lands inside the horizon"],
  );
  assert.deepEqual(projected.other_results, [], "and it must not also fall through to the fallback");
});

test("a follow-up round replaces the round it continues", () => {
  // Same thread: the delegate's own thread already carries that history, so keeping both would pay
  // twice for one conversation.
  const projected = JSON.parse(projectFinancialModelProgress([
    delegationOutput("s:market_research:1", "t1", "first pass, thin"),
    delegationOutput("s:market_research:1", "t2", "pressed further: capacity, not demand"),
  ], [], []));

  assert.equal(projected.latest_delegated_results.length, 1);
  assert.equal(projected.latest_delegated_results[0].summary, "pressed further: capacity, not demand");
  assert.equal(projected.latest_delegated_results[0].task_id, "t2");
});

test("the delegated bucket is present before any delegation, so its key never appears mid-run", () => {
  // A key that materialises on the step that first delegates is a divergence point in the cached
  // prefix on exactly that step, and everything below it is re-billed.
  const projected = JSON.parse(projectFinancialModelProgress(
    [{ name: "some_new_tool", summary: "did the thing" } as Output], [], []));

  assert.deepEqual(projected.latest_delegated_results, []);
});
