import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { TablePrescreen } from "../tableTypes.ts";

const SCRIPT = fileURLToPath(new URL("../../../../scripts/xbrl/arelle_companion.py", import.meta.url));

/**
 * Column assignment, tiering, calculation export, and drop counting all read
 * Arelle model objects, which are unavailable here. The companion is loaded as
 * a plain module and driven with stdlib stand-ins instead of gaining test-only
 * CLI surface.
 */
function runCompanion(body: string): unknown {
  const result = spawnSync("python3", ["-c", `import importlib.util, json, sys
from types import SimpleNamespace
spec = importlib.util.spec_from_file_location("companion", ${JSON.stringify(SCRIPT)})
companion = importlib.util.module_from_spec(spec)
spec.loader.exec_module(companion)
${body}`], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as unknown;
}

const PERIODS = `[{"id":"FY2025","start":"2025-01-01","end":"2025-12-31","cls":"actual"},
  {"id":"FY2024","start":"2024-01-01","end":"2024-12-31","cls":"actual"}]`;

function cell(columnIndex: number, periodId?: string): string {
  return JSON.stringify(periodId ? { columnIndex, fact: { periodId } } : { columnIndex });
}

test("column periodId is the majority of its facts; ties and empty columns stay absent", () => {
  const columns = runCompanion(`grid = {
  "columns": [{"index": 0}, {"index": 1}, {"index": 2}],
  "rows": [{"cells": [${cell(0)}, ${cell(1, "FY2025")}, ${cell(2, "FY2025")}]},
           {"cells": [${cell(1, "FY2025")}, ${cell(2, "FY2024")}]}],
}
companion.column_period_ids(grid)
json.dump(grid["columns"], sys.stdout)`) as Array<{ periodId?: string }>;
  assert.equal(columns[0]!.periodId, undefined);
  assert.equal(columns[1]!.periodId, "FY2025");
  assert.equal(columns[2]!.periodId, undefined);
});

function prescreenTable(facts: Array<{ concept: string; periodId: string; dimensioned?: boolean }>): string {
  return JSON.stringify({
    rows: facts.map((fact, index) => ({
      order: index + 1,
      cells: [{ columnIndex: 1, text: "1", fact: {
        conceptQName: fact.concept, periodId: fact.periodId,
        dimensions: fact.dimensioned ? [{ axisQName: "us-gaap:StatementBusinessSegmentsAxis" }] : [],
      } }],
    })),
  });
}

const INCOME_CONCEPTS = ["us-gaap:Revenues", "us-gaap:CostOfRevenue", "us-gaap:GrossProfit",
  "us-gaap:OperatingIncomeLoss", "us-gaap:NetIncomeLoss"];

test("a face statement scores strong and a dimensioned segment note scores weak", () => {
  const face = prescreenTable(INCOME_CONCEPTS.flatMap((concept) =>
    [{ concept, periodId: "FY2025" }, { concept, periodId: "FY2024" }]));
  const note = prescreenTable([
    { concept: "us-gaap:Revenues", periodId: "FY2025", dimensioned: true },
    { concept: "us-gaap:Revenues", periodId: "FY2025", dimensioned: true },
    { concept: "aapl:SegmentAssets", periodId: "FY2025", dimensioned: true },
    { concept: "aapl:SegmentMargin", periodId: "FY2025" },
  ]);
  const tables = runCompanion(`tables = [${face}, ${note}]
companion.apply_prescreen(tables, {"income_statement": set(${JSON.stringify(INCOME_CONCEPTS)})})
json.dump([table["prescreen"] for table in tables], sys.stdout)`) as TablePrescreen[];
  assert.deepEqual(tables[0], { tier: "strong", presentationOverlap: 1, dimensionlessRatio: 1, periodSpan: 2, factCount: 10 });
  assert.equal(tables[1]!.tier, "weak");
  assert.equal(tables[1]!.dimensionlessRatio, 0.25);
  assert.equal(tables[1]!.factCount, 4);
});

test("suggestedStatements is ratio-weighted, so a shared concept no longer tags every tree", () => {
  // NetIncomeLoss sits in both trees; a raw intersection suggested both.
  const table = prescreenTable(INCOME_CONCEPTS.map((concept) => ({ concept, periodId: "FY2025" })));
  const suggested = runCompanion(`tables = [${table}]
companion.apply_prescreen(tables, {
  "income_statement": set(${JSON.stringify(INCOME_CONCEPTS)}),
  "cash_flow_statement": {"us-gaap:NetIncomeLoss", "us-gaap:DepreciationAndAmortization"},
})
json.dump(tables[0]["suggestedStatements"], sys.stdout)`);
  assert.deepEqual(suggested, ["income_statement"]);
});

test("a zero-fact table is still emitted, flagged weak so the catalog can exclude it", () => {
  const prescreen = runCompanion(`tables = [{"rows": [{"order": 1, "cells": [{"columnIndex": 0, "text": "Total"}]}]}]
companion.apply_prescreen(tables, {"income_statement": {"us-gaap:Revenues"}})
json.dump(tables[0]["prescreen"], sys.stdout)`) as TablePrescreen;
  assert.deepEqual(prescreen, { tier: "weak", presentationOverlap: 0, dimensionlessRatio: 0, periodSpan: 0, factCount: 0 });
});

test("dropped facts are counted rather than silently discarded", () => {
  const diagnostics = runCompanion(`def duration(name, start, end):
    return SimpleNamespace(id=name, isInstantPeriod=False, isStartEndPeriod=True,
                           startDatetime=start, endDatetime=end)
facts = [
    SimpleNamespace(context=duration("c1", "2025-01-01", "2026-01-01")),
    SimpleNamespace(context=duration("c2", "2019-01-01", "2020-01-01")),
    SimpleNamespace(context=duration("c2", "2019-01-01", "2020-01-01")),
    SimpleNamespace(context=duration("c3", "2019-01-01", "2020-01-01")),
    SimpleNamespace(context=SimpleNamespace(id="c4", isInstantPeriod=True, isStartEndPeriod=False,
                                            instantDatetime="2026-01-01")),
]
json.dump(companion.period_drop_diagnostics(SimpleNamespace(facts=facts), ${PERIODS}), sys.stdout)`);
  // c2 and c3 share one context id, so the count is contexts, not facts.
  assert.deepEqual(diagnostics, ["unmatched_context:2"]);
});

test("calculation relations export weights and order without any arithmetic", () => {
  const relations = runCompanion(`def relation(parent, child, weight, order):
    return SimpleNamespace(fromModelObject=SimpleNamespace(qname=parent), toModelObject=SimpleNamespace(qname=child),
                           weight=weight, order=order)
model = SimpleNamespace(relationshipSet=lambda arc, role=None: SimpleNamespace(
    linkRoleUris=["role://income"],
    modelRelationships=[relation("us-gaap:GrossProfit", "us-gaap:CostOfRevenue", -1, 2),
                        relation("us-gaap:GrossProfit", "us-gaap:Revenues", 1, 1)] if role else []))
json.dump(companion.calculation_relations(model, "calc"), sys.stdout)`);
  assert.deepEqual(relations, [{
    roleUri: "role://income",
    parentConcept: "us-gaap:GrossProfit",
    children: [{ concept: "us-gaap:Revenues", weight: 1, order: 1 },
      { concept: "us-gaap:CostOfRevenue", weight: -1, order: 2 }],
  }]);
});

test("presentation evidence exports concept membership and negated preferred labels without statement rows", () => {
  const evidence = runCompanion(`child = SimpleNamespace(qname="us-gaap:PaymentsToAcquirePropertyPlantAndEquipment")
root = SimpleNamespace(qname="us-gaap:NetCashProvidedByUsedInInvestingActivities")
relation = SimpleNamespace(order=1, toModelObject=child, preferredLabel="http://www.xbrl.org/2003/role/negatedLabel")
relationships = SimpleNamespace(rootConcepts=[root], fromModelObject=lambda concept: [relation] if concept is root else [])
concepts, negated = companion.presentation_evidence(relationships)
json.dump({"concepts": sorted(concepts), "negated": sorted(negated)}, sys.stdout)`);
  assert.deepEqual(evidence, {
    concepts: ["us-gaap:NetCashProvidedByUsedInInvestingActivities", "us-gaap:PaymentsToAcquirePropertyPlantAndEquipment"],
    negated: ["us-gaap:PaymentsToAcquirePropertyPlantAndEquipment"],
  });
});

const STUB_MODEL = `def stub(role_definitions):
    empty = SimpleNamespace(linkRoleUris=[], modelRelationships=[], rootConcepts=[])
    return SimpleNamespace(modelDocument=object(), ixdsHtmlElements=[], facts=[], errors=[],
                           qnameConcepts={},
                           roleTypes={uri: [SimpleNamespace(definition=text)] for uri, text in role_definitions.items()},
                           relationshipSet=lambda arc, role=None: empty, close=lambda: None)
filing = {"accession": "0001104659-26-053166", "form": "10-K/A", "filedAt": "2026-04-01",
          "reportDate": "2025-12-31", "primaryDocumentUrl": "https://example.test/a.htm"}`;

test("a statement-free amendment is diagnosed as such, not as a role lookup failure", () => {
  const diagnostics = runCompanion(`${STUB_MODEL}
manager = SimpleNamespace(load=lambda url: stub({}))
json.dump(companion.extract_filing(manager, "pc", "calc", filing, ${PERIODS})["diagnostics"], sys.stdout)`);
  assert.deepEqual(diagnostics, ["amendment_without_statements:0001104659-26-053166"]);
});

test("a filing that finds some statements still reports the specific missing roles", () => {
  const diagnostics = runCompanion(`${STUB_MODEL}
manager = SimpleNamespace(load=lambda url: stub({"role://income": "Consolidated Statements of Operations"}))
json.dump(companion.extract_filing(manager, "pc", "calc", filing, ${PERIODS})["diagnostics"], sys.stdout)`);
  assert.deepEqual(diagnostics, ["statement_role_not_found:balance_sheet,cash_flow_statement"]);
});
