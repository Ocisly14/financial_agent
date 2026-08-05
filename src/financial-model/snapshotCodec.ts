import { splitCellKey, type CellKey } from "./dsl/graph.ts";
import { parseFormula, type Ast, type FnName } from "./dsl/parser.ts";
import { sameUnit } from "./dsl/units.ts";
import { FinancialModelError } from "./errors.ts";
import type { Formula } from "./engine.ts";
import type {
  CompiledFormula,
  FinancialModelSnapshot,
  MappingException,
} from "./operations.ts";
import { buildGrid } from "./periodGrid.ts";
import type { SnapshotCodec } from "./store.ts";
import type {
  Assumption,
  AssumptionPayload,
  AssumptionSourceType,
  Cell,
  CellSource,
  DcfCategoryGroup,
  Diagnostic,
  Fact,
  FactReviewDecision,
  FactStatus,
  LifecycleStage,
  LineItem,
  LineItemRole,
  LineItemSection,
  Period,
  PeriodClass,
  Provenance,
  ReconciliationResult,
  StatementMappingPlan,
  Unit,
  ValuationConfig,
} from "./types.ts";
import {
  MAX_SENSITIVITY_AXIS_LENGTH,
  type BridgeAdjustment,
  type ExplicitPeriodValue,
  type SensitivityCell,
  type SensitivityMatrix,
  type TerminalMethodResult,
  type ValuationDiagnostic,
  type ValuationOutput,
} from "./valuation.ts";

type PlainObject = Record<string, unknown>;
type WireCell = { key: CellKey; cell: Cell };

const SNAPSHOT_FIELDS = [
  "lifecycleStage",
  "periods",
  "lineItems",
  "facts",
  "factReviewDecisions",
  "assumptions",
  "formulas",
  "compiledFormulas",
  "selectedHistoricalPeriodIds",
  "statementMappingPlans",
  "categoryGroups",
  "proposedStatementMappings",
  "valuationConfig",
  "cells",
  "diagnostics",
  "mappingDiagnostics",
  "reconciliationResults",
  "mappingException",
  "valuation",
  "engineVersion",
] as const;

const PERIOD_CLASSES = ["actual", "ttm", "forecast"] as const;
const LIFECYCLE_STAGES = [
  "draft",
  "history_committed",
  "revenue_forecast",
  "operations_fcff",
  "valued",
  "archived",
] as const;
const CELL_SOURCES = ["actual", "assumption", "formula", "calculated", "none"] as const;
const LINE_ITEM_SECTIONS = [
  "source_income_statement",
  "source_balance_sheet",
  "source_cash_flow",
  "history",
  "metrics",
  "revenue",
  "operations",
  "dcf",
] as const;
const LINE_ITEM_ROLES = [
  "revenue_root",
  "revenue_stream",
  "revenue_total",
  "operating_income",
  "tax_rate",
  "nopat",
  "depreciation_amortization",
  "ebitda",
  "capex",
  "operating_working_capital",
  "change_nwc",
  "fcff",
  "wacc",
  "terminal_growth",
  "exit_multiple",
  "cash_available_for_bridge",
  "non_operating_investments",
  "debt",
  "lease_liabilities",
  "preferred_equity",
  "non_controlling_interests",
  "bridge_other",
  "diluted_shares",
  "none",
] as const;
const FACT_STATUSES = ["staged", "committed", "rejected", "superseded"] as const;
const ASSUMPTION_SOURCE_TYPES = [
  "user",
  "management_guidance",
  "company_disclosure",
  "consensus",
  "macro_research",
  "industry_research",
  "analyst_inference",
] as const;
const DIAGNOSTIC_CODES = [
  "missing_input",
  "divide_by_zero",
  "skipped_ttm",
  "not_applicable",
] as const;
const FN_NAMES = [
  "SUM",
  "AVERAGE",
  "LAG",
  "YOY",
  "CAGR",
  "MIN",
  "MAX",
  "ABS",
  "POW",
  "YEAR_INDEX",
  "DISCOUNT_FACTOR",
] as const;

export const financialModelSnapshotCodec: SnapshotCodec<FinancialModelSnapshot> = {
  encode(snapshot) {
    return wrapInvalidSnapshot("snapshot encoding failed", () => {
      const normalized = normalizeSnapshot(snapshot, "runtime");
      return JSON.stringify(toWireSnapshot(normalized));
    });
  },
  decode(json) {
    return wrapInvalidSnapshot("stored snapshot is invalid", () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(json);
      } catch (cause) {
        throw invalid("$", "malformed JSON", cause);
      }
      return normalizeSnapshot(parsed, "wire");
    });
  },
};

function normalizeSnapshot(
  value: unknown,
  representation: "runtime" | "wire",
): FinancialModelSnapshot {
  const root = exactObject(value, "$", SNAPSHOT_FIELDS);
  const periods = array(root.periods, "$.periods", normalizePeriod);
  buildGrid(periods);
  const periodById = uniqueBy(periods, (period) => period.id, "$.periods", "period id");
  const lineItems = array(root.lineItems, "$.lineItems", normalizeLineItem);
  const itemById = uniqueBy(
    lineItems,
    (item) => item.id,
    "$.lineItems",
    "line-item id",
  );
  validateLineItemReferences(lineItems, itemById);

  const facts = array(root.facts, "$.facts", normalizeFact);
  const factById = uniqueBy(facts, (fact) => fact.factId, "$.facts", "fact id");
  validateFacts(facts, factById, itemById, periodById);
  const factReviewDecisions = array(
    root.factReviewDecisions,
    "$.factReviewDecisions",
    normalizeFactReviewDecision,
  );
  validateFactReviewDecisions(factReviewDecisions, factById, itemById);

  const assumptions = array(root.assumptions, "$.assumptions", normalizeAssumption);
  validateAssumptions(assumptions, itemById, periodById);
  const formulas = array(root.formulas, "$.formulas", normalizeFormula);
  validateFormulaCoverage(formulas, itemById, periods, periodById, "$.formulas");
  const compiledFormulas = array(
    root.compiledFormulas,
    "$.compiledFormulas",
    normalizeCompiledFormula,
  );
  validateFormulaCoverage(
    compiledFormulas,
    itemById,
    periods,
    periodById,
    "$.compiledFormulas",
  );
  validateCompiledFormulas(formulas, compiledFormulas);

  const selectedHistoricalPeriodIds = stringArray(
    root.selectedHistoricalPeriodIds,
    "$.selectedHistoricalPeriodIds",
  );
  validatePeriodReferences(
    selectedHistoricalPeriodIds,
    periodById,
    "$.selectedHistoricalPeriodIds",
    (period) => period.cls !== "forecast",
  );
  const statementMappingPlans = array(
    root.statementMappingPlans,
    "$.statementMappingPlans",
    (entry, path) => normalizeStatementMappingPlan(entry, path, true),
  );
  const categoryGroups = array(
    root.categoryGroups,
    "$.categoryGroups",
    normalizeDcfCategoryGroup,
  );
  const proposedStatementMappings = array(
    root.proposedStatementMappings,
    "$.proposedStatementMappings",
    (entry, path) => normalizeStatementMappingPlan(entry, path, false),
  );
  validatePlans(
    statementMappingPlans,
    proposedStatementMappings,
    categoryGroups,
    itemById,
    periodById,
  );

  const valuationConfig = normalizeValuationConfig(
    root.valuationConfig,
    "$.valuationConfig",
  );
  if (!periodById.has(valuationConfig.anchorPeriodId)) {
    throw invalid(
      "$.valuationConfig.anchorPeriodId",
      `unknown period: ${valuationConfig.anchorPeriodId}`,
    );
  }

  const cells = normalizeCells(root.cells, representation, periods, lineItems, periodById, itemById);
  const diagnostics = array(root.diagnostics, "$.diagnostics", normalizeDiagnostic);
  const mappingDiagnostics = array(
    root.mappingDiagnostics,
    "$.mappingDiagnostics",
    normalizeDiagnostic,
  );
  const reconciliationResults = array(
    root.reconciliationResults,
    "$.reconciliationResults",
    normalizeReconciliationResult,
  );
  validateReconciliationResults(reconciliationResults, itemById, periodById);
  const mappingException = root.mappingException === null
    ? null
    : normalizeMappingException(root.mappingException, "$.mappingException");
  if (mappingException !== null) {
    validateMappingException(mappingException, itemById, periodById);
  }
  const valuation = root.valuation === null
    ? null
    : normalizeValuationOutput(root.valuation, "$.valuation", itemById, periodById);

  return {
    lifecycleStage: enumValue(
      root.lifecycleStage,
      "$.lifecycleStage",
      LIFECYCLE_STAGES,
    ) as LifecycleStage,
    periods,
    lineItems,
    facts,
    factReviewDecisions,
    assumptions,
    formulas,
    compiledFormulas,
    selectedHistoricalPeriodIds,
    statementMappingPlans,
    categoryGroups,
    proposedStatementMappings,
    valuationConfig,
    cells,
    diagnostics,
    mappingDiagnostics,
    reconciliationResults,
    mappingException,
    valuation,
    engineVersion: nonemptyString(root.engineVersion, "$.engineVersion"),
  };
}

