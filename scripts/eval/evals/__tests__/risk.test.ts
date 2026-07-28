import { test } from "node:test";
import assert from "node:assert/strict";
import { runRiskEval } from "../risk.ts";

test("risk eval blocks every violation and never false-blocks a legal order", () => {
  const r = runRiskEval();
  assert.equal(r.category, "③ risk");
  assert.equal(r.metrics.recall, 1);       // all violations blocked
  assert.equal(r.metrics.falseBlocks, 0);  // no legal order blocked
  assert.ok(r.metrics.violations >= 15);   // all 15 rule categories covered
  assert.equal(r.gateViolations.length, 0);
});
