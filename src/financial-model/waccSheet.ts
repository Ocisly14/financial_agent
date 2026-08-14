/**
 * The WACC sheet: a fixed 12-row skeleton, structurally the same idea as the DCF workbook — the
 * the engine may offer measured starting values, but the agent owns every non-derived input and
 * the locked formula rows (`cost_of_equity`, `net_debt`, `e_over_v`, `d_over_v`, `wacc`) derive
 * from those. `wacc` is the only official discount rate; there is no second, black-box path to it.
 *
 * The sheet is a single-column scalar environment anchored at one as-of date (the model's creation
 * date) — no period grid. Formulas reuse the DSL parser but evaluate over this 13-row namespace
 * (12 public rows plus the hidden `cash_and_equivalents_value` row that only exists so the locked
 * `net_debt` formula has something to subtract).
 */
import { parseFormula, type Ast } from "./dsl/parser.ts";
import { assignableTo, combine, unitLabel, type UnitTerm } from "./dsl/units.ts";
import { FinancialModelError } from "./errors.ts";
import type { Unit } from "./types.ts";

export const WACC_SHEET_ROW_IDS = [
  "beta",
  "risk_free_rate",
  "equity_risk_premium",
  "cost_of_equity",
  "cost_of_debt",
  "equity_value",
  "total_debt",
  "net_debt",
  "e_over_v",
  "d_over_v",
  "effective_tax_rate",
  "wacc",
] as const;

export type WaccSheetRowId = (typeof WACC_SHEET_ROW_IDS)[number];

/** The hidden 13th row (`cash_and_equivalents_value`) is not part of the public 12-row contract —
 * it exists only so the locked `net_debt` formula has an operand — but it lives in the same
 * namespace, so every internal row-shaped type must admit it too. */
export type WaccSheetAnyRowId = WaccSheetRowId | "cash_and_equivalents_value";

const HIDDEN_ROW_ID: WaccSheetAnyRowId = "cash_and_equivalents_value";

export type WaccSheetRow = {
  rowId: WaccSheetAnyRowId;
  label: string;
  unit: Unit;
  source: "computed" | "agent" | "locked_formula" | "empty";
  value: number | null;
  formulaSource?: string;
  provenance?: { sourceType: string; sourceRefs: string[]; asOfDate: string; rationale: string };
  missingInputs: WaccSheetAnyRowId[];
};

export type WaccSheet = { asOfDate: string; rows: WaccSheetRow[] };

export type WaccSheetComputedInput = {
  rowId:
    | "beta"
    | "cost_of_debt"
    | "equity_value"
    | "total_debt"
    | "effective_tax_rate"
    | "cash_and_equivalents_value"
    | "risk_free_rate";
  value: number;
  provenance: NonNullable<WaccSheetRow["provenance"]>;
};

export type SetWaccInput = {
  rowId: WaccSheetRowId;
  value?: number;
  formula?: string;
  sourceType: string;
  sourceRefs: string[];
  rationale: string;
  asOfDate: string;
};

/** These two rows are economic choices, not merely mechanical calculations. A measured Treasury
 * point is a candidate until the agent selects the duration it intends to discount with; ERP has
 * no observable value at all. The other direct rows may be populated from final workbook cells or
 * market data, while the relationship rows remain locked formulas. */
export const WACC_AGENT_JUDGMENT_ROW_IDS = [
  "risk_free_rate",
  "equity_risk_premium",
] as const;

/** Rows the agent may write via `setWaccInput`. The agent may replace any measured starting value
 * after checking the final workbook calculation; only the five relationship rows stay locked. */
const AGENT_WRITABLE_ROW_IDS: ReadonlySet<WaccSheetRowId> = new Set([
  "beta",
  "risk_free_rate",
  "equity_risk_premium",
  "cost_of_debt",
  "equity_value",
  "total_debt",
  "effective_tax_rate",
]);

const REPORTING_CURRENCY = "USD";
const CURRENCY: Unit = { kind: "currency", code: REPORTING_CURRENCY };
const PERCENT: Unit = { kind: "percent" };
const RATIO: Unit = { kind: "ratio" };

