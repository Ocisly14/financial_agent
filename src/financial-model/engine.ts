import { FinancialModelError } from "./errors.ts";
import { buildGrid } from "./periodGrid.ts";
import { parseFormula, type Ast } from "./dsl/parser.ts";
import {
  cellKey,
  dependenciesOf,
  splitCellKey,
  topoOrder,
  type CellKey,
  type GraphContext,
} from "./dsl/graph.ts";
import {
  assignableTo,
  combine,
  commonUnit,
  compatibleUnit,
  sameUnit,
  unitLabel,
  type UnitTerm,
} from "./dsl/units.ts";
import type {
  ActiveFact,
  Assumption,
  Cell,
  Diagnostic,
  LineItem,
  Period,
  Unit,
  ValuationConfig,
} from "./types.ts";

/** Bumped whenever arithmetic, quantization, or evaluation order changes, so
 * stored results become identifiably stale rather than silently inconsistent. */
export const ENGINE_VERSION = "1.0.0";

const SIGNIFICANT_DIGITS = 12;

export function quantize(value: number): number {
  return Number(value.toPrecision(SIGNIFICANT_DIGITS));
}

export type Formula = {
  lineItemId: string;
  appliesTo: "historical" | "forecast";
  /** Omitted means every period in appliesTo; otherwise binds this formula to
   * exactly these period cells. Explicit coverages may not overlap. */
  periodIds?: readonly string[];
  source: string;
};

export type EngineInput = {
  periods: readonly Period[];
  lineItems: readonly LineItem[];
  facts: readonly ActiveFact[];
  assumptions: readonly Assumption[];
  formulas: readonly Formula[];
  valuationConfig: ValuationConfig;
};

export type EngineOutput = { cells: Map<CellKey, Cell>; order: CellKey[] };

type Resolved = { value: number | null; diagnostics: Diagnostic[] };

