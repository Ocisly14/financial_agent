import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTO_PREMAP_PLAN_PREFIX,
  CONCEPT_SPINE_MAP,
  assertInjectiveVocabulary,
  buildPremap,
  TARGET_LABELS,
} from "../autoPremap.ts";
import { CANONICAL_MAPPING_IDS, createSkeleton } from "../skeleton.ts";
import type { Fact } from "../types.ts";
import type { PreparedStatementRowView } from "../../infra/xbrl/types.ts";
import type { DecompositionSummary } from "../../infra/xbrl/decompositionTypes.ts";

const SLUG_RE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

// --- fixture builders ------------------------------------------------------------------------

let orderCounter = 0;
function row(overrides: Partial<PreparedStatementRowView> & { sourceLineItemId: string; conceptQName: string }): PreparedStatementRowView {
  orderCounter += 1;
  return {
    statement: "income_statement",
    label: overrides.sourceLineItemId,
    unit: { kind: "currency", code: "USD" },
    order: orderCounter,
    dimensionSignature: "",
    dimensions: [],
    depth: 0,
    presentationAccessions: [],
    ...overrides,
  };
}

let factCounter = 0;
function fact(lineItemId: string, periodId: string, value: number, overrides: Partial<Fact> = {}): Fact {
  factCounter += 1;
  return {
    factId: `f${factCounter}`,
    status: "staged",
    lineItemId,
    periodId,
    value,
    unit: { kind: "currency", code: "USD" },
    provenance: { sourceType: "filing_xbrl", sourceRefs: [], asOfDate: "2025-01-01" },
    ...overrides,
  };
}

function period(id: string) {
  return { id, label: id, start: "2024-01-01", end: "2024-12-31", cls: "actual" as const };
}

type BuildInputOpts = {
  incomeRows?: PreparedStatementRowView[];
  balanceRows?: PreparedStatementRowView[];
  cashRows?: PreparedStatementRowView[];
  facts: Fact[];
  decomposition?: DecompositionSummary;
  historicalPeriodIds: string[];
};

function buildInput(opts: BuildInputOpts) {
  const periods = opts.historicalPeriodIds.map(period);
  return {
    statementViews: {
      income_statement: { candidate: { periods, rows: opts.incomeRows ?? [] }, filingPresentations: [] },
      balance_sheet: { candidate: { periods, rows: opts.balanceRows ?? [] }, filingPresentations: [] },
      cash_flow_statement: { candidate: { periods, rows: opts.cashRows ?? [] }, filingPresentations: [] },
    },
    facts: opts.facts,
    ...(opts.decomposition ? { decomposition: opts.decomposition } : {}),
    historicalPeriodIds: opts.historicalPeriodIds,
  };
}

// === 1. Vocabulary injectivity ================================================================

test("assertInjectiveVocabulary passes on the real CONCEPT_SPINE_MAP, throws on a hand-built duplicate", () => {
  assert.doesNotThrow(() => assertInjectiveVocabulary());

  const backup = [...CONCEPT_SPINE_MAP.gross_profit!];
  CONCEPT_SPINE_MAP.gross_profit!.push("Revenues"); // "Revenues" already maps to revenue.total
  try {
    assert.throws(() => assertInjectiveVocabulary(), /not injective/);
  } finally {
    CONCEPT_SPINE_MAP.gross_profit!.length = 0;
    CONCEPT_SPINE_MAP.gross_profit!.push(...backup);
    assertInjectiveVocabulary(); // restore module-level reverseVocab for subsequent tests
  }
});

// === 2. Layer 1: concept vocabulary ===========================================================

