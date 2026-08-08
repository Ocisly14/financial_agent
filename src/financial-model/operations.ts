import { FinancialModelError } from "./errors.ts";
import { applyFactReview, stageFacts } from "./factLifecycle.ts";
import { installRegisteredMetric, type MetricRequest } from "./metrics.ts";
import {
  addDcfDetailLineItem,
  addRevenueStream,
  applyDcfCategoryGroups,
  applyStatementMappingPlans,
  type Skeleton,
} from "./skeleton.ts";
import { validateValuationConfig, type ValuationOutput } from "./valuation.ts";
import type { CellKey } from "./dsl/graph.ts";
import type { Ast } from "./dsl/parser.ts";
import { compatibleUnit } from "./dsl/units.ts";
import type { Formula } from "./engine.ts";
import type {
  Assumption,
  Cell,
  DcfCategoryGroup,
  Diagnostic,
  Fact,
  FactReviewDecision,
  LifecycleStage,
  LineItem,
  LineItemRole,
  LineItemSection,
  Period,
  PeriodClass,
  ReconciliationResult,
  StatementMappingPlan,
  Unit,
  ValuationConfig,
} from "./types.ts";

export type ModelSelector = {
  cellRefs?: Array<{ lineItemId: string; periodId: string }>;
  lineItemIds?: string[];
  periodIds?: string[];
  parentId?: string;
  section?: LineItemSection;
  role?: LineItemRole;
  periodClass?: PeriodClass;
};

export type ModelQuery = {
  kind: "read_cells";
  revision?: number;
  selector: ModelSelector;
  includeLineage?: boolean;
};

export type NewExtensibleLineItem = {
  id: string;
  label: string;
  parentId:
    | "revenue"
    | "cost_of_revenue"
    | "operating_expenses"
    | "total_current_assets"
    | "total_current_liabilities"
    | "operating_working_capital"
    | "custom_metrics";
  unit?: Unit;
  description?: string;
};

export type ModelOperation =
  | {
      kind: "replace_fact";
      replacement: Fact;
      commitDecision: FactReviewDecision;
      supersedeDecision: FactReviewDecision;
    }
  | { kind: "set_assumption"; assumption: Assumption }
  | ({ kind: "set_line_item_source"; lineItemId: string } & (
      | { range: "historical"; source: "actual" | "assumption" | "formula" | "none" }
      | { range: "forecast"; source: "assumption" | "formula" | "none" }
    ))
  | { kind: "add_line_item"; lineItem: NewExtensibleLineItem }
  | { kind: "add_metric"; metric: MetricRequest }
  | { kind: "set_formula"; formula: Formula }
  | { kind: "set_statement_mapping_plan"; plan: StatementMappingPlan }
  | { kind: "set_category_group"; group: DcfCategoryGroup }
  | { kind: "set_valuation_config"; config: ValuationConfig }
  | {
      kind: "advance_stage";
      stage: "history_committed" | "revenue_forecast" | "operations_fcff" | "valued";
    };

export type CompiledFormula = Formula & { ast: Ast };

export type MappingException = {
  reason: "unmapped" | "restatement" | "structure_change" | "reconciliation" | "low_confidence";
  sourceLineItemIds: string[];
  periodIds: string[];
};

export type FinancialModelSnapshot = {
  /** Immutable revision link; insight bodies are stored outside this snapshot. */
  filingInsightSetId?: string | null;
  lifecycleStage: LifecycleStage;
  periods: Period[];
  lineItems: LineItem[];
  facts: Fact[];
  factReviewDecisions: FactReviewDecision[];
  assumptions: Assumption[];
  formulas: Formula[];
  compiledFormulas: CompiledFormula[];
  selectedHistoricalPeriodIds: string[];
  statementMappingPlans: StatementMappingPlan[];
  categoryGroups: DcfCategoryGroup[];
  proposedStatementMappings: Array<Omit<StatementMappingPlan, "reviewDecisionId">>;
  valuationConfig: ValuationConfig;
  cells: Map<CellKey, Cell>;
  diagnostics: Diagnostic[];
  mappingDiagnostics: Diagnostic[];
  reconciliationResults: ReconciliationResult[];
  mappingException: MappingException | null;
  valuation: ValuationOutput | null;
  engineVersion: string;
};

const REGISTRY_DRIVER_IDS = new Set([
  "growth.revenue.total",
  "margin.operating",
  "tax_rate",
  "ratio.da_to_revenue",
  "ratio.capex_to_revenue",
  "ratio.operating_nwc_to_revenue",
]);