type RowSpec = {
  rowId: WaccSheetAnyRowId;
  label: string;
  unit: Unit;
  source: WaccSheetRow["source"];
  formulaSource?: string;
};

const ROW_SPECS: readonly RowSpec[] = [
  { rowId: "beta", label: "Beta", unit: RATIO, source: "computed" },
  { rowId: "risk_free_rate", label: "Risk-free rate", unit: PERCENT, source: "empty" },
  { rowId: "equity_risk_premium", label: "Equity risk premium", unit: PERCENT, source: "empty" },
  {
    rowId: "cost_of_equity",
    label: "Cost of equity",
    unit: PERCENT,
    source: "locked_formula",
    formulaSource: "risk_free_rate + beta * equity_risk_premium",
  },
  { rowId: "cost_of_debt", label: "Cost of debt", unit: PERCENT, source: "computed" },
  { rowId: "equity_value", label: "Equity value", unit: CURRENCY, source: "computed" },
  { rowId: "total_debt", label: "Total debt", unit: CURRENCY, source: "computed" },
  {
    rowId: "net_debt",
    label: "Net debt",
    unit: CURRENCY,
    source: "locked_formula",
    formulaSource: "total_debt - cash_and_equivalents_value",
  },
  {
    rowId: "e_over_v",
    label: "E / V",
    unit: RATIO,
    source: "locked_formula",
    formulaSource: "equity_value / (equity_value + total_debt)",
  },
  {
    rowId: "d_over_v",
    label: "D / V",
    unit: RATIO,
    source: "locked_formula",
    formulaSource: "total_debt / (equity_value + total_debt)",
  },
  { rowId: "effective_tax_rate", label: "Effective tax rate", unit: PERCENT, source: "computed" },
  {
    rowId: "wacc",
    label: "WACC",
    unit: PERCENT,
    source: "locked_formula",
    formulaSource: "e_over_v * cost_of_equity + d_over_v * cost_of_debt * (1 - effective_tax_rate)",
  },
  {
    rowId: HIDDEN_ROW_ID,
    label: "Cash and equivalents",
    unit: CURRENCY,
    source: "computed",
  },
];

const LOCKED_ROW_IDS: ReadonlySet<WaccSheetAnyRowId> = new Set(
  ROW_SPECS.filter((spec) => spec.source === "locked_formula").map((spec) => spec.rowId),
);

export function createWaccSheet(asOfDate: string): WaccSheet {
  const rows: WaccSheetRow[] = ROW_SPECS.map((spec) => ({
    rowId: spec.rowId,
    label: spec.label,
    unit: spec.unit,
    source: spec.source,
    value: null,
    ...(spec.formulaSource !== undefined ? { formulaSource: spec.formulaSource } : {}),
    missingInputs: [],
  }));
  return { asOfDate, rows };
}

function cloneSheet(sheet: WaccSheet): WaccSheet {
  return {
    asOfDate: sheet.asOfDate,
    rows: sheet.rows.map((row) => ({
      ...row,
      missingInputs: [...row.missingInputs],
      ...(row.provenance !== undefined ? { provenance: { ...row.provenance } } : {}),
    })),
  };
}

function rowMap(sheet: WaccSheet): Map<WaccSheetAnyRowId, WaccSheetRow> {
  return new Map(sheet.rows.map((row) => [row.rowId, row]));
}

export function applyComputedWaccInputs(
  sheet: WaccSheet,
  inputs: readonly WaccSheetComputedInput[],
): WaccSheet {
  const next = cloneSheet(sheet);
  const byId = rowMap(next);
  for (const input of inputs) {
    const row = byId.get(input.rowId);
    if (row === undefined) continue;
    if (row.source === "agent") continue; // agent-authored values are never overwritten
    row.value = input.value;
    row.source = "computed";
    row.provenance = { ...input.provenance };
    delete row.formulaSource;
    row.missingInputs = [];
  }
  return next;
}

/** A resolved arithmetic WACC is not yet an approved discount rate until the agent has recorded
 * its two irreducible economic judgments. */