function toWireSnapshot(snapshot: FinancialModelSnapshot): PlainObject {
  return {
    lifecycleStage: snapshot.lifecycleStage,
    periods: snapshot.periods,
    lineItems: snapshot.lineItems,
    facts: snapshot.facts,
    factReviewDecisions: snapshot.factReviewDecisions,
    assumptions: snapshot.assumptions,
    formulas: snapshot.formulas,
    compiledFormulas: snapshot.compiledFormulas,
    selectedHistoricalPeriodIds: snapshot.selectedHistoricalPeriodIds,
    statementMappingPlans: snapshot.statementMappingPlans,
    categoryGroups: snapshot.categoryGroups,
    proposedStatementMappings: snapshot.proposedStatementMappings,
    valuationConfig: snapshot.valuationConfig,
    cells: [...snapshot.cells].map(([key, cellValue]) => ({ key, cell: cellValue })),
    diagnostics: snapshot.diagnostics,
    mappingDiagnostics: snapshot.mappingDiagnostics,
    reconciliationResults: snapshot.reconciliationResults,
    mappingException: snapshot.mappingException,
    valuation: snapshot.valuation,
    engineVersion: snapshot.engineVersion,
  };
}

function normalizePeriod(value: unknown, path: string): Period {
  const object = exactObject(value, path, ["id", "label", "start", "end", "cls"]);
  return {
    id: nonemptyString(object.id, `${path}.id`),
    label: stringValue(object.label, `${path}.label`),
    start: stringValue(object.start, `${path}.start`),
    end: stringValue(object.end, `${path}.end`),
    cls: enumValue(object.cls, `${path}.cls`, PERIOD_CLASSES) as PeriodClass,
  };
}

function normalizeUnit(value: unknown, path: string): Unit {
  const base = plainObject(value, path);
  const kind = stringValue(base.kind, `${path}.kind`);
  if (kind === "currency" || kind === "per_share") {
    const object = exactObject(value, path, ["kind", "code"]);
    return {
      kind,
      code: nonemptyString(object.code, `${path}.code`),
    };
  }
  if (["percent", "ratio", "shares", "number"].includes(kind)) {
    exactObject(value, path, ["kind"]);
    return { kind } as Unit;
  }
  throw invalid(`${path}.kind`, `unknown unit tag: ${kind}`);
}

function normalizeLineItem(value: unknown, path: string): LineItem {
  const object = exactObject(
    value,
    path,
    ["id", "label", "role", "unit", "section", "order", "historical", "forecast"],
    ["parentId"],
  );
  return {
    id: nonemptyString(object.id, `${path}.id`),
    label: stringValue(object.label, `${path}.label`),
    ...(hasOwn(object, "parentId")
      ? { parentId: nonemptyString(object.parentId, `${path}.parentId`) }
      : {}),
    role: enumValue(object.role, `${path}.role`, LINE_ITEM_ROLES) as LineItemRole,
    unit: normalizeUnit(object.unit, `${path}.unit`),
    section: enumValue(
      object.section,
      `${path}.section`,
      LINE_ITEM_SECTIONS,
    ) as LineItemSection,
    order: finiteNumber(object.order, `${path}.order`),
    historical: enumValue(
      object.historical,
      `${path}.historical`,
      CELL_SOURCES,
    ) as CellSource,
    forecast: enumValue(
      object.forecast,
      `${path}.forecast`,
      CELL_SOURCES,
    ) as CellSource,
  };
}

function normalizeProvenance(value: unknown, path: string): Provenance {
  const object = exactObject(
    value,
    path,
    ["sourceType", "sourceRefs", "asOfDate"],
    ["decimals", "accession", "concept", "filingUrl"],
  );
  return {
    sourceType: nonemptyString(object.sourceType, `${path}.sourceType`),
    sourceRefs: stringArray(object.sourceRefs, `${path}.sourceRefs`),
    asOfDate: nonemptyString(object.asOfDate, `${path}.asOfDate`),
    ...(hasOwn(object, "decimals")
      ? { decimals: finiteNumber(object.decimals, `${path}.decimals`) }
      : {}),
    ...(hasOwn(object, "accession")
      ? { accession: stringValue(object.accession, `${path}.accession`) }
      : {}),
    ...(hasOwn(object, "concept")
      ? { concept: stringValue(object.concept, `${path}.concept`) }
      : {}),
    ...(hasOwn(object, "filingUrl")
      ? { filingUrl: stringValue(object.filingUrl, `${path}.filingUrl`) }
      : {}),
  };
}

