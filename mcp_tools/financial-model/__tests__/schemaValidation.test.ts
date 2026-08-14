import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOperations, suggestCandidates, validate } from "../schemas.ts";
import type { JsonSchema } from "../../../src/framework/types.ts";

/**
 * A rejected batch costs the agent the whole batch, not the offending row — on a real issuer that is
 * a couple of minutes and tens of thousands of output tokens. Reporting only the first fault turns
 * one bad batch into one retry per fault; every fault in one message makes it one retry, full stop.
 */

const ROW: JsonSchema = { type: "object", additionalProperties: false,
  required: ["rowId", "rationale"],
  properties: { rowId: { type: "string" }, rationale: { type: "string" } } };
const BATCH: JsonSchema = { type: "object", additionalProperties: false, required: ["rows"],
  properties: { rows: { type: "array", items: ROW } } };

const rows = (count: number, withRationale: (index: number) => boolean) =>
  ({ rows: Array.from({ length: count }, (_value, index) => ({ rowId: `r${index}`,
    ...(withRationale(index) ? { rationale: "one concept, reported directly" } : {}) })) });

test("a single fault reads exactly as it always did", () => {
  // The one-error wording is load-bearing: it is what the agent has been trained by, and what the
  // operations parser matches on to append its kind hint.
  assert.throws(() => validate(rows(3, (index) => index !== 1), BATCH, "$"),
    (error: Error) => error.message === "$.rows[1].rationale is required");
});

test("every faulty row is named in one message, not just the first", () => {
  assert.throws(() => validate(rows(5, (index) => index === 0), BATCH, "$"), (error: Error) => {
    for (const index of [1, 2, 3, 4]) {
      assert.match(error.message, new RegExp(`\\$\\.rows\\[${index}\\]\\.rationale is required`));
    }
    assert.match(error.message, /4 validation errors/);
    return true;
  });
});

test("faults are collected across sibling fields of the same object, too", () => {
  assert.throws(() => validate({ rows: [{ rowId: 7, rationale: "r", extra: 1 }] }, BATCH, "$"), (error: Error) => {
    assert.match(error.message, /\$\.rows\[0\]\.extra is not allowed/);
    assert.match(error.message, /\$\.rows\[0\]\.rowId must be a string/);
    return true;
  });
});

test("a very broken batch is truncated rather than answered with hundreds of lines", () => {
  // The point of the list is to make one retry sufficient. Past a certain length it stops being a
  // fix list and starts being the context budget.
  assert.throws(() => validate(rows(200, () => false), BATCH, "$"), (error: Error) => {
    assert.match(error.message, /200 validation errors/);
    assert.match(error.message, /\.\.\. and 180 more/);
    assert.ok(error.message.split("\n").length <= 22, "twenty faults is already more than enough to act on");
    return true;
  });
});

test("a valid value still passes silently", () => {
  assert.doesNotThrow(() => validate(rows(3, () => true), BATCH, "$"));
});

/**
 * A top-level shape error ends the walk before any operation is inspected, so the one message the
 * agent gets is all it has to work from. `$.operations must be an array` cost a 115-second call and
 * 11.5k output tokens in one AMZN run without ever saying what arrived instead.
 */
test("operations sent as something other than an array is told what arrived", () => {
  assert.throws(() => parseOperations({ modelId: "m", expectedRevision: 1,
    operations: { kind: "set_formula" } as never }), (error: Error) => {
    assert.match(error.message, /\$\.operations must be an array/, "keeps the path the agent knows");
    assert.match(error.message, /received a single object/, "and names what arrived");
    return true;
  });
});

test("operations sent as a JSON string is told to send real JSON, not text", () => {
  assert.throws(() => parseOperations({ modelId: "m", expectedRevision: 1,
    operations: '[{"kind":"set_formula"}]' as never }), (error: Error) => {
    assert.match(error.message, /received a string/);
    return true;
  });
});

/**
 * Five distinct failures in one AMZN run came down to the agent writing a name that does not exist:
 * `marketable_securities` for a row filed under `source.balance_sheet.marketable_securities.<hash>`,
 * `margin.operating.aws` for a namespaced metric, `history` for a section that is not a time filter.
 * Each was patched in its own error message, which is whack-a-mole; a rejected name should carry the
 * near misses wherever the validator knows the candidate set.
 *
 * Matching is by shared words and substrings, not edit distance: the id an agent guesses is usually
 * the right words under the wrong prefix, which reads as far away by character edits and adjacent by
 * tokens.
 */
test("a rejected name comes back with the candidates that share its words", () => {
  const found = suggestCandidates("marketable_securities", [
    "source.balance_sheet.marketable_securities.2f5a1c703d48",
    "source.cash_flow_statement.purchases_of_marketable_securities.256c20913576",
    "short_term_investments",
    "cash_and_equivalents",
  ]);

  assert.deepEqual(found, [
    "source.balance_sheet.marketable_securities.2f5a1c703d48",
    "source.cash_flow_statement.purchases_of_marketable_securities.256c20913576",
  ], "both rows carrying those words, and nothing that merely exists");
});

test("candidates sharing too little of the name are held back", () => {
  const found = suggestCandidates("operating_income", ["total_assets", "cash_and_equivalents", "net_debt"]);

  assert.deepEqual(found, [], "a list of everything is the same as no help at all");
});

test("the shorter candidate wins the tie, being the likelier canonical name", () => {
  const found = suggestCandidates("revenue_total", ["revenue.total", "source.income_statement.revenue_total.abc123456789"]);

  assert.equal(found[0], "revenue.total");
});

test("no more than ten candidates come back", () => {
  const many = Array.from({ length: 40 }, (_value, index) => `operating_expenses.line_${index}`);

  assert.equal(suggestCandidates("operating_expenses", many).length, 10);
});

test("an enum mismatch names the near misses rather than the whole enum", () => {
  const schema: JsonSchema = { type: "object", additionalProperties: false, required: ["section"],
    properties: { section: { type: "string",
      enum: ["history", "metrics", "revenue", "operations", "dcf", "source_income_statement",
        "source_balance_sheet", "source_cash_flow"] } } };

  assert.throws(() => validate({ section: "income_statement" }, schema, "$"), (error: Error) => {
    assert.match(error.message, /did you mean/i);
    assert.match(error.message, /source_income_statement/);
    return true;
  });
});