export function missingWaccAgentJudgments(sheet: WaccSheet): typeof WACC_AGENT_JUDGMENT_ROW_IDS[number][] {
  const byId = rowMap(sheet);
  return WACC_AGENT_JUDGMENT_ROW_IDS.filter((rowId) => byId.get(rowId)?.source !== "agent");
}

export function setWaccInput(sheet: WaccSheet, input: SetWaccInput): WaccSheet {
  if (!AGENT_WRITABLE_ROW_IDS.has(input.rowId)) {
    throw new FinancialModelError(
      "invalid_model_operation",
      `row ${input.rowId} is not agent-writable`,
      { rowId: input.rowId },
    );
  }
  const hasValue = input.value !== undefined;
  const hasFormula = input.formula !== undefined && input.formula.length > 0;
  if (hasValue === hasFormula) {
    throw new FinancialModelError(
      "invalid_model_operation",
      "set_wacc_input requires exactly one of value or formula",
      { rowId: input.rowId },
    );
  }
  if (input.rationale.trim().length === 0) {
    throw new FinancialModelError(
      "invalid_model_operation",
      "set_wacc_input requires a non-empty rationale",
      { rowId: input.rowId },
    );
  }

  const next = cloneSheet(sheet);
  const byId = rowMap(next);
  const row = byId.get(input.rowId);
  if (row === undefined) {
    throw new FinancialModelError("invalid_model_operation", `unknown row ${input.rowId}`);
  }

  row.source = "agent";
  row.provenance = {
    sourceType: input.sourceType,
    sourceRefs: [...input.sourceRefs],
    asOfDate: input.asOfDate,
    rationale: input.rationale,
  };
  if (hasFormula && input.formula !== undefined) {
    row.formulaSource = input.formula;
    row.value = null;
  } else {
    delete row.formulaSource;
    row.value = input.value ?? null;
  }
  row.missingInputs = [];
  return next;
}

// --- Scalar formula evaluation ------------------------------------------------------------

function collectRefs(ast: Ast, out: Set<string>): void {
  switch (ast.t) {
    case "num":
      return;
    case "ref":
      out.add(ast.id);
      return;
    case "neg":
      collectRefs(ast.e, out);
      return;
    case "bin":
      collectRefs(ast.l, out);
      collectRefs(ast.r, out);
      return;
    case "call":
      // handled separately: calls are rejected outright for scalar rows.
      for (const arg of ast.args) collectRefs(arg, out);
      return;
  }
}

function assertNoCalls(ast: Ast, source: string): void {
  if (ast.t === "call") {
    throw new FinancialModelError(
      "invalid_formula",
      `function calls are not supported on the WACC sheet: ${source}`,
    );
  }
  if (ast.t === "neg") return assertNoCalls(ast.e, source);
  if (ast.t === "bin") {
    assertNoCalls(ast.l, source);
    assertNoCalls(ast.r, source);
  }
}

function unitOf(
  ast: Ast,
  byId: ReadonlyMap<WaccSheetAnyRowId, WaccSheetRow>,
  source: string,
): UnitTerm {
  const bad = (message: string): never => {
    throw new FinancialModelError("incompatible_units", `${message} in formula: ${source}`);
  };
  switch (ast.t) {
    case "num":
      return { unit: { kind: "number" }, literal: ast.v };
    case "ref": {
      const row = byId.get(ast.id as WaccSheetAnyRowId);
      if (row === undefined) {
        throw new FinancialModelError(
          "invalid_formula",
          `unknown row reference: ${ast.id} in formula: ${source}`,
        );
      }
      return { unit: row.unit };
    }
    case "neg": {
      const inner = unitOf(ast.e, byId, source);
      return inner.literal === undefined ? { unit: inner.unit } : { unit: inner.unit, literal: -inner.literal };
    }
    case "bin": {
      const left = unitOf(ast.l, byId, source);
      const right = unitOf(ast.r, byId, source);
      const result = combine(left, ast.op, right);
      if (result === null) {
        return bad(`cannot apply '${ast.op}' to ${unitLabel(left.unit)} and ${unitLabel(right.unit)}`);
      }
      return { unit: result };
    }
    case "call":
      throw new FinancialModelError(
        "invalid_formula",
        `function calls are not supported on the WACC sheet: ${source}`,
      );
  }
}