const STAGE_ORDER: readonly LifecycleStage[] = [
  "draft", "history_committed", "revenue_forecast", "operations_fcff", "valued", "archived",
];

function operationError(message: string): never {
  throw new FinancialModelError("invalid_model_operation", message);
}

function cloneSnapshot(snapshot: FinancialModelSnapshot): FinancialModelSnapshot {
  return structuredClone(snapshot);
}

function lineItem(snapshot: FinancialModelSnapshot, id: string): LineItem {
  const item = snapshot.lineItems.find((candidate) => candidate.id === id);
  if (!item) operationError(`unknown line item: ${id}`);
  return item;
}

function period(snapshot: FinancialModelSnapshot, id: string): Period {
  const found = snapshot.periods.find((candidate) => candidate.id === id);
  if (!found) operationError(`unknown period: ${id}`);
  return found;
}

function rangeOf(periodValue: Period): "historical" | "forecast" {
  return periodValue.cls === "forecast" ? "forecast" : "historical";
}

function periodIdsForRange(
  snapshot: FinancialModelSnapshot,
  range: "historical" | "forecast",
): string[] {
  return snapshot.periods
    .filter((candidate) => rangeOf(candidate) === range)
    .map((candidate) => candidate.id);
}

function coverageOf(snapshot: FinancialModelSnapshot, formula: Formula): string[] {
  return formula.periodIds === undefined
    ? periodIdsForRange(snapshot, formula.appliesTo)
    : [...formula.periodIds];
}

function assertMutableDefinition(item: LineItem): void {
  // metric.custom.* is agent-owned: no engine identity or default chain reads it, so redefining it
  // can only affect chains the agent built itself. Registry metrics and the fixed drivers stay locked.
  if ((item.section === "metrics" && !item.id.startsWith("metric.custom.")) || REGISTRY_DRIVER_IDS.has(item.id)) {
    operationError(`registry-owned definition is immutable: ${item.id}`);
  }
  if (item.historical === "calculated" || item.forecast === "calculated") {
    operationError(`engine-native row is immutable: ${item.id}`);
  }
}

function subtractFormulaCoverage(
  snapshot: FinancialModelSnapshot,
  target: Formula,
): Formula[] {
  const replacement = new Set(coverageOf(snapshot, target));
  return snapshot.formulas.flatMap((existing) => {
    if (existing.lineItemId !== target.lineItemId || existing.appliesTo !== target.appliesTo) {
      return [existing];
    }
    const remaining = coverageOf(snapshot, existing).filter((id) => !replacement.has(id));
    return remaining.length === 0 ? [] : [{ ...existing, periodIds: remaining }];
  });
}

function assumptionValueAt(assumption: Assumption, index: number): number | undefined {
  if (assumption.payload.kind !== "values") return undefined;
  return assumption.payload.values.length === 1
    ? assumption.payload.values[0]
    : assumption.payload.values[index];
}

function subtractAssumptionCoverage(
  assumptions: readonly Assumption[],
  lineItemId: string,
  periodIds: ReadonlySet<string>,
  replacementId: string,
): Assumption[] {
  return assumptions.flatMap((existing) => {
    if (existing.assumptionId === replacementId) return [];
    if (existing.lineItemId !== lineItemId) return [existing];
    const retainedIndexes = existing.periods
      .map((id, index) => ({ id, index }))
      .filter(({ id }) => !periodIds.has(id));
    if (retainedIndexes.length === 0) return [];
    if (retainedIndexes.length === existing.periods.length) return [existing];
    if (existing.payload.kind === "not_applicable") {
      return [{ ...existing, periods: retainedIndexes.map(({ id }) => id) }];
    }
    const values = existing.payload.values.length === 1
      ? [...existing.payload.values]
      : retainedIndexes.map(({ index }) => assumptionValueAt(existing, index)!);
    return [{
      ...existing,
      periods: retainedIndexes.map(({ id }) => id),
      payload: { ...existing.payload, values },
    }];
  });
}