test("dimensionless us-gaap row maps to its spine target with an auto-premap plan", () => {
  const r = row({ sourceLineItemId: "row-rev", label: "Net sales", conceptQName: "us-gaap:Revenues" });
  const input = buildInput({
    incomeRows: [r],
    facts: [fact("row-rev", "FY2025", 100)],
    historicalPeriodIds: ["FY2025"],
  });

  const out = buildPremap(input);

  const plan = out.plans.find((p) => p.targetLineItemId === "revenue.total");
  assert.ok(plan, "plan created for revenue.total");
  assert.deepEqual(plan!.periodIds, ["FY2025"]);
  assert.deepEqual(plan!.members, [{ sourceLineItemId: "row-rev", treatment: "add" }]);
  assert.ok(plan!.reviewDecisionId.startsWith(AUTO_PREMAP_PLAN_PREFIX));

  const mapped = out.summary.mapped.find((m) => m.targetLineItemId === "revenue.total");
  assert.ok(mapped);
  assert.equal(mapped!.basis, "concept_vocab");
  assert.equal(mapped!.reconciliation, "ok");
  assert.deepEqual(mapped!.sourceRows, [{ sourceLineItemId: "row-rev", label: "Net sales", conceptQName: "us-gaap:Revenues" }]);
});

test("dimensional rows are ignored by Layer 1 (excluded from mapping and from unmapped bookkeeping)", () => {
  const dimensional = row({
    sourceLineItemId: "row-cor-seg",
    conceptQName: "us-gaap:CostOfRevenue",
    dimensionSignature: "srt:ProductOrServiceAxis=widgets",
  });
  const input = buildInput({
    incomeRows: [dimensional],
    facts: [fact("row-cor-seg", "FY2025", 40)],
    historicalPeriodIds: ["FY2025"],
  });

  const out = buildPremap(input);

  assert.equal(out.plans.find((p) => p.targetLineItemId === "cost_of_revenue"), undefined);
  assert.equal(out.summary.mapped.find((m) => m.targetLineItemId === "cost_of_revenue"), undefined);
  assert.ok(out.summary.unmapped.spineTargets.includes("cost_of_revenue"));
  assert.equal(out.summary.unmapped.sourceRows.find((r) => r.sourceLineItemId === "row-cor-seg"), undefined);
});

test("non us-gaap namespace concepts are ignored by Layer 1 but surface as unmapped source rows", () => {
  const foreign = row({ sourceLineItemId: "row-ifrs-rev", conceptQName: "ifrs-full:Revenue", label: "Revenue (IFRS)" });
  const input = buildInput({
    incomeRows: [foreign],
    facts: [fact("row-ifrs-rev", "FY2025", 100)],
    historicalPeriodIds: ["FY2025"],
  });

  const out = buildPremap(input);

  assert.equal(out.plans.length, 0);
  assert.equal(out.summary.mapped.length, 0);
  assert.ok(out.summary.unmapped.sourceRows.some((r) => r.sourceLineItemId === "row-ifrs-rev"));
});

test("two rows matching one target with disjoint periods produce two plans with disjoint periodIds", () => {
  const rowA = row({ sourceLineItemId: "cor-old", conceptQName: "us-gaap:CostOfGoodsSold" });
  const rowB = row({ sourceLineItemId: "cor-new", conceptQName: "us-gaap:CostOfGoodsAndServicesSold" });
  const input = buildInput({
    incomeRows: [rowA, rowB],
    facts: [fact("cor-old", "FY2023", 50), fact("cor-new", "FY2024", 60)],
    historicalPeriodIds: ["FY2023", "FY2024"],
  });

  const out = buildPremap(input);

  const plans = out.plans.filter((p) => p.targetLineItemId === "cost_of_revenue");
  assert.equal(plans.length, 2);
  const periodSets = plans.map((p) => p.periodIds).sort();
  assert.deepEqual(periodSets, [["FY2023"], ["FY2024"]]);
  assert.equal(out.summary.demoted.find((d) => d.targetLineItemId === "cost_of_revenue"), undefined);

  const mapped = out.summary.mapped.find((m) => m.targetLineItemId === "cost_of_revenue");
  assert.equal(mapped!.periodIds.length, 2);
  assert.equal(mapped!.sourceRows.length, 2);
});