function normalizeFact(value: unknown, path: string): Fact {
  const object = exactObject(
    value,
    path,
    ["factId", "status", "periodId", "value", "unit", "provenance"],
    ["lineItemId", "supersedesFactId"],
  );
  return {
    factId: nonemptyString(object.factId, `${path}.factId`),
    status: enumValue(object.status, `${path}.status`, FACT_STATUSES) as FactStatus,
    ...(hasOwn(object, "lineItemId")
      ? { lineItemId: nonemptyString(object.lineItemId, `${path}.lineItemId`) }
      : {}),
    periodId: nonemptyString(object.periodId, `${path}.periodId`),
    value: finiteNumber(object.value, `${path}.value`),
    unit: normalizeUnit(object.unit, `${path}.unit`),
    provenance: normalizeProvenance(object.provenance, `${path}.provenance`),
    ...(hasOwn(object, "supersedesFactId")
      ? {
          supersedesFactId: nonemptyString(
            object.supersedesFactId,
            `${path}.supersedesFactId`,
          ),
        }
      : {}),
  };
}

function normalizeFactReviewDecision(value: unknown, path: string): FactReviewDecision {
  const object = exactObject(
    value,
    path,
    ["decisionId", "factId", "action", "rationale", "reviewedBy", "reviewedAt"],
    ["mappedLineItemId", "replacementFactId"],
  );
  return {
    decisionId: nonemptyString(object.decisionId, `${path}.decisionId`),
    factId: nonemptyString(object.factId, `${path}.factId`),
    action: enumValue(object.action, `${path}.action`, ["commit", "reject", "supersede"]),
    ...(hasOwn(object, "mappedLineItemId")
      ? {
          mappedLineItemId: nonemptyString(
            object.mappedLineItemId,
            `${path}.mappedLineItemId`,
          ),
        }
      : {}),
    ...(hasOwn(object, "replacementFactId")
      ? {
          replacementFactId: nonemptyString(
            object.replacementFactId,
            `${path}.replacementFactId`,
          ),
        }
      : {}),
    rationale: stringValue(object.rationale, `${path}.rationale`),
    reviewedBy: nonemptyString(object.reviewedBy, `${path}.reviewedBy`),
    reviewedAt: nonemptyString(object.reviewedAt, `${path}.reviewedAt`),
  };
}

function normalizeAssumptionPayload(value: unknown, path: string): AssumptionPayload {
  const object = plainObject(value, path);
  const kind = stringValue(object.kind, `${path}.kind`);
  if (kind === "values") {
    const exact = exactObject(value, path, ["kind", "values", "unit"]);
    return {
      kind,
      values: numberArray(exact.values, `${path}.values`),
      unit: normalizeUnit(exact.unit, `${path}.unit`),
    };
  }
  if (kind === "not_applicable") {
    exactObject(value, path, ["kind"]);
    return { kind };
  }
  throw invalid(`${path}.kind`, `unknown assumption payload tag: ${kind}`);
}

function normalizeAssumption(value: unknown, path: string): Assumption {
  const object = exactObject(value, path, [
    "assumptionId",
    "lineItemId",
    "periods",
    "payload",
    "sourceType",
    "sourceRefs",
    "asOfDate",
    "rationale",
  ]);
  return {
    assumptionId: nonemptyString(object.assumptionId, `${path}.assumptionId`),
    lineItemId: nonemptyString(object.lineItemId, `${path}.lineItemId`),
    periods: stringArray(object.periods, `${path}.periods`),
    payload: normalizeAssumptionPayload(object.payload, `${path}.payload`),
    sourceType: enumValue(
      object.sourceType,
      `${path}.sourceType`,
      ASSUMPTION_SOURCE_TYPES,
    ) as AssumptionSourceType,
    sourceRefs: stringArray(object.sourceRefs, `${path}.sourceRefs`),
    asOfDate: nonemptyString(object.asOfDate, `${path}.asOfDate`),
    rationale: stringValue(object.rationale, `${path}.rationale`),
  };
}

function normalizeFormula(value: unknown, path: string): Formula {
  const object = exactObject(
    value,
    path,
    ["lineItemId", "appliesTo", "source"],
    ["periodIds"],
  );
  return {
    lineItemId: nonemptyString(object.lineItemId, `${path}.lineItemId`),
    appliesTo: enumValue(
      object.appliesTo,
      `${path}.appliesTo`,
      ["historical", "forecast"],
    ),
    ...(hasOwn(object, "periodIds")
      ? { periodIds: stringArray(object.periodIds, `${path}.periodIds`) }
      : {}),
    source: nonemptyString(object.source, `${path}.source`),
  };
}

function normalizeAst(value: unknown, path: string, depth = 0): Ast {
  if (depth > 64) throw invalid(path, "AST exceeds maximum nesting depth");
  const object = plainObject(value, path);
  const tag = stringValue(object.t, `${path}.t`);
  if (tag === "num") {
    const exact = exactObject(value, path, ["t", "v"]);
    return { t: tag, v: finiteNumber(exact.v, `${path}.v`) };
  }
  if (tag === "ref") {
    const exact = exactObject(value, path, ["t", "id"]);
    return { t: tag, id: nonemptyString(exact.id, `${path}.id`) };
  }
  if (tag === "neg") {
    const exact = exactObject(value, path, ["t", "e"]);
    return { t: tag, e: normalizeAst(exact.e, `${path}.e`, depth + 1) };
  }
  if (tag === "bin") {
    const exact = exactObject(value, path, ["t", "op", "l", "r"]);
    return {
      t: tag,
      op: enumValue(exact.op, `${path}.op`, ["+", "-", "*", "/"]),
      l: normalizeAst(exact.l, `${path}.l`, depth + 1),
      r: normalizeAst(exact.r, `${path}.r`, depth + 1),
    };
  }
  if (tag === "call") {
    const exact = exactObject(value, path, ["t", "fn", "args"]);
    return {
      t: tag,
      fn: enumValue(exact.fn, `${path}.fn`, FN_NAMES) as FnName,
      args: array(exact.args, `${path}.args`, (entry, childPath) =>
        normalizeAst(entry, childPath, depth + 1)),
    };
  }
  throw invalid(`${path}.t`, `unknown AST tag: ${tag}`);
}

function normalizeCompiledFormula(value: unknown, path: string): CompiledFormula {
  const object = exactObject(
    value,
    path,
    ["lineItemId", "appliesTo", "source", "ast"],
    ["periodIds"],
  );
  const formula = normalizeFormula(
    {
      lineItemId: object.lineItemId,
      appliesTo: object.appliesTo,
      source: object.source,
      ...(hasOwn(object, "periodIds") ? { periodIds: object.periodIds } : {}),
    },
    path,
  );
  const ast = normalizeAst(object.ast, `${path}.ast`);
  return { ...formula, ast };
}

