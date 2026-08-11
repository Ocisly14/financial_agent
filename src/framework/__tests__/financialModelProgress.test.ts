import test from "node:test";
import assert from "node:assert/strict";
import { projectFinancialModelProgress } from "../subagent.ts";

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

test("results the specific branches already captured are not duplicated into other_results", () => {
  const projected = JSON.parse(projectFinancialModelProgress(
    [{ name: "get_financial_model", summary: "s", generation_context: { data: { model_id: "fm-1", revision: 3 } } } as Output],
    [], []));

  assert.equal(projected.active_model_context.model_id, "fm-1");
  assert.deepEqual(projected.other_results, []);
});