test("two rows matching one target with overlapping periods are demoted, not mapped", () => {
  const rowA = row({ sourceLineItemId: "cor-a", conceptQName: "us-gaap:CostOfGoodsSold" });
  const rowB = row({ sourceLineItemId: "cor-b", conceptQName: "us-gaap:CostOfGoodsAndServicesSold" });
  const input = buildInput({
    incomeRows: [rowA, rowB],
    facts: [fact("cor-a", "FY2025", 50), fact("cor-b", "FY2025", 55)],
    historicalPeriodIds: ["FY2025"],
  });

  const out = buildPremap(input);

  assert.equal(out.plans.find((p) => p.targetLineItemId === "cost_of_revenue"), undefined);
  assert.equal(out.summary.mapped.find((m) => m.targetLineItemId === "cost_of_revenue"), undefined);
  const demoted = out.summary.demoted.find((d) => d.targetLineItemId === "cost_of_revenue");
  assert.ok(demoted);
  assert.match(demoted!.reason, /overlapping periods/);
  assert.ok(out.summary.unmapped.spineTargets.includes("cost_of_revenue"));
});

// === 3. SG&A rule ==============================================================================

test("SG&A: combined SellingGeneralAndAdministrativeExpense maps to selling_and_marketing when no G&A row exists", () => {
  const sga = row({ sourceLineItemId: "row-sga", conceptQName: "us-gaap:SellingGeneralAndAdministrativeExpense" });
  const input = buildInput({
    incomeRows: [sga],
    facts: [fact("row-sga", "FY2025", 30)],
    historicalPeriodIds: ["FY2025"],
  });

  const out = buildPremap(input);

  const plan = out.plans.find((p) => p.targetLineItemId === "selling_and_marketing");
  assert.ok(plan);
  assert.deepEqual(plan!.members, [{ sourceLineItemId: "row-sga", treatment: "add" }]);
  assert.equal(out.summary.mapped.find((m) => m.targetLineItemId === "general_and_administrative"), undefined);
});

test("SG&A: when a separate G&A row exists, G&A maps and combined SG&A is left unmapped (per implementation)", () => {
  const ga = row({ sourceLineItemId: "row-ga", conceptQName: "us-gaap:GeneralAndAdministrativeExpense" });
  const sga = row({ sourceLineItemId: "row-sga", conceptQName: "us-gaap:SellingGeneralAndAdministrativeExpense" });
  const input = buildInput({
    incomeRows: [ga, sga],
    facts: [fact("row-ga", "FY2025", 20), fact("row-sga", "FY2025", 30)],
    historicalPeriodIds: ["FY2025"],
  });

  const out = buildPremap(input);

  const gaMapped = out.summary.mapped.find((m) => m.targetLineItemId === "general_and_administrative");
  assert.ok(gaMapped);
  assert.deepEqual(gaMapped!.sourceRows, [{ sourceLineItemId: "row-ga", label: "row-ga", conceptQName: "us-gaap:GeneralAndAdministrativeExpense" }]);

  // Current implementation: SGA row is never folded in once a G&A row exists, and there is no
  // separate SellingAndMarketingExpense row here, so selling_and_marketing stays unmapped and the
  // combined SGA row is left in unmapped.sourceRows.
  assert.equal(out.summary.mapped.find((m) => m.targetLineItemId === "selling_and_marketing"), undefined);
  assert.ok(out.summary.unmapped.spineTargets.includes("selling_and_marketing"));
  assert.ok(out.summary.unmapped.sourceRows.some((r) => r.sourceLineItemId === "row-sga"));
});

// === 4. Layer 2a: face children of revenue.total ===============================================

