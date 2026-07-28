import { test } from "node:test";
import assert from "node:assert/strict";
import { runTriggerEval } from "../trigger.ts";

test("trigger eval: perfect recall, zero false-triggers on fixtures", () => {
  const r = runTriggerEval();
  assert.equal(r.category, "② trigger");
  assert.equal(r.metrics.recall, 1);            // both should-fire fired
  assert.equal(r.metrics.falseTriggerRate, 0);  // neither should-not fired
  assert.equal(r.gateViolations.length, 0);
});