export function evaluate(input: EngineInput): EngineOutput {
  const grid = buildGrid(input.periods);
  const itemById = new Map(input.lineItems.map((item) => [item.id, item]));

  const context: GraphContext = {
    grid,
    valuationAnchorPeriodId: input.valuationConfig.anchorPeriodId,
    rankOf: (lineItemId) =>
      itemById.get(lineItemId)?.order ?? Number.MAX_SAFE_INTEGER,
  };

  const sourceOf = (item: LineItem, period: Period) =>
    period.cls === "forecast" ? item.forecast : item.historical;

  // Parse and unit-check every formula before evaluating any cell.
  const compiledFormulas: Array<{ definition: Formula; ast: Ast }> = [];
  for (const formula of input.formulas) {
    const item = itemById.get(formula.lineItemId);
    if (item === undefined) {
      throw new FinancialModelError(
        "invalid_formula",
        `formula references unknown line item: ${formula.lineItemId}`,
      );
    }
    const ast = parseFormula(formula.source);
    const produced = unitOf(ast, itemById, formula.source);
    if (!assignableTo(produced, item.unit)) {
      throw new FinancialModelError(
        "incompatible_units",
        `formula for ${item.id} produces ${unitLabel(produced.unit)} but the row is ${unitLabel(item.unit)}`,
        { lineItemId: item.id, formula: formula.source },
      );
    }

    const explicitPeriods = new Set<string>();
    for (const periodId of formula.periodIds ?? []) {
      if (explicitPeriods.has(periodId)) {
        throw new FinancialModelError(
          "invalid_formula",
          `formula repeats explicit period coverage for ${periodId}`,
        );
      }
      explicitPeriods.add(periodId);
      const period = grid.get(periodId);
      const expected = formula.appliesTo === "forecast" ? "forecast" : "historical";
      if (
        period === undefined
        || (expected === "forecast") !== (period.cls === "forecast")
      ) {
        throw new FinancialModelError(
          "invalid_formula",
          `formula period ${periodId} is outside ${formula.appliesTo} coverage`,
        );
      }
    }
    compiledFormulas.push({ definition: formula, ast });
  }

  // Seed committed facts and assumptions, rejecting ambiguous coverage.
  const seeded = new Map<CellKey, number>();
  const explicitlyNotApplicable = new Set<CellKey>();
  const activeFactKeys = new Set<CellKey>();
  for (const fact of input.facts) {
    const key = cellKey(fact.lineItemId, fact.periodId);
    if (activeFactKeys.has(key)) {
      throw new FinancialModelError("fact_conflict", `multiple active facts for ${key}`);
    }
    activeFactKeys.add(key);
    seeded.set(key, fact.value);
  }

  const assumptionKeys = new Set<CellKey>();
  for (const assumption of input.assumptions) {
    if (
      assumption.payload.kind === "values"
      && assumption.payload.values.length !== 1
      && assumption.payload.values.length !== assumption.periods.length
    ) {
      throw new FinancialModelError(
        "invalid_assumption",
        `assumption ${assumption.assumptionId} must provide one value or one value per period`,
      );
    }
    assumption.periods.forEach((periodId, index) => {
      const key = cellKey(assumption.lineItemId, periodId);
      if (assumptionKeys.has(key)) {
        throw new FinancialModelError(
          "invalid_assumption",
          `overlapping assumptions for ${key}`,
        );
      }
      assumptionKeys.add(key);
      if (assumption.payload.kind === "not_applicable") {
        explicitlyNotApplicable.add(key);
        seeded.delete(key);
        return;
      }
      const value = assumption.payload.values.length === 1
        ? assumption.payload.values[0]!
        : assumption.payload.values[index];
      if (value !== undefined) seeded.set(key, value);
    });
  }

  // Enumerate every modeled cell and its cell-level dependencies.
  const nodes: CellKey[] = [];
  const dependencies = new Map<CellKey, CellKey[]>();
  const formulaAt = new Map<CellKey, Ast>();
  for (const item of input.lineItems) {
    for (const period of grid.all) {
      const source = sourceOf(item, period);
      if (source === "none") continue;
      const key = cellKey(item.id, period.id);
      nodes.push(key);

      if (source === "formula") {
        const appliesTo = period.cls === "forecast" ? "forecast" : "historical";
        const matches = compiledFormulas.filter(
          ({ definition }) =>
            definition.lineItemId === item.id
            && definition.appliesTo === appliesTo
            && (
              definition.periodIds === undefined
              || definition.periodIds.includes(period.id)
            ),
        );
        if (matches.length > 1) {
          throw new FinancialModelError(
            "invalid_formula",
            `overlapping formulas for ${key}`,
          );
        }
        const compiled = matches[0];
        if (compiled !== undefined) {
          formulaAt.set(key, compiled.ast);
          dependencies.set(
            key,
            dependenciesOf(compiled.ast, item.id, period.id, context),
          );
          continue;
        }
      }
      dependencies.set(key, []);
    }
  }

  const order = topoOrder(nodes, dependencies, context);
  const cells = new Map<CellKey, Cell>();

  for (const key of order) {
    const { lineItemId, periodId } = splitCellKey(key);
    const item = itemById.get(lineItemId)!;
    const period = grid.get(periodId)!;
    const ast = formulaAt.get(key);

    if (ast === undefined) {
      if (explicitlyNotApplicable.has(key)) {
        cells.set(key, {
          value: null,
          unit: item.unit,
          diagnostics: [{ code: "not_applicable", refs: [key] }],
        });
        continue;
      }
      const value = seeded.get(key);
      cells.set(
        key,
        value === undefined
          ? {
              value: null,
              unit: item.unit,
              diagnostics: [{ code: "missing_input", refs: [key] }],
            }
          : { value: quantize(value), unit: item.unit, diagnostics: [] },
      );
      continue;
    }

    const resolved = run(ast, {
      key,
      periodId,
      period,
      cells,
      context,
      valuationConfig: input.valuationConfig,
    });
    cells.set(key, {
      value: resolved.value === null ? null : quantize(resolved.value),
      unit: item.unit,
      diagnostics: resolved.diagnostics,
    });
  }

  return { cells, order };
}

/**
 * Static unit of a formula against known row units — the same logic the compile-time check runs, so a
 * caller can adopt the produced unit instead of guessing one and colliding with it.
 */
export function inferFormulaUnit(source: string, itemById: ReadonlyMap<string, LineItem>): Unit {
  return unitOf(parseFormula(source), itemById, source).unit;
}