function normalizeStatementMappingPlan(
  value: unknown,
  path: string,
  reviewed: true,
): StatementMappingPlan;
function normalizeStatementMappingPlan(
  value: unknown,
  path: string,
  reviewed: false,
): Omit<StatementMappingPlan, "reviewDecisionId">;
function normalizeStatementMappingPlan(
  value: unknown,
  path: string,
  reviewed: boolean,
): StatementMappingPlan | Omit<StatementMappingPlan, "reviewDecisionId"> {
  const required = reviewed
    ? ["targetLineItemId", "periodIds", "members", "reviewDecisionId"] as const
    : ["targetLineItemId", "periodIds", "members"] as const;
  const object = exactObject(value, path, required);
  const base = {
    targetLineItemId: nonemptyString(
      object.targetLineItemId,
      `${path}.targetLineItemId`,
    ),
    periodIds: stringArray(object.periodIds, `${path}.periodIds`),
    members: array(object.members, `${path}.members`, (entry, memberPath) => {
      const member = exactObject(
        entry,
        memberPath,
        ["sourceLineItemId", "treatment"],
      );
      return {
        sourceLineItemId: nonemptyString(
          member.sourceLineItemId,
          `${memberPath}.sourceLineItemId`,
        ),
        treatment: enumValue(
          member.treatment,
          `${memberPath}.treatment`,
          ["add", "subtract", "exclude"],
        ),
      };
    }),
  };
  return reviewed
    ? {
        ...base,
        reviewDecisionId: nonemptyString(
          object.reviewDecisionId,
          `${path}.reviewDecisionId`,
        ),
      }
    : base;
}

function normalizeDcfCategoryGroup(value: unknown, path: string): DcfCategoryGroup {
  const object = exactObject(value, path, [
    "parentLineItemId",
    "category",
    "periodIds",
    "members",
    "reviewDecisionId",
  ]);
  return {
    parentLineItemId: nonemptyString(object.parentLineItemId, `${path}.parentLineItemId`),
    category: nonemptyString(object.category, `${path}.category`),
    periodIds: stringArray(object.periodIds, `${path}.periodIds`),
    members: array(object.members, `${path}.members`, (entry, memberPath) => {
      const member = exactObject(entry, memberPath, ["lineItemId", "treatment"]);
      return {
        lineItemId: nonemptyString(member.lineItemId, `${memberPath}.lineItemId`),
        treatment: enumValue(
          member.treatment,
          `${memberPath}.treatment`,
          ["add", "subtract", "exclude"],
        ),
      };
    }),
    reviewDecisionId: nonemptyString(object.reviewDecisionId, `${path}.reviewDecisionId`),
  };
}

function normalizeValuationConfig(value: unknown, path: string): ValuationConfig {
  const object = exactObject(value, path, [
    "anchorPeriodId",
    "discountConvention",
    "exitTerminalMetric",
    "sensitivity",
    "sourceType",
    "sourceRefs",
    "asOfDate",
    "rationale",
  ]);
  const sensitivity = exactObject(
    object.sensitivity,
    `${path}.sensitivity`,
    ["waccDeltas", "terminalGrowthDeltas", "exitMultipleDeltas"],
  );
  return {
    anchorPeriodId: nonemptyString(object.anchorPeriodId, `${path}.anchorPeriodId`),
    discountConvention: enumValue(
      object.discountConvention,
      `${path}.discountConvention`,
      ["year_end", "mid_year"],
    ),
    exitTerminalMetric: enumValue(
      object.exitTerminalMetric,
      `${path}.exitTerminalMetric`,
      ["ebitda", "fcff"],
    ),
    sensitivity: {
      waccDeltas: normalizedAxis(
        sensitivity.waccDeltas,
        `${path}.sensitivity.waccDeltas`,
      ),
      terminalGrowthDeltas: normalizedAxis(
        sensitivity.terminalGrowthDeltas,
        `${path}.sensitivity.terminalGrowthDeltas`,
      ),
      exitMultipleDeltas: normalizedAxis(
        sensitivity.exitMultipleDeltas,
        `${path}.sensitivity.exitMultipleDeltas`,
      ),
    },
    sourceType: enumValue(
      object.sourceType,
      `${path}.sourceType`,
      ["user", "analyst_inference"],
    ),
    sourceRefs: stringArray(object.sourceRefs, `${path}.sourceRefs`),
    asOfDate: nonemptyString(object.asOfDate, `${path}.asOfDate`),
    rationale: stringValue(object.rationale, `${path}.rationale`),
  };
}

function normalizedAxis(value: unknown, path: string): number[] {
  const values = numberArray(value, path);
  if (values.length === 0 || values.length > MAX_SENSITIVITY_AXIS_LENGTH) {
    throw invalid(
      path,
      `axis length must be between 1 and ${MAX_SENSITIVITY_AXIS_LENGTH}`,
    );
  }
  for (let index = 1; index < values.length; index += 1) {
    if (values[index - 1]! >= values[index]!) {
      throw invalid(path, "axis must be sorted and deduplicated");
    }
  }
  return values;
}

function normalizeDiagnostic(value: unknown, path: string): Diagnostic {
  const object = exactObject(value, path, ["code", "refs"]);
  return {
    code: enumValue(object.code, `${path}.code`, DIAGNOSTIC_CODES),
    refs: stringArray(object.refs, `${path}.refs`),
  };
}

function normalizeReconciliationResult(value: unknown, path: string): ReconciliationResult {
  const base = plainObject(value, path);
  const kind = enumValue(base.kind, `${path}.kind`, ["category", "accounting_identity"]);
  const sharedFields = [
    "kind", "ruleId", "periodId", "status", "required", "actual", "calculated",
    "residual", "difference", "tolerance", "refs", "parentLineItemId",
  ] as const;
  const object = kind === "category"
    ? exactObject(value, path, [...sharedFields, "category", "reviewDecisionId"])
    : exactObject(value, path, [...sharedFields, "identity"]);
  const common = {
    ruleId: nonemptyString(object.ruleId, `${path}.ruleId`),
    periodId: nonemptyString(object.periodId, `${path}.periodId`),
    status: enumValue(
      object.status,
      `${path}.status`,
      ["passed", "failed", "insufficient_data", "not_applicable"],
    ),
    required: booleanValue(object.required, `${path}.required`),
    actual: nullableFiniteNumber(object.actual, `${path}.actual`),
    calculated: nullableFiniteNumber(object.calculated, `${path}.calculated`),
    residual: nullableFiniteNumber(object.residual, `${path}.residual`),
    difference: nullableFiniteNumber(object.difference, `${path}.difference`),
    tolerance: finiteNumber(object.tolerance, `${path}.tolerance`),
    refs: stringArray(object.refs, `${path}.refs`),
    parentLineItemId: nonemptyString(object.parentLineItemId, `${path}.parentLineItemId`),
  };
  if (kind === "category") {
    return {
      kind,
      ...common,
      category: nonemptyString(object.category, `${path}.category`),
      reviewDecisionId: nonemptyString(object.reviewDecisionId, `${path}.reviewDecisionId`),
    };
  }
  return {
    kind,
    ...common,
    identity: enumValue(
      object.identity,
      `${path}.identity`,
      [
        "gross_profit", "operating_expenses_detail", "operating_income", "ebitda",
        "pretax_income", "net_income", "nopat", "operating_working_capital",
        "change_nwc", "fcff",
      ],
    ),
  };
}

function normalizeValuationDiagnostic(value: unknown, path: string): ValuationDiagnostic {
  const object = exactObject(value, path, ["code", "refs"]);
  return {
    code: enumValue(
      object.code,
      `${path}.code`,
      [...DIAGNOSTIC_CODES, "invalid_terminal_assumptions"],
    ),
    refs: stringArray(object.refs, `${path}.refs`),
  };
}