function validateAssumption(snapshot: FinancialModelSnapshot, assumption: Assumption): void {
  if (assumption.assumptionId.trim().length === 0) operationError("assumptionId must not be empty");
  const item = lineItem(snapshot, assumption.lineItemId);
  if (assumption.periods.length === 0) operationError("assumption periods must not be empty");
  const seen = new Set<string>();
  for (const periodId of assumption.periods) {
    if (seen.has(periodId)) operationError(`duplicate assumption period: ${periodId}`);
    const candidate = period(snapshot, periodId);
    const source = candidate.cls === "forecast" ? item.forecast : item.historical;
    const optionalBridgeNarrowing = assumption.payload.kind === "not_applicable"
      && candidate.cls !== "forecast"
      && isOptionalBridgeRole(item.role);
    if (source !== "assumption" && !optionalBridgeNarrowing) {
      operationError(`line item ${item.id} is not assumption-sourced for ${periodId}`);
    }
    seen.add(periodId);
  }
  if (assumption.payload.kind === "values") {
    if (assumption.payload.values.length !== 1
      && assumption.payload.values.length !== assumption.periods.length) {
      operationError(`assumption ${assumption.assumptionId} has incompatible value coverage`);
    }
    if (!compatibleUnit(assumption.payload.unit, item.unit)) {
      operationError(`assumption ${assumption.assumptionId} has incompatible units`);
    }
    if (assumption.payload.values.some((value) => !Number.isFinite(value))) {
      operationError(`assumption ${assumption.assumptionId} contains a non-finite value`);
    }
  }
  if (assumption.sourceRefs.length === 0
    || assumption.rationale.trim().length === 0
    || !/^\d{4}-\d{2}-\d{2}$/.test(assumption.asOfDate)) {
    operationError(`assumption ${assumption.assumptionId} requires source metadata`);
  }
}

function isOptionalBridgeRole(role: LineItemRole): boolean {
  return role === "cash_available_for_bridge"
    || role === "non_operating_investments"
    || role === "debt"
    || role === "lease_liabilities"
    || role === "preferred_equity"
    || role === "non_controlling_interests"
    || role === "bridge_other";
}

function validateFormula(snapshot: FinancialModelSnapshot, formula: Formula): void {
  const item = lineItem(snapshot, formula.lineItemId);
  assertMutableDefinition(item);
  if (formula.source.trim().length === 0) operationError("formula source must not be empty");
  if (formula.periodIds === undefined || formula.periodIds.length === 0) {
    operationError("set_formula requires explicit periodIds");
  }
  const seen = new Set<string>();
  for (const periodId of formula.periodIds) {
    if (seen.has(periodId)) operationError(`duplicate formula period: ${periodId}`);
    const candidate = period(snapshot, periodId);
    if (rangeOf(candidate) !== formula.appliesTo) {
      operationError(`formula period ${periodId} is outside ${formula.appliesTo}`);
    }
    const source = formula.appliesTo === "forecast" ? item.forecast : item.historical;
    if (source !== "formula") operationError(`line item ${item.id} is not formula-sourced`);
    seen.add(periodId);
  }
}

function skeletonOf(snapshot: FinancialModelSnapshot): Skeleton {
  return {
    periods: snapshot.periods,
    lineItems: snapshot.lineItems,
    formulas: snapshot.formulas,
  };
}

function acceptSkeleton(snapshot: FinancialModelSnapshot, skeleton: Skeleton): void {
  snapshot.periods = skeleton.periods;
  snapshot.lineItems = skeleton.lineItems;
  snapshot.formulas = skeleton.formulas;
}

function replacePlan<T extends { periodIds: string[] }>(
  existing: readonly T[],
  incoming: T,
  sameTarget: (left: T, right: T) => boolean,
): T[] {
  const incomingPeriods = new Set(incoming.periodIds);
  const retained: T[] = [];
  for (const plan of existing) {
    if (!sameTarget(plan, incoming)) {
      retained.push(plan);
      continue;
    }
    const overlap = plan.periodIds.filter((id) => incomingPeriods.has(id));
    if (overlap.length === 0) {
      retained.push(plan);
      continue;
    }
    const exact = plan.periodIds.length === incoming.periodIds.length
      && plan.periodIds.every((id) => incomingPeriods.has(id));
    if (!exact) operationError(`plan coverage partially overlaps: ${overlap.join(", ")}`);
  }
  return [...retained, structuredClone(incoming)];
}