test("Layer 2a: face revenue children become streams with valid slugs; label collisions dedupe; digit-leading labels get prefixed", () => {
  const rev = row({ sourceLineItemId: "rev", conceptQName: "us-gaap:Revenues", label: "Total revenue" });
  const childA = row({
    sourceLineItemId: "child-a", label: "Automotive sales",
    conceptQName: "us-gaap:SalesRevenueServicesNet", parentSourceLineItemId: "rev",
  });
  const childB = row({
    sourceLineItemId: "child-b", label: "Automotive sales", // duplicate label -> slug collision
    conceptQName: "us-gaap:SalesRevenueServicesNet", parentSourceLineItemId: "rev",
  });
  const childC = row({
    sourceLineItemId: "child-c", label: "3D Systems", // digit-leading label
    conceptQName: "us-gaap:SalesRevenueServicesNet", parentSourceLineItemId: "rev",
  });

  const input = buildInput({
    incomeRows: [rev, childA, childB, childC],
    facts: [
      fact("rev", "FY2025", 100), fact("child-a", "FY2025", 40), fact("child-b", "FY2025", 35), fact("child-c", "FY2025", 25),
    ],
    historicalPeriodIds: ["FY2025"],
  });

  const out = buildPremap(input);

  const slugs = out.streams.map((s) => s.id).sort();
  assert.deepEqual(slugs, ["automotive_sales", "automotive_sales_2", "s_3d_systems"]);
  for (const slug of slugs) assert.match(slug, SLUG_RE);

  for (const streamRowId of ["child-a", "child-b", "child-c"]) {
    const targetId = out.plans.find((p) => p.members[0]!.sourceLineItemId === streamRowId)!.targetLineItemId;
    const plan = out.plans.find((p) => p.targetLineItemId === targetId)!;
    assert.deepEqual(plan.members, [{ sourceLineItemId: streamRowId, treatment: "add" }]);
    const mapped = out.summary.mapped.find((m) => m.targetLineItemId === targetId)!;
    assert.equal(mapped.basis, "face_child");
    assert.equal(mapped.reconciliation, "ok");
  }
  // identity guard passed (40+35+25 == 100), so revenue.total is not demoted.
  assert.equal(out.summary.demoted.find((d) => d.targetLineItemId === "revenue.total"), undefined);
});

// === 5. Layer 2b: decomposition scheme streams =================================================

test("Layer 2b: no face children -> driver scheme children/residual become streams incl. revenue.other_<axis>", () => {
  const rev = row({ sourceLineItemId: "rev", conceptQName: "us-gaap:Revenues", label: "Total revenue" });
  const input = buildInput({
    incomeRows: [rev],
    facts: [
      fact("rev", "FY2025", 100),
      fact("schild-a", "FY2025", 50), fact("schild-b", "FY2025", 30), fact("schild-residual", "FY2025", 20),
    ],
    historicalPeriodIds: ["FY2025"],
    decomposition: {
      schemes: [{
        candidateSchemeId: "cs-1", label: "by product", axisHint: "srt:ProductOrServiceAxis", targetSourceLineItemId: "rev",
        driver: true,
        children: [
          { childRowId: "schild-a", label: "Product A" },
          { childRowId: "schild-b", label: "Product B" },
          { childRowId: "schild-residual", label: "Other", residual: true },
        ],
      }],
    },
  });

  const out = buildPremap(input);

  const slugs = out.streams.map((s) => s.id).sort();
  assert.deepEqual(slugs, ["other_productorserviceaxis", "product_a", "product_b"]);
  const residualPlan = out.plans.find((p) => p.targetLineItemId === "revenue.other_productorserviceaxis");
  assert.ok(residualPlan);
  assert.deepEqual(residualPlan!.members, [{ sourceLineItemId: "schild-residual", treatment: "add" }]);
  for (const s of out.summary.mapped.filter((m) => m.basis === "decomposition_scheme")) {
    assert.equal(s.reconciliation, "ok");
  }
  assert.equal(out.summary.demoted.find((d) => d.targetLineItemId === "revenue.total"), undefined);
});

test("Layer 2b: with face children present, scheme streams are skipped; same-axis scheme is demoted", () => {
  const rev = row({ sourceLineItemId: "rev", conceptQName: "us-gaap:Revenues", label: "Total revenue" });
  const childA = row({
    sourceLineItemId: "child-a", label: "Product A",
    conceptQName: "us-gaap:SalesRevenueServicesNet", parentSourceLineItemId: "rev",
  });
  const childB = row({
    sourceLineItemId: "child-b", label: "Product B",
    conceptQName: "us-gaap:SalesRevenueServicesNet", parentSourceLineItemId: "rev",
  });
  const input = buildInput({
    incomeRows: [rev, childA, childB],
    facts: [fact("rev", "FY2025", 100), fact("child-a", "FY2025", 60), fact("child-b", "FY2025", 40)],
    historicalPeriodIds: ["FY2025"],
    decomposition: {
      schemes: [{
        candidateSchemeId: "cs-1", label: "by product (same axis)", axisHint: "srt:ProductOrServiceAxis",
        targetSourceLineItemId: "rev", driver: false,
        children: [
          { childRowId: "schild-a", label: "Product A" }, // normalize-matches face child-a label
          { childRowId: "schild-b", label: "Product B" }, // normalize-matches face child-b label
        ],
      }],
    },
  });

  const out = buildPremap(input);

  // No scheme-derived streams; only the two face-child streams exist.
  assert.equal(out.streams.length, 2);
  assert.equal(out.summary.mapped.filter((m) => m.basis === "decomposition_scheme").length, 0);

  const demoted = out.summary.demoted.find((d) => d.targetLineItemId === "rev");
  assert.ok(demoted);
  assert.equal(demoted!.reason, "axis_already_covered_by_face_children");
});