function normalizeCell(value: unknown, path: string): Cell {
  const object = exactObject(value, path, ["value", "unit", "diagnostics"]);
  return {
    value: object.value === null ? null : finiteNumber(object.value, `${path}.value`),
    unit: normalizeUnit(object.unit, `${path}.unit`),
    diagnostics: array(object.diagnostics, `${path}.diagnostics`, normalizeDiagnostic),
  };
}

function normalizeCells(
  value: unknown,
  representation: "runtime" | "wire",
  periods: readonly Period[],
  lineItems: readonly LineItem[],
  periodById: ReadonlyMap<string, Period>,
  itemById: ReadonlyMap<string, LineItem>,
): Map<CellKey, Cell> {
  let entries: WireCell[];
  if (representation === "runtime") {
    if (!(value instanceof Map) || Object.getPrototypeOf(value) !== Map.prototype) {
      throw invalid("$.cells", "expected a Map");
    }
    entries = [...value].map(([key, cellValue], index) => ({
      key: nonemptyString(key, `$.cells[${index}].key`),
      cell: normalizeCell(cellValue, `$.cells[${index}].cell`),
    }));
  } else {
    entries = array(value, "$.cells", (entry, path) => {
      const object = exactObject(entry, path, ["key", "cell"]);
      return {
        key: nonemptyString(object.key, `${path}.key`),
        cell: normalizeCell(object.cell, `${path}.cell`),
      };
    });
  }

  const seen = new Set<CellKey>();
  for (const entry of entries) {
    if (seen.has(entry.key)) throw invalid("$.cells", `duplicate cell key: ${entry.key}`);
    seen.add(entry.key);
    const { lineItemId, periodId } = splitCellKey(entry.key);
    const item = itemById.get(lineItemId);
    if (item === undefined) throw invalid("$.cells", `unknown cell line item: ${lineItemId}`);
    if (!periodById.has(periodId)) throw invalid("$.cells", `unknown cell period: ${periodId}`);
    if (!sameUnit(entry.cell.unit, item.unit)) {
      throw invalid("$.cells", `cell unit differs from row unit: ${entry.key}`);
    }
  }

  const periodPosition = new Map(periods.map((period, index) => [period.id, index]));
  const itemOrder = new Map(lineItems.map((item) => [item.id, item.order]));
  entries.sort((left, right) => {
    const leftKey = splitCellKey(left.key);
    const rightKey = splitCellKey(right.key);
    const period = periodPosition.get(leftKey.periodId)!
      - periodPosition.get(rightKey.periodId)!;
    if (period !== 0) return period;
    const order = itemOrder.get(leftKey.lineItemId)! - itemOrder.get(rightKey.lineItemId)!;
    if (order !== 0) return order;
    const lineItem = compareText(leftKey.lineItemId, rightKey.lineItemId);
    return lineItem !== 0 ? lineItem : compareText(left.key, right.key);
  });
  return new Map(entries.map((entry) => [entry.key, entry.cell]));
}

function normalizeMappingException(value: unknown, path: string): MappingException {
  const object = exactObject(
    value,
    path,
    ["reason", "sourceLineItemIds", "periodIds"],
  );
  return {
    reason: enumValue(
      object.reason,
      `${path}.reason`,
      ["unmapped", "restatement", "structure_change", "reconciliation", "low_confidence"],
    ),
    sourceLineItemIds: stringArray(
      object.sourceLineItemIds,
      `${path}.sourceLineItemIds`,
    ),
    periodIds: stringArray(object.periodIds, `${path}.periodIds`),
  };
}

function normalizeExplicitPeriodValue(
  value: unknown,
  path: string,
): ExplicitPeriodValue {
  const object = exactObject(value, path, [
    "periodId",
    "fcff",
    "wacc",
    "discountFactor",
    "presentValue",
    "refs",
  ]);
  return {
    periodId: nonemptyString(object.periodId, `${path}.periodId`),
    fcff: finiteNumber(object.fcff, `${path}.fcff`),
    wacc: finiteNumber(object.wacc, `${path}.wacc`),
    discountFactor: finiteNumber(object.discountFactor, `${path}.discountFactor`),
    presentValue: finiteNumber(object.presentValue, `${path}.presentValue`),
    refs: stringArray(object.refs, `${path}.refs`),
  };
}

function normalizeBridgeAdjustment(value: unknown, path: string): BridgeAdjustment {
  const object = exactObject(value, path, [
    "lineItemId",
    "role",
    "sign",
    "status",
    "value",
    "appliedAdjustment",
    "refs",
  ]);
  const status = enumValue(object.status, `${path}.status`, ["numeric", "not_applicable"]);
  const normalizedValue = object.value === null
    ? null
    : finiteNumber(object.value, `${path}.value`);
  if ((status === "numeric") !== (normalizedValue !== null)) {
    throw invalid(path, "bridge status and value disagree");
  }
  const sign = finiteNumber(object.sign, `${path}.sign`);
  if (sign !== 1 && sign !== -1) throw invalid(`${path}.sign`, "expected 1 or -1");
  return {
    lineItemId: nonemptyString(object.lineItemId, `${path}.lineItemId`),
    role: enumValue(object.role, `${path}.role`, LINE_ITEM_ROLES) as LineItemRole,
    sign,
    status,
    value: normalizedValue,
    appliedAdjustment: finiteNumber(
      object.appliedAdjustment,
      `${path}.appliedAdjustment`,
    ),
    refs: stringArray(object.refs, `${path}.refs`),
  };
}

function normalizeTerminalMethodResult(
  value: unknown,
  path: string,
): TerminalMethodResult {
  const object = exactObject(value, path, [
    "method",
    "explicitPeriods",
    "terminalValue",
    "terminalPresentValue",
    "terminalValuePercentOfEnterpriseValue",
    "enterpriseValue",
    "bridge",
    "equityValue",
    "dilutedShares",
    "impliedValuePerShare",
    "warnings",
    "refs",
  ]);
  return {
    method: enumValue(
      object.method,
      `${path}.method`,
      ["gordon_growth", "exit_multiple"],
    ),
    explicitPeriods: array(
      object.explicitPeriods,
      `${path}.explicitPeriods`,
      normalizeExplicitPeriodValue,
    ),
    terminalValue: finiteNumber(object.terminalValue, `${path}.terminalValue`),
    terminalPresentValue: finiteNumber(
      object.terminalPresentValue,
      `${path}.terminalPresentValue`,
    ),
    terminalValuePercentOfEnterpriseValue: finiteNumber(
      object.terminalValuePercentOfEnterpriseValue,
      `${path}.terminalValuePercentOfEnterpriseValue`,
    ),
    enterpriseValue: finiteNumber(object.enterpriseValue, `${path}.enterpriseValue`),
    bridge: array(object.bridge, `${path}.bridge`, normalizeBridgeAdjustment),
    equityValue: finiteNumber(object.equityValue, `${path}.equityValue`),
    dilutedShares: finiteNumber(object.dilutedShares, `${path}.dilutedShares`),
    impliedValuePerShare: finiteNumber(
      object.impliedValuePerShare,
      `${path}.impliedValuePerShare`,
    ),
    warnings: array(object.warnings, `${path}.warnings`, normalizeDiagnostic),
    refs: stringArray(object.refs, `${path}.refs`),
  };
}