function addExtensibleLineItem(snapshot: FinancialModelSnapshot, input: NewExtensibleLineItem): void {
  if (input.parentId === "revenue") {
    const slug = input.id.startsWith("revenue.") ? input.id.slice("revenue.".length) : input.id;
    if (!/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(slug)) {
      operationError(`invalid revenue stream slug: ${slug}`);
    }
    acceptSkeleton(snapshot, addRevenueStream(skeletonOf(snapshot), { id: slug, label: input.label }));
    return;
  }
  if (input.parentId !== "custom_metrics") {
    acceptSkeleton(snapshot, addDcfDetailLineItem(skeletonOf(snapshot), {
      parentLineItemId: input.parentId,
      id: input.id,
      label: input.label,
    }));
    return;
  }
  if (!/^metric\.custom\.[a-z][a-z0-9_.]*$/.test(input.id)) {
    operationError(`custom metric id must use metric.custom.*: ${input.id}`);
  }
  if (input.unit === undefined) operationError("custom metric requires a declared unit");
  if (snapshot.lineItems.some((item) => item.id === input.id)) operationError(`line item already exists: ${input.id}`);
  const order = Math.max(699, ...snapshot.lineItems.map((item) => item.order)) + 1;
  snapshot.lineItems.push({
    id: input.id,
    label: input.label,
    role: "none",
    unit: structuredClone(input.unit),
    section: "metrics",
    order,
    historical: "formula",
    forecast: "none",
    ...(input.description !== undefined ? { description: input.description } : {}),
  });
}

function replaceCategoryGroup(
  snapshot: FinancialModelSnapshot,
  incoming: DcfCategoryGroup,
): DcfCategoryGroup[] {
  const incomingPeriods = new Set(incoming.periodIds);
  const retained: DcfCategoryGroup[] = [];
  for (const group of snapshot.categoryGroups) {
    if (group.parentLineItemId !== incoming.parentLineItemId || group.category !== incoming.category) {
      retained.push(group);
      continue;
    }
    const overlap = group.periodIds.filter((periodId) => incomingPeriods.has(periodId));
    if (overlap.length === 0) {
      retained.push(group);
      continue;
    }
    const exact = group.periodIds.length === incoming.periodIds.length
      && group.periodIds.every((periodId) => incomingPeriods.has(periodId));
    if (!exact) operationError(`category group coverage partially overlaps: ${overlap.join(", ")}`);
  }

  const candidate = [...retained, structuredClone(incoming)];
  const forecastIds = new Set(snapshot.periods
    .filter((period) => period.cls === "forecast")
    .map((period) => period.id));
  const forecastOwners = new Set<string>();
  for (const group of candidate) {
    for (const periodId of group.periodIds) {
      if (!forecastIds.has(periodId)) continue;
      const key = `${group.parentLineItemId}\u0000${periodId}`;
      if (forecastOwners.has(key)) {
        operationError(`ambiguous forecast category group: ${group.parentLineItemId}@${periodId}`);
      }
      forecastOwners.add(key);
    }
  }
  const periodPosition = new Map(snapshot.periods.map((period, index) => [period.id, index]));
  return candidate.sort((left, right) => {
    const first = (group: DcfCategoryGroup): number => group.periodIds.reduce(
      (result, periodId) => Math.min(result, periodPosition.get(periodId) ?? Number.MAX_SAFE_INTEGER),
      Number.MAX_SAFE_INTEGER,
    );
    return first(left) - first(right)
      || (left.parentLineItemId < right.parentLineItemId ? -1 : left.parentLineItemId > right.parentLineItemId ? 1 : 0)
      || (left.category < right.category ? -1 : left.category > right.category ? 1 : 0);
  });
}

function normalizeCategoryGroup(
  snapshot: FinancialModelSnapshot,
  group: DcfCategoryGroup,
): DcfCategoryGroup {
  const periodPosition = new Map(snapshot.periods.map((period, index) => [period.id, index]));
  return {
    ...structuredClone(group),
    periodIds: [...group.periodIds].sort((left, right) =>
      (periodPosition.get(left) ?? Number.MAX_SAFE_INTEGER)
      - (periodPosition.get(right) ?? Number.MAX_SAFE_INTEGER)),
  };
}

function setSource(
  snapshot: FinancialModelSnapshot,
  operation: Extract<ModelOperation, { kind: "set_line_item_source" }>,
): void {
  const item = lineItem(snapshot, operation.lineItemId);
  assertMutableDefinition(item);
  snapshot.lineItems = snapshot.lineItems.map((candidate) => candidate.id === item.id
    ? { ...candidate, [operation.range]: operation.source }
    : candidate);
  snapshot.formulas = snapshot.formulas.filter((formula) =>
    formula.lineItemId !== item.id || formula.appliesTo !== operation.range);
  const rangePeriods = new Set(periodIdsForRange(snapshot, operation.range));
  snapshot.assumptions = snapshot.assumptions.filter((assumption) =>
    assumption.lineItemId !== item.id || !assumption.periods.some((id) => rangePeriods.has(id)));
}

