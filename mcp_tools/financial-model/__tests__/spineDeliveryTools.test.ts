import assert from "node:assert/strict";
import test from "node:test";
import { describeReconciliationResult } from "../spineDeliveryTools.ts";
import type { ReconciliationResult } from "../../../src/financial-model/types.ts";

function failure(over: Partial<ReconciliationResult> = {}): ReconciliationResult {
  return {
    kind: "accounting_identity",
    identity: "gross_profit",
    ruleId: "accounting_identity:gross_profit",
    parentLineItemId: "revenue.total",
    periodId: "FY2024",
    status: "failed",
    required: true,
    actual: 100,
    calculated: 60,
    residual: 40,
    difference: 40,
    tolerance: 1,
    refs: ["revenue.total@FY2024", "cost_of_revenue@FY2024", "gross_profit@FY2024"],
    ...over,
  } as ReconciliationResult;
}

function described(result: ReconciliationResult): string {
  const line = describeReconciliationResult(result);
  assert.ok(line !== undefined, "expected a finding");
  return line;
}

test("a reconciliation finding keeps each trail row's line item instead of pooling the rowIds", () => {
  const line = described(failure({
    unifiedTrail: [
      { lineItemId: "revenue.total", rowIds: ["rev-a", "rev-b"] },
      { lineItemId: "gross_profit", rowIds: ["gp-row"] },
    ],
  }));

  assert.match(line, /revenue\.total=rev-a\+rev-b/,
    "a flat rowId list makes the agent guess which term each row belongs to");
  assert.match(line, /gross_profit=gp-row/);
});

test("an unmapped ref is named as the defect rather than omitted from the trail", () => {
  const line = described(failure({
    unifiedTrail: [
      { lineItemId: "revenue.total", rowIds: ["rev-a"] },
      { lineItemId: "cost_of_revenue", rowIds: [], absent: "unmapped" },
    ],
  }));

  assert.match(line, /cost_of_revenue=<unmapped>/);
});

test("a unit mismatch reports as its own finding, not as a silent not_applicable", () => {
  const line = described(failure({
    status: "not_applicable",
    actual: null,
    calculated: null,
    residual: null,
    difference: null,
    skipReason: { kind: "unit_mismatch", refs: ["cost_of_revenue@FY2024"] },
  }));

  assert.match(line, /unit_mismatch/);
  assert.match(line, /cost_of_revenue@FY2024/);
});

test("an expected first-period skip produces no finding at all", () => {
  const line = describeReconciliationResult(failure({
    status: "not_applicable",
    ruleId: "accounting_identity:change_nwc",
    actual: null,
    calculated: null,
    residual: null,
    difference: null,
    skipReason: { kind: "no_prior_period", refs: ["change_nwc@FY2024"] },
  }));

  assert.equal(line, undefined,
    "reporting the first period's missing prior year trains the agent to ignore skip findings");
});

test("a period the filing only partly covers is left to coverage_gap, not failed twice", () => {
  const line = describeReconciliationResult(failure({
    status: "insufficient_data",
    calculated: null,
    residual: null,
    difference: null,
    skipReason: { kind: "missing_values", refs: ["cost_of_revenue@FY2025"] },
  }));

  assert.equal(line, undefined,
    "an empty cell is already a coverage_gap finding; reporting it again blocks a legal partial year");
});

test("a passed check produces no finding", () => {
  assert.equal(describeReconciliationResult(failure({ status: "passed", residual: 0, difference: 0 })), undefined);
});
