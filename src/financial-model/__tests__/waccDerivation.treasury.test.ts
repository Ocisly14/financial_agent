// Focused on the risk-free-rate term of deriveWaccParameters: the Treasury feed is injected through
// DerivationDeps.treasury30y, so these tests never touch the network. Other terms are left unreachable
// on purpose (no facts/periods supplied) — this file only asserts riskFreeRate's own behavior.
import assert from "node:assert/strict";
import test from "node:test";
import { cellKey } from "../dsl/graph.ts";
import { deriveWaccParameters } from "../waccDerivation.ts";
import type { Cell, LineItem, Period, Unit } from "../types.ts";

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

test("filing-derived WACC terms use the final workbook formula, not the raw mapped fact", async () => {
  const currency: Unit = { kind: "currency", code: "USD" };
  const periods: Period[] = [
    { id: "FY2024", label: "FY2024", start: "2024-01-01", end: "2024-12-31", cls: "actual" },
    { id: "FY2025", label: "FY2025", start: "2025-01-01", end: "2025-12-31", cls: "actual" },
  ];
  const debt: LineItem = {
    id: "debt", label: "Debt", role: "debt", unit: currency, section: "dcf", order: 0,
    historical: "formula", forecast: "none",
  };
  const cells = new Map<string, Cell>([
    [cellKey("debt", "FY2024"), { value: 80, unit: currency, diagnostics: [] }],
    // The raw fact intentionally says 100, while the agent's formula has added finance leases and
    // produces 125. WACC must consume 125.
    [cellKey("debt", "FY2025"), { value: 125, unit: currency, diagnostics: [] }],
  ]);
  const result = await deriveWaccParameters({
    symbol: "AAPL", asOfDate: ASOF,
    facts: [{ factId: "raw-debt", status: "committed", lineItemId: "debt", periodId: "FY2025", value: 100,
      unit: currency, provenance: { sourceType: "filing", sourceRefs: [], asOfDate: ASOF } }],
    lineItems: [debt], periods, cells,
    deps: { dailyCloses: async () => [] },
  });
  const totalDebt = result.derived.find((entry) => entry.name === "totalDebt");
  assert.equal(totalDebt?.value, 125);
  assert.equal(totalDebt?.sourceType, "computed");
  assert.deepEqual(totalDebt?.sourceRefs, ["model:debt@FY2025"]);
});