function evaluateAst(
  ast: Ast,
  resolve: (rowId: WaccSheetAnyRowId) => number | null,
  missing: Set<WaccSheetAnyRowId>,
): number | null {
  switch (ast.t) {
    case "num":
      return ast.v;
    case "ref": {
      const value = resolve(ast.id as WaccSheetAnyRowId);
      if (value === null) missing.add(ast.id as WaccSheetAnyRowId);
      return value;
    }
    case "neg": {
      const inner = evaluateAst(ast.e, resolve, missing);
      return inner === null ? null : -inner;
    }
    case "bin": {
      const left = evaluateAst(ast.l, resolve, missing);
      const right = evaluateAst(ast.r, resolve, missing);
      if (left === null || right === null) return null;
      switch (ast.op) {
        case "+": return left + right;
        case "-": return left - right;
        case "*": return left * right;
        case "/": return left / right;
      }
    }
    case "call":
      // unreachable: assertNoCalls runs before evaluation.
      throw new FinancialModelError("invalid_formula", "function calls are not supported on the WACC sheet");
  }
}

const SIGNIFICANT_DIGITS = 12;
function quantize(value: number): number {
  return Number(value.toPrecision(SIGNIFICANT_DIGITS));
}

export function recalculateWaccSheet(sheet: WaccSheet): WaccSheet {
  const next = cloneSheet(sheet);
  const byId = rowMap(next);

  type Compiled = { row: WaccSheetRow; ast: Ast; deps: Set<WaccSheetAnyRowId> };
  const compiled = new Map<WaccSheetAnyRowId, Compiled>();

  for (const row of next.rows) {
    if (row.formulaSource === undefined) continue;
    const ast = parseFormula(row.formulaSource);
    assertNoCalls(ast, row.formulaSource);
    const produced = unitOf(ast, byId, row.formulaSource);
    if (!assignableTo(produced, row.unit)) {
      throw new FinancialModelError(
        "incompatible_units",
        `formula for ${row.rowId} produces ${unitLabel(produced.unit)} but the row is ${unitLabel(row.unit)}`,
        { rowId: row.rowId, formula: row.formulaSource },
      );
    }
    const deps = new Set<string>();
    collectRefs(ast, deps);
    compiled.set(row.rowId, { row, ast, deps: deps as Set<WaccSheetAnyRowId> });
  }

  // Topological order over formula rows only; a formula row may depend on a leaf row (no edge
  // needed — leaf rows are always "ready") or on another formula row (an edge).
  const order: WaccSheetAnyRowId[] = [];
  const state = new Map<WaccSheetAnyRowId, "visiting" | "done">();

  const visit = (rowId: WaccSheetAnyRowId): void => {
    const entry = compiled.get(rowId);
    if (entry === undefined) return; // leaf row, nothing to order
    const mark = state.get(rowId);
    if (mark === "done") return;
    if (mark === "visiting") {
      throw new FinancialModelError(
        "circular_dependency",
        `circular dependency in the WACC sheet involving ${rowId}`,
        { rowId },
      );
    }
    state.set(rowId, "visiting");
    for (const dep of entry.deps) visit(dep);
    state.set(rowId, "done");
    order.push(rowId);
  };

  for (const rowId of compiled.keys()) visit(rowId);

  const resolved = new Map<WaccSheetAnyRowId, number | null>();
  for (const row of next.rows) {
    if (!compiled.has(row.rowId)) resolved.set(row.rowId, row.value);
  }

  for (const rowId of order) {
    const entry = compiled.get(rowId)!;
    const missing = new Set<WaccSheetAnyRowId>();
    const value = evaluateAst(
      entry.ast,
      (ref) => resolved.get(ref) ?? null,
      missing,
    );
    entry.row.value = value === null ? null : quantize(value);
    entry.row.missingInputs = [...missing];
    resolved.set(rowId, entry.row.value);
  }

  return next;
}
