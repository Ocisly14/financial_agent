import assert from "node:assert/strict";
import test from "node:test";
import { composeSubagentReport, SUBAGENT_NOTES_BUDGET_CHARS } from "../dcfSubagentTool.ts";

const COUNTS = "spine_mapping staged 61 fact(s) at revision 2 across 13 spine mapping(s).";

test("the report leads with the host's counts and follows with the subagent's own account", () => {
  const notes = "Mapped automotive and energy revenue separately because the issuer reports them "
    + "under different concepts after FY2023.";
  assert.equal(composeSubagentReport(COUNTS, notes), `${COUNTS}\n\n${notes}`);
});

test("a subagent that returns no notes still gets its counts reported", () => {
  assert.equal(composeSubagentReport(COUNTS, "   "), COUNTS);
});

test("notes past the budget are clipped, and the measured counts always survive intact", () => {
  // A subagent that ignores its word limit must not be able to flood the orchestrator's context.
  const flood = "This sentence describes one mapping decision in tedious detail. ".repeat(60);
  const summary = composeSubagentReport(COUNTS, flood);
  assert.ok(summary.startsWith(COUNTS), summary.slice(0, 80));
  assert.ok(summary.length <= COUNTS.length + SUBAGENT_NOTES_BUDGET_CHARS + 2, `${summary.length}`);
  // Clipped at a sentence boundary rather than mid-word.
  assert.ok(summary.trimEnd().endsWith("."), JSON.stringify(summary.slice(-40)));
});

test("a long unpunctuated note is clipped with an ellipsis rather than cut to nothing", () => {
  const summary = composeSubagentReport(COUNTS, "word ".repeat(400));
  assert.ok(summary.endsWith("…"), JSON.stringify(summary.slice(-20)));
  assert.ok(summary.length <= COUNTS.length + SUBAGENT_NOTES_BUDGET_CHARS + 2, `${summary.length}`);
});