/** Compile-time unit of an expression. Throws before evaluation on mismatch. */
function unitOf(
  ast: Ast,
  itemById: ReadonlyMap<string, LineItem>,
  source: string,
): UnitTerm {
  const bad = (message: string): never => {
    throw new FinancialModelError(
      "incompatible_units",
      `${message} in formula: ${source}`,
    );
  };
  const recur = (node: Ast): UnitTerm => unitOf(node, itemById, source);

  switch (ast.t) {
    case "num":
      return { unit: { kind: "number" }, literal: ast.v };
    case "ref": {
      const item = itemById.get(ast.id);
      if (item === undefined) {
        throw new FinancialModelError(
          "invalid_formula",
          `unknown line item: ${ast.id} in formula: ${source}`,
        );
      }
      return { unit: item.unit };
    }
    case "neg": {
      const inner = recur(ast.e);
      return inner.literal === undefined
        ? { unit: inner.unit }
        : { unit: inner.unit, literal: -inner.literal };
    }
    case "bin": {
      const left = recur(ast.l);
      const right = recur(ast.r);
      const result = combine(left, ast.op, right);
      if (result === null) {
        return bad(
          `cannot apply '${ast.op}' to ${unitLabel(left.unit)} and ${unitLabel(right.unit)}`,
        );
      }
      return { unit: result };
    }
    case "call": {
      switch (ast.fn) {
        case "YEAR_INDEX":
          return { unit: { kind: "number" } };
        case "DISCOUNT_FACTOR": {
          const rate = recur(ast.args[0]!);
          if (rate.unit.kind !== "percent" && rate.unit.kind !== "ratio") {
            bad("DISCOUNT_FACTOR requires a percent or ratio WACC reference");
          }
          return { unit: { kind: "ratio" } };
        }
        case "YOY":
        case "CAGR":
          return { unit: { kind: "percent" } };
        case "LAG":
        case "ABS":
          return { unit: recur(ast.args[0]!).unit };
        case "SUM":
        case "AVERAGE":
          return recur(ast.args[0]!);
        case "POW": {
          const base = recur(ast.args[0]!);
          const exponent = recur(ast.args[1]!);
          if (
            !compatibleUnit(base.unit, { kind: "number" })
            || !sameUnit(exponent.unit, { kind: "number" })
          ) {
            bad("POW requires a dimensionless base and number exponent");
          }
          return { unit: { kind: "ratio" } };
        }
        case "MIN":
        case "MAX": {
          let merged = recur(ast.args[0]!).unit;
          for (const arg of ast.args.slice(1)) {
            const unit = commonUnit(merged, recur(arg).unit);
            if (unit === null) {
              return bad(`${ast.fn} arguments must have compatible units`);
            }
            merged = unit;
          }
          return { unit: merged };
        }
      }
    }
  }
}

type RunContext = {
  key: CellKey;
  periodId: string;
  period: Period;
  cells: ReadonlyMap<CellKey, Cell>;
  context: GraphContext;
  valuationConfig: ValuationConfig;
};