function normalizeSensitivityCell(value: unknown, path: string): SensitivityCell {
  const object = exactObject(
    value,
    path,
    ["rowDelta", "columnDelta", "impliedValuePerShare", "diagnostics"],
  );
  return {
    rowDelta: finiteNumber(object.rowDelta, `${path}.rowDelta`),
    columnDelta: finiteNumber(object.columnDelta, `${path}.columnDelta`),
    impliedValuePerShare: object.impliedValuePerShare === null
      ? null
      : finiteNumber(object.impliedValuePerShare, `${path}.impliedValuePerShare`),
    diagnostics: array(
      object.diagnostics,
      `${path}.diagnostics`,
      normalizeValuationDiagnostic,
    ),
  };
}

function normalizeSensitivityMatrix(value: unknown, path: string): SensitivityMatrix {
  const object = exactObject(value, path, [
    "rowVariable",
    "columnVariable",
    "rowDeltas",
    "columnDeltas",
    "cells",
  ]);
  const rowDeltas = normalizedAxis(object.rowDeltas, `${path}.rowDeltas`);
  const columnDeltas = normalizedAxis(object.columnDeltas, `${path}.columnDeltas`);
  const cells = array(object.cells, `${path}.cells`, (row, rowPath) =>
    array(row, rowPath, normalizeSensitivityCell));
  if (cells.length !== rowDeltas.length
    || cells.some((row) => row.length !== columnDeltas.length)) {
    throw invalid(`${path}.cells`, "matrix dimensions do not match its axes");
  }
  cells.forEach((row, rowIndex) => row.forEach((entry, columnIndex) => {
    if (entry.rowDelta !== rowDeltas[rowIndex]
      || entry.columnDelta !== columnDeltas[columnIndex]) {
      throw invalid(`${path}.cells[${rowIndex}][${columnIndex}]`, "cell deltas do not match matrix axes");
    }
  }));
  return {
    rowVariable: enumValue(
      object.rowVariable,
      `${path}.rowVariable`,
      ["wacc_delta"],
    ),
    columnVariable: enumValue(
      object.columnVariable,
      `${path}.columnVariable`,
      ["terminal_growth_delta", "exit_multiple_delta"],
    ),
    rowDeltas,
    columnDeltas,
    cells,
  };
}

function normalizeValuationOutput(
  value: unknown,
  path: string,
  itemById: ReadonlyMap<string, LineItem>,
  periodById: ReadonlyMap<string, Period>,
): ValuationOutput {
  const object = exactObject(value, path, [
    "explicitPeriods",
    "gordonGrowth",
    "exitMultiple",
    "waccByGrowth",
    "waccByMultiple",
  ]);
  const output: ValuationOutput = {
    explicitPeriods: array(
      object.explicitPeriods,
      `${path}.explicitPeriods`,
      normalizeExplicitPeriodValue,
    ),
    gordonGrowth: normalizeTerminalMethodResult(
      object.gordonGrowth,
      `${path}.gordonGrowth`,
    ),
    exitMultiple: normalizeTerminalMethodResult(
      object.exitMultiple,
      `${path}.exitMultiple`,
    ),
    waccByGrowth: normalizeSensitivityMatrix(
      object.waccByGrowth,
      `${path}.waccByGrowth`,
    ),
    waccByMultiple: normalizeSensitivityMatrix(
      object.waccByMultiple,
      `${path}.waccByMultiple`,
    ),
  };
  if (output.gordonGrowth.method !== "gordon_growth"
    || output.exitMultiple.method !== "exit_multiple") {
    throw invalid(path, "terminal method is stored in the wrong result field");
  }
  if (output.waccByGrowth.columnVariable !== "terminal_growth_delta"
    || output.waccByMultiple.columnVariable !== "exit_multiple_delta") {
    throw invalid(path, "sensitivity matrix is stored in the wrong result field");
  }
  for (const explicit of output.explicitPeriods) {
    if (!periodById.has(explicit.periodId)) {
      throw invalid(path, `valuation references unknown period: ${explicit.periodId}`);
    }
  }
  for (const method of [output.gordonGrowth, output.exitMultiple]) {
    for (const adjustment of method.bridge) {
      const item = itemById.get(adjustment.lineItemId);
      if (item === undefined || item.role !== adjustment.role) {
        throw invalid(path, `valuation references unknown bridge row: ${adjustment.lineItemId}`);
      }
    }
  }
  return output;
}

function validateLineItemReferences(
  lineItems: readonly LineItem[],
  itemById: ReadonlyMap<string, LineItem>,
): void {
  for (const item of lineItems) {
    if (item.parentId !== undefined && !itemById.has(item.parentId)) {
      throw invalid("$.lineItems", `unknown parent line item: ${item.parentId}`);
    }
    if (item.id.includes("@")) {
      throw invalid("$.lineItems", `line-item id may not contain '@': ${item.id}`);
    }
    const sourceSection = item.section.startsWith("source_");
    if (sourceSection !== item.id.startsWith("source.")) {
      throw invalid(
        "$.lineItems",
        `source namespace and section disagree: ${item.id}`,
      );
    }
  }
}

function validateFacts(
  facts: readonly Fact[],
  factById: ReadonlyMap<string, Fact>,
  itemById: ReadonlyMap<string, LineItem>,
  periodById: ReadonlyMap<string, Period>,
): void {
  for (const fact of facts) {
    if (!periodById.has(fact.periodId)) {
      throw invalid("$.facts", `fact references unknown period: ${fact.periodId}`);
    }
    if (fact.lineItemId !== undefined) {
      const item = itemById.get(fact.lineItemId);
      if (item === undefined) {
        throw invalid("$.facts", `fact references unknown line item: ${fact.lineItemId}`);
      }
      if (!sameUnit(fact.unit, item.unit)) {
        throw invalid("$.facts", `fact unit differs from row unit: ${fact.factId}`);
      }
    } else if (fact.status !== "staged") {
      throw invalid("$.facts", `non-staged fact is not mapped: ${fact.factId}`);
    }
    if (fact.supersedesFactId !== undefined
      && !factById.has(fact.supersedesFactId)) {
      throw invalid(
        "$.facts",
        `fact supersedes an unknown fact: ${fact.supersedesFactId}`,
      );
    }
  }
}

