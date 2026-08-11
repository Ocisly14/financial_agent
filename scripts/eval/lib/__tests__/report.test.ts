import { test } from "node:test";
import assert from "node:assert/strict";
import { renderReport, type EvalResult } from "../report.ts";

test("exit 0 when no gate violations", () => {
  const r: EvalResult[] = [{ category: "③ risk", metrics: { recall: 1 }, gateViolations: [], lines: ["③ risk: ok"] }];
  const out = renderReport(r);
  assert.equal(out.exitCode, 0);
  assert.match(out.text, /③ risk: ok/);
  assert.match(out.text, /GATES: all passed/);
});

test("exit 1 and lists violations", () => {
  const r: EvalResult[] = [{ category: "④ safety", metrics: {}, gateViolations: ["category leak: create_strategy"], lines: ["④ safety: FAIL"] }];
  const out = renderReport(r);
  assert.equal(out.exitCode, 1);
  assert.match(out.text, /category leak: create_strategy/);
});
