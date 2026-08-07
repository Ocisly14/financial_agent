import assert from "node:assert/strict";
import test from "node:test";
import type { Period } from "../../../financial-model/types.ts";
import { buildPresentedStatements } from "../presentedStatement.ts";
import type { FilingExtraction, PresentationNodePayload } from "../types.ts";

const PERIODS: Period[] = [
  { id: "FY2021", label: "FY2021", start: "2021-01-01", end: "2021-12-31", cls: "actual" },
  { id: "FY2022", label: "FY2022", start: "2022-01-01", end: "2022-12-31", cls: "actual" },
  { id: "FY2023", label: "FY2023", start: "2023-01-01", end: "2023-12-31", cls: "actual" },
  { id: "FY2024", label: "FY2024", start: "2024-01-01", end: "2024-12-31", cls: "actual" },
  { id: "FY2025", label: "FY2025", start: "2025-01-01", end: "2025-12-31", cls: "actual" },
];

function node(overrides: Partial<PresentationNodePayload> & { nodeId: number; conceptQName: string }): PresentationNodePayload {
  return {
    parentNodeId: null, label: overrides.conceptQName, abstract: false,
    facts: [], ambiguousPeriodIds: [], ...overrides,
  };
}

function fact(periodId: string, value: number) {
  return { periodId, value, unit: { kind: "currency" as const, code: "USD" }, decimals: -6,
    contextId: `c-${periodId}`, sourceAnchor: "https://example.test#f", dimensions: [] };
}

function extraction(nodes: PresentationNodePayload[]): FilingExtraction {
  return {
    filing: { accession: "acc-1", form: "10-K", filedAt: "2026-02-01", reportDate: "2025-12-31",
      primaryDocumentUrl: "https://example.test/acc-1.htm" },
    tables: [], calculationRelations: [], negatedConcepts: [], diagnostics: [],
    statements: [{ statement: "balance_sheet", roleUri: "role:bs", roleLabel: "Consolidated Balance Sheets",
      declaredAxisQNames: [], nodes }],
  };
}

test("nodes keep their declared order and their parent links", () => {
  const [statement] = buildPresentedStatements({
    filings: [extraction([
      node({ nodeId: 0, conceptQName: "us-gaap:AssetsAbstract", abstract: true }),
      node({ nodeId: 1, parentNodeId: 0, conceptQName: "us-gaap:Assets", label: "Total assets", facts: [fact("FY2025", 137806)] }),
    ])],
    requestedPeriods: PERIODS,
  });

  assert.equal(statement!.accession, "acc-1");
  assert.deepEqual(statement!.nodes.map((entry) => [entry.nodeId, entry.parentNodeId, entry.label]), [
    [0, null, "us-gaap:AssetsAbstract"],
    [1, 0, "Total assets"],
  ]);
  assert.equal(statement!.nodes[1]!.valueByPeriod.get("FY2025")!.value, 137806);
});

test("facts outside the requested periods are dropped and do not widen periodIds", () => {
  const [statement] = buildPresentedStatements({
    filings: [extraction([
      node({ nodeId: 0, conceptQName: "us-gaap:Assets", facts: [fact("FY2025", 1), fact("FY2019", 2)] }),
    ])],
    requestedPeriods: PERIODS,
  });

  assert.deepEqual([...statement!.nodes[0]!.valueByPeriod.keys()], ["FY2025"]);
  assert.deepEqual(statement!.periodIds, ["FY2025"]);
});

test("periodIds follow the requested order, not the order facts arrived in", () => {
  const [statement] = buildPresentedStatements({
    filings: [extraction([
      node({ nodeId: 0, conceptQName: "us-gaap:Assets", facts: [fact("FY2025", 1), fact("FY2024", 2)] }),
    ])],
    requestedPeriods: PERIODS,
  });

  assert.deepEqual(statement!.periodIds, ["FY2024", "FY2025"]);
});

test("a filing carrying no statements produces none", () => {
  const empty: FilingExtraction = { ...extraction([]), statements: [] };
  assert.deepEqual(buildPresentedStatements({ filings: [empty], requestedPeriods: PERIODS }), []);
});

test("the captured TSLA FY2025 payload builds a balance sheet that balances", async () => {
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const { verifyPresentedStatement } = await import("../verifyPresentedStatement.ts");
  const path = fileURLToPath(new URL("../../../../scripts/xbrl/fixtures/tsla-fy2025-statements.json", import.meta.url));
  const response = JSON.parse(await readFile(path, "utf8")) as { filings: FilingExtraction[] };

  const statements = buildPresentedStatements({ filings: response.filings, requestedPeriods: PERIODS });
  const balanceSheet = statements.find((entry) => entry.statement === "balance_sheet")!;

  assert.equal(balanceSheet.nodes.find((node) => node.conceptQName === "us-gaap:Assets")!.valueByPeriod.get("FY2025")!.value, 137_806_000_000);
  assert.equal(balanceSheet.nodes.find((node) => node.conceptQName === "tsla:LeasedAssetsNet")!.valueByPeriod.get("FY2025")!.value, 4_604_000_000,
    "a line item reported only under a declared axis member must still resolve");

  const verification = verifyPresentedStatement(balanceSheet, response.filings[0]!.calculationRelations);
  assert.deepEqual(verification.balanceBreaks, []);
  assert.deepEqual(verification.rollupBreaks, []);
});
