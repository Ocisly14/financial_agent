// Focused on the risk-free-rate term of deriveWaccParameters: the Treasury feed is injected through
// DerivationDeps.treasury30y, so these tests never touch the network. Other terms are left unreachable
// on purpose (no facts/periods supplied) — this file only asserts riskFreeRate's own behavior.
import assert from "node:assert/strict";
import test from "node:test";
import { deriveWaccParameters } from "../waccDerivation.ts";

const ASOF = "2026-01-05";

function baseInput(treasury30y?: (asOfDate: string) => Promise<{ value: number; curveDate: string } | undefined>) {
  return {
    symbol: "AAPL",
    asOfDate: ASOF,
    facts: [],
    lineItems: [],
    periods: [],
    deps: {
      dailyCloses: async () => [],
      ...(treasury30y ? { treasury30y } : {}),
    },
  };
}

test("riskFreeRate derives as a market-sourced term when the Treasury dep resolves", async () => {
  const result = await deriveWaccParameters(baseInput(async (asOfDate) => {
    assert.equal(asOfDate, ASOF);
    return { value: 0.0486, curveDate: "2026-01-02" };
  }));
  const rf = result.derived.find((entry) => entry.name === "riskFreeRate");
  assert.ok(rf, "riskFreeRate should be derived");
  assert.equal(rf!.value, 0.0486);
  assert.equal(rf!.sourceType, "market");
  assert.deepEqual(rf!.derivation, { term: "30Y", curveDate: "2026-01-02", feed: "treasury.gov" });
  assert.match(rf!.rationale, /30-year constant-maturity Treasury yield as of 2026-01-02 \(treasury\.gov daily yield curve\)/);
  assert.ok(!result.unreachable.some((entry) => entry.name === "riskFreeRate"));
});

test("riskFreeRate is unreachable, with a clear reason, when the Treasury dep resolves to undefined", async () => {
  const result = await deriveWaccParameters(baseInput(async () => undefined));
  assert.ok(!result.derived.some((entry) => entry.name === "riskFreeRate"));
  const entry = result.unreachable.find((u) => u.name === "riskFreeRate");
  assert.ok(entry);
  assert.equal(entry!.reason, "treasury.gov 30Y yield unavailable; supply it as an override");
});

test("riskFreeRate is unreachable when no treasury30y dep is wired at all", async () => {
  const result = await deriveWaccParameters(baseInput());
  assert.ok(!result.derived.some((entry) => entry.name === "riskFreeRate"));
  const entry = result.unreachable.find((u) => u.name === "riskFreeRate");
  assert.ok(entry);
  assert.equal(entry!.reason, "treasury.gov 30Y yield unavailable; supply it as an override");
});

test("equityRiskPremium remains unreachable regardless of the Treasury dep (no measurable source by nature)", async () => {
  const result = await deriveWaccParameters(baseInput(async () => ({ value: 0.0486, curveDate: "2026-01-02" })));
  const entry = result.unreachable.find((u) => u.name === "equityRiskPremium");
  assert.ok(entry);
  assert.equal(entry!.reason, "no measurable source by nature; state it as an override");
});
