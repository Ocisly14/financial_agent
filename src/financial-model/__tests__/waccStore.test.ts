import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  InMemoryWaccParameterStore,
  resolveWacc,
  SqliteWaccParameterStore,
  WACC_PARAMETER_NAMES,
  type WaccParameterInput,
  type WaccParameterStore,
} from "../waccStore.ts";

const param = (name: string, value: number, overrides: Partial<WaccParameterInput> = {}): WaccParameterInput => ({
  name: name as never, value, sourceType: "computed", sourceRefs: [], derivation: {},
  asOfDate: "2026-08-07", rationale: "", ...overrides,
});

/** Apple's shape, roughly: the seven terms that make a WACC. */
const COMPLETE: Array<[string, number]> = [
  ["beta", 1.15], ["riskFreeRate", 0.0465], ["equityRiskPremium", 0.05],
  ["costOfDebt", 0.038], ["taxRate", 0.162], ["equityValue", 3_400e9], ["totalDebt", 98e9],
];

function fill(store: WaccParameterStore, modelId = "fm-1"): void {
  for (const [name, value] of COMPLETE) store.put(modelId, param(name, value));
}

for (const [label, make] of [
  ["in memory", () => new InMemoryWaccParameterStore()],
  ["on disk", () => SqliteWaccParameterStore.open(join(mkdtempSync(join(tmpdir(), "wacc-")), "m.sqlite"))],
] as const) {
  test(`${label}: a complete parameter set computes WACC from its own terms`, () => {
    const store = make();
    fill(store);
    const resolved = resolveWacc(store, "fm-1");
    assert.equal(resolved.complete, true);
    if (!resolved.complete) return;
    // CAPM, then the weighted average — the same arithmetic wacc.ts is tested on, but reached
    // entirely from stored terms rather than a number someone typed.
    const costOfEquity = 0.0465 + 1.15 * 0.05;
    const capital = 3_400e9 + 98e9;
    const expected = (3_400e9 / capital) * costOfEquity + (98e9 / capital) * 0.038 * (1 - 0.162);
    assert.ok(Math.abs(resolved.result.costOfEquity - costOfEquity) < 1e-12);
    assert.ok(Math.abs(resolved.result.wacc - expected) < 1e-12, `${resolved.result.wacc} !== ${expected}`);
  });

  test(`${label}: an incomplete set names what is missing instead of computing a plausible number`, () => {
    const store = make();
    for (const [name, value] of COMPLETE.slice(0, 4)) store.put("fm-1", param(name, value));
    const resolved = resolveWacc(store, "fm-1");
    assert.equal(resolved.complete, false);
    if (resolved.complete) return;
    assert.deepEqual(resolved.missing, ["taxRate", "equityValue", "totalDebt"]);
    // The terms that ARE known still come back, so the agent can see how far it got.
    assert.equal(resolved.parameters.length, 4);
  });

  test(`${label}: a parameter is replaced in place, carrying its new provenance`, () => {
    const store = make();
    fill(store);
    store.put("fm-1", param("beta", 1.203, { sourceType: "computed", sourceRefs: ["bars:AAPL/1Day/sip"],
      derivation: { years: 10, frequency: "daily+weekly", marketProxy: "SPY", dailyObservations: 2513 },
      rationale: "10-year window on SIP bars" }));

    const parameters = store.list("fm-1");
    assert.equal(parameters.filter((entry) => entry.name === "beta").length, 1);
    const beta = parameters.find((entry) => entry.name === "beta")!;
    assert.equal(beta.value, 1.203);
    // The derivation is what makes the number re-runnable a session later.
    assert.equal(beta.derivation["dailyObservations"], 2513);
    assert.deepEqual(beta.sourceRefs, ["bars:AAPL/1Day/sip"]);
  });

  test(`${label}: parameters are scoped to their model`, () => {
    const store = make();
    fill(store, "fm-1");
    store.put("fm-2", param("equityRiskPremium", 0.055, { sourceType: "agent_estimate" }));
    assert.equal(store.list("fm-1").length, 7);
    assert.deepEqual(store.list("fm-2").map((entry) => entry.name), ["equityRiskPremium"]);
    assert.equal(resolveWacc(store, "fm-2").complete, false);
  });

  test(`${label}: removing a term makes the WACC unresolvable again rather than stale`, () => {
    const store = make();
    fill(store);
    store.remove("fm-1", "costOfDebt");
    const resolved = resolveWacc(store, "fm-1");
    assert.equal(resolved.complete, false);
    if (!resolved.complete) assert.deepEqual(resolved.missing, ["costOfDebt"]);
  });

  test(`${label}: an unknown name or a non-finite value is refused at the door`, () => {
    const store = make();
    assert.throws(() => store.put("fm-1", param("smallCapPremium", 0.02)), /unknown WACC parameter/);
    assert.throws(() => store.put("fm-1", param("beta", Number.NaN)), /must be a finite number/);
  });

  test(`${label}: listed parameters are ordered so the CAPM terms precede the capital structure`, () => {
    const store = make();
    for (const [name, value] of [...COMPLETE].reverse()) store.put("fm-1", param(name, value));
    assert.deepEqual(store.list("fm-1").map((entry) => entry.name), [...WACC_PARAMETER_NAMES]);
  });
}

test("a reopened database still holds the parameters", () => {
  const directory = mkdtempSync(join(tmpdir(), "wacc-reopen-"));
  const path = join(directory, "m.sqlite");
  try {
    const first = SqliteWaccParameterStore.open(path);
    fill(first);
    first.close();

    const second = SqliteWaccParameterStore.open(path);
    const resolved = resolveWacc(second, "fm-1");
    assert.equal(resolved.complete, true);
    second.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