function validateFactReviewDecisions(
  decisions: readonly FactReviewDecision[],
  factById: ReadonlyMap<string, Fact>,
  itemById: ReadonlyMap<string, LineItem>,
): void {
  uniqueBy(decisions, (decision) => decision.decisionId, "$.factReviewDecisions", "decision id");
  for (const decision of decisions) {
    if (!factById.has(decision.factId)) {
      throw invalid(
        "$.factReviewDecisions",
        `decision references unknown fact: ${decision.factId}`,
      );
    }
    if (decision.mappedLineItemId !== undefined
      && !itemById.has(decision.mappedLineItemId)) {
      throw invalid(
        "$.factReviewDecisions",
        `decision references unknown row: ${decision.mappedLineItemId}`,
      );
    }
    if (decision.replacementFactId !== undefined
      && !factById.has(decision.replacementFactId)) {
      throw invalid(
        "$.factReviewDecisions",
        `decision references unknown replacement: ${decision.replacementFactId}`,
      );
    }
    if (decision.action === "commit" && decision.mappedLineItemId === undefined) {
      throw invalid("$.factReviewDecisions", "commit decision is missing mappedLineItemId");
    }
    if (decision.action === "supersede" && decision.replacementFactId === undefined) {
      throw invalid("$.factReviewDecisions", "supersede decision is missing replacementFactId");
    }
  }
}

function validateAssumptions(
  assumptions: readonly Assumption[],
  itemById: ReadonlyMap<string, LineItem>,
  periodById: ReadonlyMap<string, Period>,
): void {
  uniqueBy(assumptions, (assumption) => assumption.assumptionId, "$.assumptions", "assumption id");
  const coverage = new Set<string>();
  for (const assumption of assumptions) {
    const item = itemById.get(assumption.lineItemId);
    if (item === undefined) {
      throw invalid("$.assumptions", `unknown assumption row: ${assumption.lineItemId}`);
    }
    validatePeriodReferences(
      assumption.periods,
      periodById,
      `$.assumptions.${assumption.assumptionId}.periods`,
    );
    if (assumption.periods.length === 0) {
      throw invalid("$.assumptions", `assumption has empty coverage: ${assumption.assumptionId}`);
    }
    if (assumption.payload.kind === "values") {
      if (assumption.payload.values.length !== 1
        && assumption.payload.values.length !== assumption.periods.length) {
        throw invalid(
          "$.assumptions",
          `assumption values do not match coverage: ${assumption.assumptionId}`,
        );
      }
      if (!sameUnit(assumption.payload.unit, item.unit)) {
        throw invalid("$.assumptions", `assumption unit differs from row unit: ${assumption.assumptionId}`);
      }
    }
    for (const periodId of assumption.periods) {
      const key = `${assumption.lineItemId}\u0000${periodId}`;
      if (coverage.has(key)) {
        throw invalid("$.assumptions", `overlapping assumption coverage: ${assumption.lineItemId}@${periodId}`);
      }
      coverage.add(key);
    }
  }
}

function validateFormulaCoverage(
  formulas: readonly Formula[],
  itemById: ReadonlyMap<string, LineItem>,
  periods: readonly Period[],
  periodById: ReadonlyMap<string, Period>,
  path: string,
): void {
  const coverage = new Set<string>();
  for (const formula of formulas) {
    if (!itemById.has(formula.lineItemId)) {
      throw invalid(path, `formula references unknown row: ${formula.lineItemId}`);
    }
    const periodIds = formula.periodIds === undefined
      ? periods
          .filter((period) =>
            formula.appliesTo === "forecast"
              ? period.cls === "forecast"
              : period.cls !== "forecast")
          .map((period) => period.id)
      : [...formula.periodIds];
    validatePeriodReferences(
      periodIds,
      periodById,
      path,
      (period) =>
        formula.appliesTo === "forecast"
          ? period.cls === "forecast"
          : period.cls !== "forecast",
    );
    for (const periodId of periodIds) {
      const key = `${formula.lineItemId}\u0000${periodId}`;
      if (coverage.has(key)) {
        throw invalid(path, `overlapping formula coverage: ${formula.lineItemId}@${periodId}`);
      }
      coverage.add(key);
    }
  }
}

function validateCompiledFormulas(
  formulas: readonly Formula[],
  compiled: readonly CompiledFormula[],
): void {
  const definitions = new Map<string, number>();
  for (const formula of formulas) {
    const key = formulaIdentity(formula);
    definitions.set(key, (definitions.get(key) ?? 0) + 1);
  }
  for (const formula of compiled) {
    const key = formulaIdentity(formula);
    const count = definitions.get(key) ?? 0;
    if (count === 0) {
      throw invalid("$.compiledFormulas", "compiled formula has no active definition");
    }
    definitions.set(key, count - 1);
    const parsed = parseFormula(formula.source);
    if (JSON.stringify(parsed) !== JSON.stringify(formula.ast)) {
      throw invalid("$.compiledFormulas", `stored AST differs from source: ${formula.lineItemId}`);
    }
  }
  if ([...definitions.values()].some((count) => count !== 0)) {
    throw invalid("$.compiledFormulas", "an active formula has no compiled AST");
  }
}

function formulaIdentity(formula: Formula): string {
  return JSON.stringify([
    formula.lineItemId,
    formula.appliesTo,
    formula.periodIds ?? null,
    formula.source,
  ]);
}

function validatePlans(
  statements: readonly StatementMappingPlan[],
  proposed: readonly Omit<StatementMappingPlan, "reviewDecisionId">[],
  categoryGroups: readonly DcfCategoryGroup[],
  itemById: ReadonlyMap<string, LineItem>,
  periodById: ReadonlyMap<string, Period>,
): void {
  const statementCoverage = new Set<string>();
  for (const [index, plan] of statements.entries()) {
    validateStatementPlan(plan, `$.statementMappingPlans[${index}]`, itemById, periodById);
    for (const periodId of plan.periodIds) {
      const key = `${plan.targetLineItemId}\u0000${periodId}`;
      if (statementCoverage.has(key)) throw invalid("$.statementMappingPlans", `overlapping plan coverage: ${key}`);
      statementCoverage.add(key);
    }
  }
  for (const [index, plan] of proposed.entries()) {
    validateStatementPlan(plan, `$.proposedStatementMappings[${index}]`, itemById, periodById);
  }
  const categoryCoverage = new Set<string>();
  const categoryForecastOwners = new Set<string>();
  for (const [index, group] of categoryGroups.entries()) {
    const path = `$.categoryGroups[${index}]`;
    const parent = requireItem(group.parentLineItemId, itemById, `${path}.parentLineItemId`);
    if (parent.section.startsWith("source_")) throw invalid(path, "category parent is a source row");
    validatePeriodReferences(group.periodIds, periodById, `${path}.periodIds`);
    uniqueStrings(group.members.map((member) => member.lineItemId), `${path}.members`);
    if (!group.members.some((member) => member.treatment !== "exclude")) {
      throw invalid(path, "category group has no included members");
    }
    for (const member of group.members) {
      const item = requireItem(member.lineItemId, itemById, `${path}.members`);
      if (item.section.startsWith("source_") || item.id === parent.id || !sameUnit(item.unit, parent.unit)) {
        throw invalid(path, `invalid category member: ${item.id}`);
      }
    }
    for (const periodId of group.periodIds) {
      const businessKey = `${group.parentLineItemId}\u0000${group.category}\u0000${periodId}`;
      if (categoryCoverage.has(businessKey)) throw invalid(path, `overlapping category coverage: ${businessKey}`);
      categoryCoverage.add(businessKey);
      if (periodById.get(periodId)?.cls === "forecast") {
        const owner = `${group.parentLineItemId}\u0000${periodId}`;
        if (categoryForecastOwners.has(owner)) throw invalid(path, `ambiguous forecast category: ${owner}`);
        categoryForecastOwners.add(owner);
      }
    }
  }
}

