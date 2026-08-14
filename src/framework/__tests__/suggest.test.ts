import test from "node:test";
import assert from "node:assert/strict";
import { suggestCandidates, suggestionClause } from "../suggest.ts";

/**
 * Five distinct failures in one AMZN run were a name that does not exist. Patching each error
 * message in turn is whack-a-mole; a rejected name should carry its near misses, and each near
 * miss should say which one call fetches it.
 */
test("candidates are matched on shared words, not character edits", () => {
  const found = suggestCandidates("marketable_securities", [
    "source.balance_sheet.marketable_securities.2f5a1c703d48",
    "short_term_investments",
  ]);

  // 30 character edits away, every word in common — edit distance would rank these backwards.
  assert.deepEqual(found, ["source.balance_sheet.marketable_securities.2f5a1c703d48"]);
});

/**
 * A name is only half the help. The agent that wrote `marketable_securities` needs to know both that
 * `source.balance_sheet.marketable_securities.<hash>` exists and that reaching it is one
 * `get_unified_rows { rowIds }` away — otherwise it has traded an unknown name for an unknown call.
 */
test("suggestions are grouped by namespace and each group says how to read it", () => {
  const clause = suggestionClause("marketable_securities", [
    { kind: "line item", how: "get_financial_model { selector: { lineItemIds } }",
      names: ["short_term_investments", "cash_and_equivalents"] },
    { kind: "unified row", how: "get_unified_rows { rowIds }",
      names: ["marketable_securities", "purchases_of_marketable_securities"] },
  ]);

  assert.match(clause, /unified row/);
  assert.match(clause, /get_unified_rows \{ rowIds \}/);
  assert.match(clause, /marketable_securities, purchases_of_marketable_securities/);
  // The line-item group shares no words with the guess, so it is left out rather than padded in.
  assert.doesNotMatch(clause, /short_term_investments/);
});

test("a namespace with no near miss contributes nothing", () => {
  const clause = suggestionClause("operating_income", [
    { kind: "period", how: "selector.periodIds", names: ["FY2024", "FY2025"] },
  ]);

  assert.equal(clause, "");
});

test("each namespace is capped on its own, so one crowded space cannot bury the others", () => {
  const many = Array.from({ length: 40 }, (_value, index) => `operating_expenses_line_${index}`);
  const clause = suggestionClause("operating_expenses", [
    { kind: "unified row", how: "get_unified_rows { rowIds }", names: many },
    { kind: "line item", how: "selector.lineItemIds", names: ["operating_expenses"] },
  ]);

  assert.match(clause, /line item/, "the single exact match still gets said");
  assert.equal((clause.match(/operating_expenses_line_/g) ?? []).length, 10);
});

/**
 * The end the agent actually reads. `marketable_securities` is not a line item on this model, is a
 * unified row, and the clause has to carry both facts — which namespace it lives in, and the single
 * call that fetches it — or the agent has only swapped one dead end for another.
 */
test("the clause an agent reads names the namespace and the call that reaches it", () => {
  const clause = suggestionClause("marketable_securities", [
    { kind: "line item", how: "get_financial_model { selector: { lineItemIds } }",
      names: ["short_term_investments", "cash_and_equivalents", "total_assets"] },
    { kind: "unified row", how: "get_unified_rows { rowIds }",
      names: ["marketable_securities", "cash_and_cash_equivalents"] },
    { kind: "section", how: "get_financial_model { section }", names: ["history", "metrics", "dcf"] },
  ]);

  assert.equal(clause,
    " Did you mean — unified row: marketable_securities (read with get_unified_rows { rowIds })?");
});