// === 6. Identity guard ==========================================================================

test("identity guard: stream set within 0.5% of revenue.total per period survives", () => {
  const rev = row({ sourceLineItemId: "rev", conceptQName: "us-gaap:Revenues" });
  const childA = row({
    sourceLineItemId: "child-a", label: "Stream A",
    conceptQName: "us-gaap:SalesRevenueServicesNet", parentSourceLineItemId: "rev",
  });
  const childB = row({
    sourceLineItemId: "child-b", label: "Stream B",
    conceptQName: "us-gaap:SalesRevenueServicesNet", parentSourceLineItemId: "rev",
  });
  const input = buildInput({
    incomeRows: [rev, childA, childB],
    // gap = 0.3 on 100 = 0.3% < 0.5% threshold
    facts: [fact("rev", "FY2025", 100), fact("child-a", "FY2025", 59.85), fact("child-b", "FY2025", 39.85)],
    historicalPeriodIds: ["FY2025"],
  });

  const out = buildPremap(input);

  assert.equal(out.streams.length, 2);
  assert.equal(out.summary.demoted.find((d) => d.targetLineItemId === "revenue.total"), undefined);
  assert.ok(out.summary.unmapped.sourceRows.find((r) => r.sourceLineItemId === "child-a") === undefined);
});

test("identity guard: a >0.5% gap in any period demotes the whole stream set", () => {
  const rev = row({ sourceLineItemId: "rev", conceptQName: "us-gaap:Revenues" });
  const childA = row({
    sourceLineItemId: "child-a", label: "Stream A",
    conceptQName: "us-gaap:SalesRevenueServicesNet", parentSourceLineItemId: "rev",
  });
  const childB = row({
    sourceLineItemId: "child-b", label: "Stream B",
    conceptQName: "us-gaap:SalesRevenueServicesNet", parentSourceLineItemId: "rev",
  });
  const input = buildInput({
    incomeRows: [rev, childA, childB],
    // sum = 80 vs total 100 -> 20% gap, well over 0.5%
    facts: [fact("rev", "FY2025", 100), fact("child-a", "FY2025", 40), fact("child-b", "FY2025", 40)],
    historicalPeriodIds: ["FY2025"],
  });

  const out = buildPremap(input);

  assert.equal(out.streams.length, 0);
  assert.equal(out.plans.find((p) => p.targetLineItemId.startsWith("revenue.") && p.targetLineItemId !== "revenue.total"), undefined);
  assert.equal(out.summary.mapped.find((m) => m.targetLineItemId.startsWith("revenue.") && m.targetLineItemId !== "revenue.total"), undefined);

  const demoted = out.summary.demoted.find((d) => d.targetLineItemId === "revenue.total");
  assert.ok(demoted);
  assert.match(demoted!.reason, /stream set demoted/);

  assert.ok(out.summary.unmapped.sourceRows.some((r) => r.sourceLineItemId === "child-a"));
  assert.ok(out.summary.unmapped.sourceRows.some((r) => r.sourceLineItemId === "child-b"));
});

// === 7. negated rows =============================================================================

test("a negated row still gets treatment add in the generated plan", () => {
  const r = row({ sourceLineItemId: "row-int-exp", conceptQName: "us-gaap:InterestExpense", negated: true });
  const input = buildInput({
    incomeRows: [r],
    facts: [fact("row-int-exp", "FY2025", 5)],
    historicalPeriodIds: ["FY2025"],
  });

  const out = buildPremap(input);

  const plan = out.plans.find((p) => p.targetLineItemId === "interest_expense");
  assert.ok(plan);
  assert.deepEqual(plan!.members, [{ sourceLineItemId: "row-int-exp", treatment: "add" }]);
});

