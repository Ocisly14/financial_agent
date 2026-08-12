import assert from "node:assert/strict";
import test from "node:test";
import { composeSubagentReport, SUBAGENT_SUMMARY_BUDGET_CHARS } from "../dcfSubagentTool.ts";

const COUNTS = "spine_mapping staged 61 fact(s) at revision 2 across 13 spine mapping(s).";

test("the report leads with the host's counts and follows with the subagent's finish summary", () => {
  const written = "Mapped automotive and energy revenue separately because the issuer reports them "
    + "under different concepts after FY2023.";
  assert.equal(composeSubagentReport(COUNTS, written), `${COUNTS}\n\n${written}`);
});

test("a subagent that finished without a summary still gets its counts reported", () => {
  assert.equal(composeSubagentReport(COUNTS, "   "), COUNTS);
});

test("a summary past the budget is clipped, and the measured counts always survive intact", () => {
  // A subagent that ignores its word limit must not be able to flood the orchestrator's context.
  const flood = "This sentence describes one mapping decision in tedious detail. ".repeat(60);
  const report = composeSubagentReport(COUNTS, flood);
  assert.ok(report.startsWith(COUNTS), report.slice(0, 80));
  assert.ok(report.length <= COUNTS.length + SUBAGENT_SUMMARY_BUDGET_CHARS + 2, `${report.length}`);
  // Clipped at a sentence boundary rather than mid-word.
  assert.ok(report.trimEnd().endsWith("."), JSON.stringify(report.slice(-40)));
});

test("a long unpunctuated summary is clipped with an ellipsis rather than cut to nothing", () => {
  const report = composeSubagentReport(COUNTS, "word ".repeat(400));
  assert.ok(report.endsWith("…"), JSON.stringify(report.slice(-20)));
  assert.ok(report.length <= COUNTS.length + SUBAGENT_SUMMARY_BUDGET_CHARS + 2, `${report.length}`);
});