function validateStatementPlan(
  plan: Omit<StatementMappingPlan, "reviewDecisionId">,
  path: string,
  itemById: ReadonlyMap<string, LineItem>,
  periodById: ReadonlyMap<string, Period>,
): void {
  requireItem(plan.targetLineItemId, itemById, `${path}.targetLineItemId`);
  validatePeriodReferences(
    plan.periodIds,
    periodById,
    `${path}.periodIds`,
    (period) => period.cls === "actual",
  );
  uniqueStrings(plan.members.map((member) => member.sourceLineItemId), `${path}.members`);
  for (const member of plan.members) {
    const item = requireItem(member.sourceLineItemId, itemById, `${path}.members`);
    if (!item.section.startsWith("source_")) {
      throw invalid(path, `statement member is not a source row: ${item.id}`);
    }
  }
}

function validateMappingException(
  exception: MappingException,
  itemById: ReadonlyMap<string, LineItem>,
  periodById: ReadonlyMap<string, Period>,
): void {
  validatePeriodReferences(exception.periodIds, periodById, "$.mappingException.periodIds");
  uniqueStrings(exception.sourceLineItemIds, "$.mappingException.sourceLineItemIds");
  for (const id of exception.sourceLineItemIds) {
    const item = requireItem(id, itemById, "$.mappingException.sourceLineItemIds");
    if (!item.section.startsWith("source_")) {
      throw invalid("$.mappingException", `mapping exception row is not a source row: ${id}`);
    }
  }
}

function validateReconciliationResults(
  results: readonly ReconciliationResult[],
  itemById: ReadonlyMap<string, LineItem>,
  periodById: ReadonlyMap<string, Period>,
): void {
  const seen = new Set<string>();
  for (const [index, result] of results.entries()) {
    const path = `$.reconciliationResults[${index}]`;
    requireItem(result.parentLineItemId, itemById, `${path}.parentLineItemId`);
    if (!periodById.has(result.periodId)) throw invalid(path, `unknown period: ${result.periodId}`);
    const identity = `${result.ruleId}\u0000${result.periodId}`;
    if (seen.has(identity)) throw invalid(path, `duplicate reconciliation result: ${identity}`);
    seen.add(identity);
    if (result.tolerance < 0) throw invalid(path, "reconciliation tolerance must be non-negative");
    uniqueStrings(result.refs, `${path}.refs`);
    for (const ref of result.refs) {
      let coordinate: ReturnType<typeof splitCellKey>;
      try {
        coordinate = splitCellKey(ref as CellKey);
      } catch {
        throw invalid(path, `invalid reconciliation cell reference: ${ref}`);
      }
      requireItem(coordinate.lineItemId, itemById, `${path}.refs`);
      if (!periodById.has(coordinate.periodId)) throw invalid(path, `unknown reconciliation period: ${coordinate.periodId}`);
    }
    const complete = result.actual !== null && result.calculated !== null
      && result.residual !== null && result.difference !== null;
    if ((result.status === "passed" || result.status === "failed") !== complete) {
      throw invalid(path, "reconciliation status and values disagree");
    }
    if (result.residual !== result.difference) {
      throw invalid(path, "reconciliation residual and difference disagree");
    }
  }
}

function validatePeriodReferences(
  ids: readonly string[],
  periodById: ReadonlyMap<string, Period>,
  path: string,
  permitted: (period: Period) => boolean = () => true,
): void {
  uniqueStrings(ids, path);
  for (const id of ids) {
    const period = periodById.get(id);
    if (period === undefined) throw invalid(path, `unknown period: ${id}`);
    if (!permitted(period)) throw invalid(path, `period has an incompatible class: ${id}`);
  }
}

function requireItem(
  id: string,
  itemById: ReadonlyMap<string, LineItem>,
  path: string,
): LineItem {
  const item = itemById.get(id);
  if (item === undefined) throw invalid(path, `unknown line item: ${id}`);
  return item;
}

function uniqueStrings(values: readonly string[], path: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw invalid(path, `duplicate value: ${value}`);
    seen.add(value);
  }
}

function uniqueBy<T>(
  values: readonly T[],
  keyOf: (value: T) => string,
  path: string,
  label: string,
): Map<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    const key = keyOf(value);
    if (result.has(key)) throw invalid(path, `duplicate ${label}: ${key}`);
    result.set(key, value);
  }
  return result;
}

function exactObject(
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): PlainObject {
  const object = plainObject(value, path);
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!hasOwn(object, key)) throw invalid(path, `missing field: ${key}`);
  }
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) throw invalid(path, `unknown field: ${key}`);
  }
  return object;
}

function plainObject(value: unknown, path: string): PlainObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    throw invalid(path, "expected a plain object");
  }
  return value as PlainObject;
}

function array<T>(
  value: unknown,
  path: string,
  normalize: (entry: unknown, path: string) => T,
): T[] {
  if (!Array.isArray(value)) throw invalid(path, "expected an array");
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw invalid(path, "expected a plain array");
  }
  return value.map((entry, index) => normalize(entry, `${path}[${index}]`));
}

function stringArray(value: unknown, path: string): string[] {
  return array(value, path, (entry, childPath) => stringValue(entry, childPath));
}

function numberArray(value: unknown, path: string): number[] {
  return array(value, path, (entry, childPath) => finiteNumber(entry, childPath));
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== "string") throw invalid(path, "expected a string");
  return value;
}

function nonemptyString(value: unknown, path: string): string {
  const result = stringValue(value, path);
  if (result.length === 0) throw invalid(path, "expected a non-empty string");
  return result;
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw invalid(path, "expected a finite number");
  }
  return Object.is(value, -0) ? 0 : value;
}

function nullableFiniteNumber(value: unknown, path: string): number | null {
  return value === null ? null : finiteNumber(value, path);
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw invalid(path, "expected a boolean");
  return value;
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  path: string,
  values: T,
): T[number] {
  const text = stringValue(value, path);
  if (!(values as readonly string[]).includes(text)) {
    throw invalid(path, `unknown union tag: ${text}`);
  }
  return text as T[number];
}

function hasOwn(object: PlainObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalid(path: string, message: string, cause?: unknown): FinancialModelError {
  return new FinancialModelError(
    "invalid_snapshot",
    `${message} at ${path}`,
    cause === undefined ? { path } : { path, cause: String(cause) },
  );
}

function wrapInvalidSnapshot<T>(message: string, action: () => T): T {
  try {
    return action();
  } catch (error: unknown) {
    if (error instanceof FinancialModelError && error.code === "invalid_snapshot") {
      throw error;
    }
    throw new FinancialModelError("invalid_snapshot", message, {
      cause: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    });
  }
}