// === 8. Determinism ===============================================================================

test("buildPremap is deterministic: same input twice yields deeply equal output", () => {
  const rev = row({ sourceLineItemId: "rev", conceptQName: "us-gaap:Revenues" });
  const childA = row({
    sourceLineItemId: "child-a", label: "Automotive sales",
    conceptQName: "us-gaap:SalesRevenueServicesNet", parentSourceLineItemId: "rev",
  });
  const cor = row({ sourceLineItemId: "cor", conceptQName: "us-gaap:CostOfGoodsSold" });
  const input = buildInput({
    incomeRows: [rev, childA, cor],
    facts: [fact("rev", "FY2025", 100), fact("child-a", "FY2025", 100), fact("cor", "FY2025", 40)],
    historicalPeriodIds: ["FY2025"],
  });

  const first = buildPremap(input);
  const second = buildPremap(input);

  assert.deepEqual(first, second);
});

// === 8. Unmapped bookkeeping accounts for the whole spine ======================================

test("a canonical spine target with no concept vocabulary is still reported as unmapped", () => {
  const r = row({ sourceLineItemId: "row-rev", label: "Net sales", conceptQName: "us-gaap:Revenues" });
  const input = buildInput({
    incomeRows: [r],
    facts: [fact("row-rev", "FY2025", 100)],
    historicalPeriodIds: ["FY2025"],
  });

  const out = buildPremap(input);

  const accounted = new Set([
    ...out.summary.mapped.map((entry) => entry.targetLineItemId),
    ...out.summary.demoted.map((entry) => entry.targetLineItemId),
    ...out.summary.unmapped.spineTargets,
  ]);
  const invisible = [...CANONICAL_MAPPING_IDS].filter((target) => !accounted.has(target));
  assert.deepEqual(invisible, [], "every canonical spine target must appear in mapped, demoted, or unmapped");
});

test("diluted shares, NCI, and other non-operating income map from their us-gaap concepts", () => {
  const diluted = row({ sourceLineItemId: "row-diluted", label: "Diluted", statement: "income_statement",
    conceptQName: "us-gaap:WeightedAverageNumberOfDilutedSharesOutstanding", unit: { kind: "shares" } });
  const nci = row({ sourceLineItemId: "row-nci", label: "Noncontrolling interests in subsidiaries",
    statement: "balance_sheet", conceptQName: "us-gaap:MinorityInterest" });
  const other = row({ sourceLineItemId: "row-other", label: "Other (expense) income, net",
    statement: "income_statement", conceptQName: "us-gaap:OtherNonoperatingIncomeExpense" });

  const out = buildPremap(buildInput({
    incomeRows: [diluted, other],
    balanceRows: [nci],
    facts: [fact("row-diluted", "FY2025", 3_500_000_000, { unit: { kind: "shares" } }),
      fact("row-nci", "FY2025", 900_000_000), fact("row-other", "FY2025", 1_200_000_000)],
    historicalPeriodIds: ["FY2025"],
  }));

  const mappedBy = new Map(out.summary.mapped.map((entry) => [entry.targetLineItemId, entry]));
  assert.deepEqual([...mappedBy.keys()].filter((id) => id !== "revenue.total").sort(),
    ["diluted_shares", "non_controlling_interests", "non_operating_income_expense"]);
  for (const target of ["diluted_shares", "non_controlling_interests", "non_operating_income_expense"]) {
    assert.equal(mappedBy.get(target)!.basis, "concept_vocab");
  }
});

test("every vocabulary target's premap label is the skeleton's own label for that row", () => {
  const skeleton = createSkeleton({ currency: "USD", periods: [period("FY2025")] });
  const skeletonLabels = new Map(skeleton.lineItems.map((item) => [item.id, item.label]));

  const drifted = Object.keys(CONCEPT_SPINE_MAP)
    .map((target) => [target, TARGET_LABELS[target], skeletonLabels.get(target)] as const)
    .filter(([, premapLabel, skeletonLabel]) => premapLabel !== skeletonLabel);

  assert.deepEqual(drifted, [], "TARGET_LABELS must not drift from the skeleton");
});