function run(ast: Ast, runContext: RunContext): Resolved {
  const missing: string[] = [];
  let divideByZero = false;
  let notApplicable = false;

  const read = (lineItemId: string, periodId: string | undefined): number | null => {
    if (periodId === undefined) {
      missing.push(`${lineItemId}@<out of range>`);
      return null;
    }
    const key = cellKey(lineItemId, periodId);
    const cell = runContext.cells.get(key);
    if (cell === undefined) {
      missing.push(key);
      return null;
    }
    if (cell.value === null) {
      if (cell.diagnostics.some((diagnostic) => diagnostic.code === "not_applicable")) {
        notApplicable = true;
      } else {
        const originatingRefs = cell.diagnostics
          .filter((diagnostic) => diagnostic.code === "missing_input")
          .flatMap((diagnostic) => diagnostic.refs);
        missing.push(...(originatingRefs.length > 0 ? originatingRefs : [key]));
      }
      return null;
    }
    return cell.value;
  };

  const walk = (node: Ast): number | null => {
    switch (node.t) {
      case "num":
        return node.v;
      case "ref":
        return read(node.id, runContext.periodId);
      case "neg": {
        const value = walk(node.e);
        return value === null ? null : -value;
      }
      case "bin": {
        const left = walk(node.l);
        const right = walk(node.r);
        if (left === null || right === null) return null;
        if (node.op === "/" && right === 0) {
          divideByZero = true;
          return null;
        }
        if (node.op === "+") return left + right;
        if (node.op === "-") return left - right;
        if (node.op === "*") return left * right;
        return left / right;
      }
      case "call":
        return call(node);
    }
  };

  const call = (node: Extract<Ast, { t: "call" }>): number | null => {
    const refOf = (argument: Ast): string => (argument as { id: string }).id;
    const intOf = (argument: Ast): number =>
      argument.t === "num"
        ? argument.v
        : -((argument as { e: { v: number } }).e.v);

    switch (node.fn) {
      case "YEAR_INDEX": {
        if (runContext.period.cls !== "forecast") {
          notApplicable = true;
          return null;
        }
        const anchor = runContext.context.grid.positionOf(
          runContext.valuationConfig.anchorPeriodId,
        );
        const forecasts = runContext.context.grid.ordered.filter(
          (period) =>
            period.cls === "forecast"
            && runContext.context.grid.positionOf(period.id) > anchor,
        );
        const index = forecasts.findIndex(
          (period) => period.id === runContext.periodId,
        );
        if (index < 0) {
          notApplicable = true;
          return null;
        }
        return runContext.valuationConfig.discountConvention === "mid_year"
          ? index + 0.5
          : index + 1;
      }
      case "DISCOUNT_FACTOR": {
        if (runContext.period.cls !== "forecast") {
          notApplicable = true;
          return null;
        }
        const lineItemId = refOf(node.args[0]!);
        const anchor = runContext.context.grid.positionOf(
          runContext.valuationConfig.anchorPeriodId,
        );
        const forecasts = runContext.context.grid.ordered.filter(
          (period) =>
            period.cls === "forecast"
            && runContext.context.grid.positionOf(period.id) > anchor,
        );
        const current = forecasts.findIndex(
          (period) => period.id === runContext.periodId,
        );
        if (current < 0) {
          notApplicable = true;
          return null;
        }
        let factor = 1;
        for (let index = 0; index <= current; index += 1) {
          const rate = read(lineItemId, forecasts[index]?.id);
          if (rate === null) return null;
          const base = 1 + rate;
          if (base <= 0) {
            missing.push(`${lineItemId}@<invalid discount factor>`);
            return null;
          }
          const exponent =
            runContext.valuationConfig.discountConvention === "mid_year"
            && index === current
              ? 0.5
              : 1;
          factor *= Math.pow(base, exponent);
        }
        return factor;
      }
      case "LAG":
        return read(
          refOf(node.args[0]!),
          runContext.context.grid.at(
            runContext.periodId,
            -intOf(node.args[1]!),
          )?.id,
        );
      case "YOY": {
        const lineItemId = refOf(node.args[0]!);
        const current = read(lineItemId, runContext.periodId);
        const prior = read(
          lineItemId,
          runContext.context.grid.at(runContext.periodId, -1)?.id,
        );
        if (current === null || prior === null) return null;
        if (prior === 0) {
          divideByZero = true;
          return null;
        }
        return current / prior - 1;
      }
      case "CAGR": {
        const lineItemId = refOf(node.args[0]!);
        const periods = intOf(node.args[1]!);
        const current = read(lineItemId, runContext.periodId);
        const base = read(
          lineItemId,
          runContext.context.grid.at(runContext.periodId, -periods)?.id,
        );
        if (current === null || base === null) return null;
        if (base <= 0 || periods <= 0) {
          divideByZero = true;
          return null;
        }
        return Math.pow(current / base, 1 / periods) - 1;
      }
      case "SUM":
      case "AVERAGE": {
        const lineItemId = refOf(node.args[0]!);
        const window = runContext.context.grid.range(
          runContext.periodId,
          intOf(node.args[1]!),
          intOf(node.args[2]!),
        );
        if (window.length === 0) {
          missing.push(`${lineItemId}@<incomplete window>`);
          return null;
        }
        let total = 0;
        for (const period of window) {
          const value = read(lineItemId, period.id);
          if (value === null) return null;
          total += value;
        }
        return node.fn === "SUM" ? total : total / window.length;
      }
      case "ABS": {
        const value = walk(node.args[0]!);
        return value === null ? null : Math.abs(value);
      }
      case "POW": {
        const base = walk(node.args[0]!);
        const exponent = walk(node.args[1]!);
        return base === null || exponent === null
          ? null
          : Math.pow(base, exponent);
      }
      case "MIN":
      case "MAX": {
        const values = node.args.map(walk);
        if (values.some((value) => value === null)) return null;
        const numbers = values as number[];
        return node.fn === "MIN" ? Math.min(...numbers) : Math.max(...numbers);
      }
    }
  };

  const value = walk(ast);
  const diagnostics: Diagnostic[] = [];
  if (divideByZero) {
    diagnostics.push({ code: "divide_by_zero", refs: [runContext.key] });
  } else if (notApplicable) {
    diagnostics.push({ code: "not_applicable", refs: [runContext.key] });
  } else if (value === null && missing.length > 0) {
    diagnostics.push({ code: "missing_input", refs: [...new Set(missing)] });
  }
  return { value, diagnostics };
}