function validateFinalCoverage(snapshot: FinancialModelSnapshot): void {
  const formulaCells = new Set<string>();
  for (const formula of snapshot.formulas) {
    for (const periodId of coverageOf(snapshot, formula)) {
      const key = `${formula.lineItemId}\u0000${periodId}`;
      if (formulaCells.has(key)) operationError(`overlapping formula coverage for ${formula.lineItemId}@${periodId}`);
      formulaCells.add(key);
    }
  }
  const assumptionIds = new Set<string>();
  const assumptionCells = new Set<string>();
  for (const assumption of snapshot.assumptions) {
    if (assumptionIds.has(assumption.assumptionId)) operationError(`duplicate assumption id: ${assumption.assumptionId}`);
    assumptionIds.add(assumption.assumptionId);
    for (const periodId of assumption.periods) {
      const key = `${assumption.lineItemId}\u0000${periodId}`;
      if (assumptionCells.has(key)) operationError(`overlapping assumptions for ${assumption.lineItemId}@${periodId}`);
      assumptionCells.add(key);
    }
  }
}

export function applyModelOperations(
  snapshot: FinancialModelSnapshot,
  operations: readonly ModelOperation[],
): FinancialModelSnapshot {
  if (operations.length === 0) operationError("operation batch must not be empty");
  if (snapshot.lifecycleStage === "archived") operationError("archived models are immutable");
  const next = cloneSnapshot(snapshot);

  for (const operation of operations) {
    switch (operation.kind) {
      case "replace_fact": {
        const decisionIds = new Set(next.factReviewDecisions.map((decision) => decision.decisionId));
        if (decisionIds.has(operation.commitDecision.decisionId)
          || decisionIds.has(operation.supersedeDecision.decisionId)) {
          operationError("fact replacement decision id already exists");
        }
        // The review clock belongs to the host: a caller-supplied reviewedAt is an assertion the
        // ledger cannot check, and an agent asked for one simply invents it.
        const reviewedAt = new Date().toISOString();
        const decisions = [operation.commitDecision, operation.supersedeDecision]
          .map((decision) => ({ ...structuredClone(decision), reviewedAt }));
        const staged = stageFacts(next.facts, [operation.replacement]);
        next.facts = applyFactReview(staged, decisions);
        next.factReviewDecisions.push(...decisions);
        break;
      }
      case "set_assumption": {
        validateAssumption(next, operation.assumption);
        const replacementIndex = next.assumptions.findIndex(
          (assumption) => assumption.assumptionId === operation.assumption.assumptionId,
        );
        const coverage = new Set(operation.assumption.periods);
        next.assumptions = subtractAssumptionCoverage(
          next.assumptions,
          operation.assumption.lineItemId,
          coverage,
          operation.assumption.assumptionId,
        );
        next.assumptions.splice(
          replacementIndex < 0 ? next.assumptions.length : Math.min(replacementIndex, next.assumptions.length),
          0,
          structuredClone(operation.assumption),
        );
        break;
      }
      case "set_line_item_source":
        setSource(next, operation);
        break;
      case "add_line_item":
        addExtensibleLineItem(next, operation.lineItem);
        break;
      case "add_metric":
        acceptSkeleton(next, installRegisteredMetric(skeletonOf(next), next.periods, operation.metric));
        break;
      case "set_formula":
        validateFormula(next, operation.formula);
        next.formulas = subtractFormulaCoverage(next, operation.formula);
        next.formulas.push(structuredClone(operation.formula));
        break;
      case "set_statement_mapping_plan": {
        const compiled = applyStatementMappingPlans(skeletonOf(next), [operation.plan]);
        acceptSkeleton(next, compiled);
        next.statementMappingPlans = replacePlan(
          next.statementMappingPlans,
          operation.plan,
          (left, right) => left.targetLineItemId === right.targetLineItemId,
        );
        break;
      }
      case "set_category_group": {
        const group = normalizeCategoryGroup(next, operation.group);
        const groups = replaceCategoryGroup(next, group);
        acceptSkeleton(next, applyDcfCategoryGroups(skeletonOf(next), [group]));
        next.categoryGroups = groups;
        break;
      }
      case "set_valuation_config":
        next.valuationConfig = validateValuationConfig(operation.config);
        break;
      case "advance_stage": {
        const current = STAGE_ORDER.indexOf(next.lifecycleStage);
        const target = STAGE_ORDER.indexOf(operation.stage);
        if (target <= current || target < 0) {
          operationError(`invalid lifecycle transition: ${next.lifecycleStage} -> ${operation.stage}`);
        }
        next.lifecycleStage = operation.stage;
        break;
      }
      default: {
        const exhaustive: never = operation;
        operationError(`unknown operation: ${String(exhaustive)}`);
      }
    }
  }

  validateFinalCoverage(next);
  return next;
}
