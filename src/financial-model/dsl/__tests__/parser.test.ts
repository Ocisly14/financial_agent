import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFormula } from "../parser.ts";
import { FinancialModelError } from "../../errors.ts";

function rejects(source: string, needle: string): void {
  assert.throws(() => parseFormula(source), (error: unknown) => {
    assert.ok(error instanceof FinancialModelError);
    assert.equal(error.code, "invalid_formula");
    assert.match(error.message, new RegExp(needle, "i"));
    return true;
  }, `expected ${source} to be rejected`);
}

test("multiplication binds tighter than addition", () => {
  assert.deepEqual(parseFormula("a + b * c"), {
    t: "bin",
    op: "+",
    l: { t: "ref", id: "a" },
    r: { t: "bin", op: "*", l: { t: "ref", id: "b" }, r: { t: "ref", id: "c" } },
  });
});

test("parentheses override precedence", () => {
  const ast = parseFormula("(a + b) * c");
  assert.equal(ast.t === "bin" && ast.op, "*");
});

test("dotted line-item ids parse as one reference", () => {
  assert.deepEqual(parseFormula("revenue.iphone"), { t: "ref", id: "revenue.iphone" });
});

test("unary minus and numeric literals", () => {
  assert.deepEqual(parseFormula("-1.5"), { t: "neg", e: { t: "num", v: 1.5 } });
});

test("known functions parse with their arguments", () => {
  assert.deepEqual(parseFormula("LAG(revenue.total, 1)"), {
    t: "call",
    fn: "LAG",
    args: [{ t: "ref", id: "revenue.total" }, { t: "num", v: 1 }],
  });
});

test("comparisons, conditionals, and fallback expressions are not in the language", () => {
  rejects("revenue.total > 0", "unexpected");
  rejects("IF(revenue.total, 1, 0)", "unknown function");
  rejects("COALESCE(reported_capex, estimated_capex)", "unknown function");
});

test("hierarchy aggregation is not in the language", () => {
  rejects("SUM_CHILDREN(revenue)", "unknown function");
});

test("unknown and dynamic function names are rejected", () => {
  rejects("EVAL(a)", "unknown function");
  rejects("a(b)", "unknown function");
});

test("arity is fixed per function", () => {
  rejects("LAG(revenue.total)", "expects 2");
  rejects("SUM(revenue.total, -4)", "expects 3");
});

test("offsets must be integer literals so the graph is resolvable before evaluation", () => {
  rejects("LAG(revenue.total, n)", "integer literal");
  rejects("SUM(revenue.total, -4.5, 0)", "integer literal");
});

test("YEAR_INDEX takes no arguments", () => {
  assert.deepEqual(parseFormula("YEAR_INDEX()"), { t: "call", fn: "YEAR_INDEX", args: [] });
});

test("DISCOUNT_FACTOR takes one WACC line-item reference", () => {
  assert.deepEqual(parseFormula("DISCOUNT_FACTOR(wacc)"), {
    t: "call",
    fn: "DISCOUNT_FACTOR",
    args: [{ t: "ref", id: "wacc" }],
  });
  rejects("DISCOUNT_FACTOR()", "expects 1");
  rejects("DISCOUNT_FACTOR(wacc + 0.01)", "line-item reference");
});

test("complexity limits are enforced", () => {
  rejects("(".repeat(40) + "a" + ")".repeat(40), "too deep");
  rejects("a + ".repeat(600) + "a", "too long");
});

test("property access, assignment, and foreign syntax are rejected", () => {
  rejects("a['b']", "unexpected");
  rejects("a = 1", "unexpected");
  rejects("a; b", "unexpected");
});
