import { cellKey, type CellKey } from "./dsl/graph.ts";
import { quantize } from "./engine.ts";
import { FinancialModelError } from "./errors.ts";
import { buildGrid } from "./periodGrid.ts";
import { validateRoleCardinality } from "./skeleton.ts";
import type {
  Cell,
  Diagnostic,
  LineItem,
  LineItemRole,
  Period,
  ValuationConfig,
} from "./types.ts";

export const MAX_SENSITIVITY_AXIS_LENGTH = 21;

export type ValuationInput = {
  periods: readonly Period[];
  lineItems: readonly LineItem[];
  cells: ReadonlyMap<CellKey, Cell>;
  valuationConfig: ValuationConfig;
};

export type ExplicitPeriodValue = {
  periodId: string;
  fcff: number;
  wacc: number;
  discountFactor: number;
  presentValue: number;
  refs: CellKey[];
};

export type BridgeAdjustment = {
  lineItemId: string;
  role: LineItemRole;
  sign: 1 | -1;
  status: "numeric" | "not_applicable";
  value: number | null;
  appliedAdjustment: number;
  refs: CellKey[];
};

export type TerminalMethodResult = {
  method: "gordon_growth" | "exit_multiple";
  explicitPeriods: ExplicitPeriodValue[];
  terminalValue: number;
  terminalPresentValue: number;
  terminalValuePercentOfEnterpriseValue: number;
  enterpriseValue: number;
  bridge: BridgeAdjustment[];
  equityValue: number;
  dilutedShares: number;
  impliedValuePerShare: number;
  warnings: Diagnostic[];
  refs: CellKey[];
};

export type ValuationDiagnostic =
  | Diagnostic
  | { code: "invalid_terminal_assumptions"; refs: string[] };

export type SensitivityCell = {
  rowDelta: number;
  columnDelta: number;
  impliedValuePerShare: number | null;
  diagnostics: ValuationDiagnostic[];
};

export type SensitivityMatrix = {
  rowVariable: "wacc_delta";
  columnVariable: "terminal_growth_delta" | "exit_multiple_delta";
  rowDeltas: number[];
  columnDeltas: number[];
  cells: SensitivityCell[][];
};

export type ValuationOutput = {
  explicitPeriods: ExplicitPeriodValue[];
  gordonGrowth: TerminalMethodResult;
  exitMultiple: TerminalMethodResult;
  waccByGrowth: SensitivityMatrix;
  waccByMultiple: SensitivityMatrix;
};

type DiscountSchedule = {
  factors: number[];
  presentValues: number[];
  explicitPresentValue: number;
};

type BoundInputs = {
  forecastPeriods: Period[];
  fcffLineItemId: string;
  waccLineItemId: string;
  fcff: number[];
  wacc: number[];
  terminalGrowth: number;
  exitMultiple: number;
  exitMetric: number;
  terminalGrowthRef: CellKey;
  exitMultipleRef: CellKey;
  exitMetricRef: CellKey;
  bridge: BridgeAdjustment[];
  bridgeTotal: number;
  dilutedShares: number;
  dilutedSharesRef: CellKey;
};

const FIXED_BRIDGE_SIGNS = new Map<LineItemRole, 1 | -1>([
  ["cash_available_for_bridge", 1],
  ["non_operating_investments", 1],
  ["debt", -1],
  ["lease_liabilities", -1],
  ["preferred_equity", -1],
  ["non_controlling_interests", -1],
]);

/** Validate and normalize the versioned method configuration before use. */
export function validateValuationConfig(config: ValuationConfig): ValuationConfig {
  if (config.anchorPeriodId.trim().length === 0) {
    invalidTerminal("valuation anchor period must not be empty");
  }

  const normalizeAxis = (values: readonly number[], name: string): number[] => {
    if (values.length === 0) {
      invalidTerminal(`${name} must contain at least one delta`);
    }
    const normalized: number[] = [];
    const seen = new Set<number>();
    for (const value of values) {
      if (!Number.isFinite(value)) invalidTerminal(`${name} contains a non-finite delta`);
      const canonical = quantize(Object.is(value, -0) ? 0 : value);
      if (!seen.has(canonical)) {
        seen.add(canonical);
        normalized.push(canonical);
      }
    }
    if (normalized.length > MAX_SENSITIVITY_AXIS_LENGTH) {
      invalidTerminal(
        `${name} exceeds the maximum length of ${MAX_SENSITIVITY_AXIS_LENGTH}`,
      );
    }
    normalized.sort((left, right) => left - right);
    return normalized;
  };

  return {
    ...config,
    sourceRefs: [...config.sourceRefs],
    sensitivity: {
      waccDeltas: normalizeAxis(config.sensitivity.waccDeltas, "WACC sensitivity"),
      terminalGrowthDeltas: normalizeAxis(
        config.sensitivity.terminalGrowthDeltas,
        "terminal-growth sensitivity",
      ),
      exitMultipleDeltas: normalizeAxis(
        config.sensitivity.exitMultipleDeltas,
        "exit-multiple sensitivity",
      ),
    },
  };
}

export function calculateValuation(input: ValuationInput): ValuationOutput {
  validateRoleCardinality(input.lineItems);
  const config = validateValuationConfig(input.valuationConfig);
  const bound = bindInputs(input, config);
  validateReferenceTerminalInputs(bound);

  const schedule = buildDiscountSchedule(bound.fcff, bound.wacc, config.discountConvention);
  const explicitPeriods = buildExplicitPeriods(bound, schedule);
  const finalFactor = schedule.factors[schedule.factors.length - 1]!;
  const finalFcff = bound.fcff[bound.fcff.length - 1]!;
  const finalWacc = bound.wacc[bound.wacc.length - 1]!;

  const gordonTerminalValue =
    finalFcff * (1 + bound.terminalGrowth) / (finalWacc - bound.terminalGrowth);
  const exitTerminalValue = bound.exitMetric * bound.exitMultiple;

  const gordonGrowth = buildMethodResult(
    "gordon_growth",
    explicitPeriods,
    schedule.explicitPresentValue,
    finalFactor,
    gordonTerminalValue,
    bound,
    [bound.terminalGrowthRef],
  );
  const exitMultiple = buildMethodResult(
    "exit_multiple",
    explicitPeriods,
    schedule.explicitPresentValue,
    finalFactor,
    exitTerminalValue,
    bound,
    [bound.exitMultipleRef, bound.exitMetricRef],
  );

  return {
    explicitPeriods,
    gordonGrowth,
    exitMultiple,
    waccByGrowth: buildGordonSensitivity(bound, config),
    waccByMultiple: buildExitSensitivity(bound, config),
  };
}

function bindInputs(input: ValuationInput, config: ValuationConfig): BoundInputs {
  const grid = buildGrid(input.periods);
  const anchorPosition = grid.positionOf(config.anchorPeriodId);
  if (anchorPosition < 0) invalidTerminal(`unknown valuation anchor: ${config.anchorPeriodId}`);

  const forecastPeriods = grid.ordered.filter(
    (period) => period.cls === "forecast" && grid.positionOf(period.id) > anchorPosition,
  );
  if (forecastPeriods.length === 0) {
    missingFormula("valuation requires at least one forecast period after the anchor");
  }

  const byRole = new Map<LineItemRole, LineItem[]>();
  for (const item of input.lineItems) {
    const rows = byRole.get(item.role) ?? [];
    rows.push(item);
    byRole.set(item.role, rows);
  }
  const one = (role: LineItemRole): LineItem => byRole.get(role)![0]!;
  const fcffItem = one("fcff");
  const waccItem = one("wacc");
  const terminalGrowthItem = one("terminal_growth");
  const exitMultipleItem = one("exit_multiple");
  const exitMetricItem = one(config.exitTerminalMetric);
  const finalPeriod = forecastPeriods[forecastPeriods.length - 1]!;

  const fcff = forecastPeriods.map((period) =>
    requireNumericCell(
      input.cells,
      fcffItem,
      period.id,
      "missing_formula_input",
      "FCFF",
    ));
  const wacc = forecastPeriods.map((period) =>
    requireNumericCell(
      input.cells,
      waccItem,
      period.id,
      "missing_formula_input",
      "WACC",
    ));
  const terminalGrowth = requireNumericCell(
    input.cells,
    terminalGrowthItem,
    finalPeriod.id,
    "missing_formula_input",
    "terminal growth",
  );
  const exitMultiple = requireNumericCell(
    input.cells,
    exitMultipleItem,
    finalPeriod.id,
    "missing_formula_input",
    "exit multiple",
  );
  const exitMetric = requireNumericCell(
    input.cells,
    exitMetricItem,
    finalPeriod.id,
    "missing_formula_input",
    config.exitTerminalMetric.toUpperCase(),
  );

  const bridge: BridgeAdjustment[] = [];
  for (const [role, sign] of FIXED_BRIDGE_SIGNS) {
    bridge.push(resolveBridgeAdjustment(input.cells, one(role), config.anchorPeriodId, sign));
  }
  const bridgeOthers = [...(byRole.get("bridge_other") ?? [])].sort(
    (left, right) => left.order - right.order || compareText(left.id, right.id),
  );
  for (const item of bridgeOthers) {
    bridge.push(resolveSignedOtherAdjustment(input.cells, item, config.anchorPeriodId));
  }

  const dilutedSharesItem = one("diluted_shares");
  const dilutedSharesRef = cellKey(dilutedSharesItem.id, config.anchorPeriodId);
  const dilutedShares = requireNumericCell(
    input.cells,
    dilutedSharesItem,
    config.anchorPeriodId,
    "incomplete_equity_bridge",
    "diluted shares",
  );
  if (dilutedShares <= 0) {
    incompleteBridge("diluted shares must be positive", [dilutedSharesRef]);
  }

  return {
    forecastPeriods,
    fcffLineItemId: fcffItem.id,
    waccLineItemId: waccItem.id,
    fcff,
    wacc,
    terminalGrowth,
    exitMultiple,
    exitMetric,
    terminalGrowthRef: cellKey(terminalGrowthItem.id, finalPeriod.id),
    exitMultipleRef: cellKey(exitMultipleItem.id, finalPeriod.id),
    exitMetricRef: cellKey(exitMetricItem.id, finalPeriod.id),
    bridge,
    bridgeTotal: bridge.reduce(
      (total, adjustment) => total + adjustment.appliedAdjustment,
      0,
    ),
    dilutedShares,
    dilutedSharesRef,
  };
}

function requireNumericCell(
  cells: ReadonlyMap<CellKey, Cell>,
  item: LineItem,
  periodId: string,
  errorCode: "missing_formula_input" | "incomplete_equity_bridge",
  label: string,
): number {
  const key = cellKey(item.id, periodId);
  const value = cells.get(key)?.value;
  if (value === null || value === undefined || !Number.isFinite(value)) {
    throw new FinancialModelError(errorCode, `${label} is not numeric at ${periodId}`, {
      refs: [key],
    });
  }
  return value;
}

function resolveBridgeAdjustment(
  cells: ReadonlyMap<CellKey, Cell>,
  item: LineItem,
  periodId: string,
  sign: 1 | -1,
): BridgeAdjustment {
  const key = cellKey(item.id, periodId);
  const cell = cells.get(key);
  if (
    cell?.value === null
    && cell.diagnostics.some((diagnostic) => diagnostic.code === "not_applicable")
  ) {
    return {
      lineItemId: item.id,
      role: item.role,
      sign,
      status: "not_applicable",
      value: null,
      appliedAdjustment: 0,
      refs: [key],
    };
  }
  const value = requireNumericCell(
    cells,
    item,
    periodId,
    "incomplete_equity_bridge",
    item.label,
  );
  return {
    lineItemId: item.id,
    role: item.role,
    sign,
    status: "numeric",
    value: quantize(value),
    appliedAdjustment: quantize(sign * value),
    refs: [key],
  };
}

/**
 * The phase-1 row type has no separate bridge-other sign field. Such reviewed
 * rows therefore carry a signed numeric amount: positive adds and negative
 * subtracts. Fixed bridge rows continue to use their immutable role signs.
 */
function resolveSignedOtherAdjustment(
  cells: ReadonlyMap<CellKey, Cell>,
  item: LineItem,
  periodId: string,
): BridgeAdjustment {
  const key = cellKey(item.id, periodId);
  const cell = cells.get(key);
  if (
    cell?.value === null
    && cell.diagnostics.some((diagnostic) => diagnostic.code === "not_applicable")
  ) {
    return {
      lineItemId: item.id,
      role: item.role,
      sign: 1,
      status: "not_applicable",
      value: null,
      appliedAdjustment: 0,
      refs: [key],
    };
  }
  const signedValue = requireNumericCell(
    cells,
    item,
    periodId,
    "incomplete_equity_bridge",
    item.label,
  );
  const sign: 1 | -1 = signedValue < 0 ? -1 : 1;
  return {
    lineItemId: item.id,
    role: item.role,
    sign,
    status: "numeric",
    value: quantize(Math.abs(signedValue)),
    appliedAdjustment: quantize(signedValue),
    refs: [key],
  };
}

function validateReferenceTerminalInputs(bound: BoundInputs): void {
  if (bound.terminalGrowth <= -1) invalidTerminal("terminal growth must be greater than -100%");
  if (bound.exitMultiple <= 0) invalidTerminal("exit multiple must be positive");
  if (bound.wacc.some((wacc) => 1 + wacc <= 0)) {
    invalidTerminal("every WACC must be greater than -100%");
  }
  const finalWacc = bound.wacc[bound.wacc.length - 1]!;
  if (finalWacc <= bound.terminalGrowth) {
    invalidTerminal("final WACC must be greater than terminal growth", [
      bound.terminalGrowthRef,
    ]);
  }
}

function buildDiscountSchedule(
  fcff: readonly number[],
  wacc: readonly number[],
  convention: ValuationConfig["discountConvention"],
): DiscountSchedule {
  const factors: number[] = [];
  const presentValues: number[] = [];
  let priorFullPeriods = 1;
  let explicitPresentValue = 0;

  for (let index = 0; index < fcff.length; index += 1) {
    const base = 1 + wacc[index]!;
    const factor = convention === "mid_year"
      ? priorFullPeriods * Math.sqrt(base)
      : priorFullPeriods * base;
    const presentValue = fcff[index]! / factor;
    factors.push(factor);
    presentValues.push(presentValue);
    explicitPresentValue += presentValue;
    priorFullPeriods *= base;
  }
  return { factors, presentValues, explicitPresentValue };
}

function buildExplicitPeriods(
  bound: BoundInputs,
  schedule: DiscountSchedule,
): ExplicitPeriodValue[] {
  return bound.forecastPeriods.map((period, index) => {
    return {
      periodId: period.id,
      fcff: quantize(bound.fcff[index]!),
      wacc: quantize(bound.wacc[index]!),
      discountFactor: quantize(schedule.factors[index]!),
      presentValue: quantize(schedule.presentValues[index]!),
      refs: [
        cellKey(bound.fcffLineItemId, period.id),
        cellKey(bound.waccLineItemId, period.id),
      ],
    };
  });
}

function buildMethodResult(
  method: TerminalMethodResult["method"],
  explicitPeriods: ExplicitPeriodValue[],
  explicitPresentValue: number,
  finalFactor: number,
  terminalValue: number,
  bound: BoundInputs,
  terminalRefs: readonly CellKey[],
): TerminalMethodResult {
  const terminalPresentValue = terminalValue / finalFactor;
  const enterpriseValue = explicitPresentValue + terminalPresentValue;
  if (enterpriseValue === 0) {
    invalidTerminal(`${method} enterprise value is zero`);
  }
  const equityValue = enterpriseValue + bound.bridgeTotal;
  const refs = uniqueRefs([
    ...explicitPeriods.flatMap((period) => period.refs),
    ...terminalRefs,
    ...bound.bridge.flatMap((adjustment) => adjustment.refs),
    bound.dilutedSharesRef,
  ]);

  return {
    method,
    explicitPeriods: explicitPeriods.map(cloneExplicitPeriod),
    terminalValue: quantize(terminalValue),
    terminalPresentValue: quantize(terminalPresentValue),
    terminalValuePercentOfEnterpriseValue: quantize(
      terminalPresentValue / enterpriseValue,
    ),
    enterpriseValue: quantize(enterpriseValue),
    bridge: bound.bridge.map(cloneBridgeAdjustment),
    equityValue: quantize(equityValue),
    dilutedShares: quantize(bound.dilutedShares),
    impliedValuePerShare: quantize(equityValue / bound.dilutedShares),
    warnings: [],
    refs,
  };
}

function buildGordonSensitivity(
  bound: BoundInputs,
  config: ValuationConfig,
): SensitivityMatrix {
  const rows = config.sensitivity.waccDeltas;
  const columns = config.sensitivity.terminalGrowthDeltas;
  return {
    rowVariable: "wacc_delta",
    columnVariable: "terminal_growth_delta",
    rowDeltas: [...rows],
    columnDeltas: [...columns],
    cells: rows.map((rowDelta) =>
      columns.map((columnDelta) => {
        const stressedWacc = bound.wacc.map((wacc) => wacc + rowDelta);
        const stressedGrowth = bound.terminalGrowth + columnDelta;
        const finalWacc = stressedWacc[stressedWacc.length - 1]!;
        const invalid = stressedWacc.some((wacc) => 1 + wacc <= 0)
          || stressedGrowth <= -1
          || finalWacc <= stressedGrowth;
        if (invalid) {
          return invalidSensitivityCell(
            rowDelta,
            columnDelta,
            [bound.terminalGrowthRef],
          );
        }
        const schedule = buildDiscountSchedule(
          bound.fcff,
          stressedWacc,
          config.discountConvention,
        );
        const finalFactor = schedule.factors[schedule.factors.length - 1]!;
        const terminal = bound.fcff[bound.fcff.length - 1]!
          * (1 + stressedGrowth)
          / (finalWacc - stressedGrowth);
        const equity = schedule.explicitPresentValue + terminal / finalFactor
          + bound.bridgeTotal;
        return {
          rowDelta: quantize(rowDelta),
          columnDelta: quantize(columnDelta),
          impliedValuePerShare: quantize(equity / bound.dilutedShares),
          diagnostics: [],
        };
      }),
    ),
  };
}

function buildExitSensitivity(
  bound: BoundInputs,
  config: ValuationConfig,
): SensitivityMatrix {
  const rows = config.sensitivity.waccDeltas;
  const columns = config.sensitivity.exitMultipleDeltas;
  return {
    rowVariable: "wacc_delta",
    columnVariable: "exit_multiple_delta",
    rowDeltas: [...rows],
    columnDeltas: [...columns],
    cells: rows.map((rowDelta) =>
      columns.map((columnDelta) => {
        const stressedWacc = bound.wacc.map((wacc) => wacc + rowDelta);
        const stressedMultiple = bound.exitMultiple + columnDelta;
        if (stressedWacc.some((wacc) => 1 + wacc <= 0) || stressedMultiple <= 0) {
          return invalidSensitivityCell(
            rowDelta,
            columnDelta,
            [bound.exitMultipleRef],
          );
        }
        const schedule = buildDiscountSchedule(
          bound.fcff,
          stressedWacc,
          config.discountConvention,
        );
        const finalFactor = schedule.factors[schedule.factors.length - 1]!;
        const terminal = bound.exitMetric * stressedMultiple;
        const equity = schedule.explicitPresentValue + terminal / finalFactor
          + bound.bridgeTotal;
        return {
          rowDelta: quantize(rowDelta),
          columnDelta: quantize(columnDelta),
          impliedValuePerShare: quantize(equity / bound.dilutedShares),
          diagnostics: [],
        };
      }),
    ),
  };
}

function invalidSensitivityCell(
  rowDelta: number,
  columnDelta: number,
  refs: string[],
): SensitivityCell {
  return {
    rowDelta: quantize(rowDelta),
    columnDelta: quantize(columnDelta),
    impliedValuePerShare: null,
    diagnostics: [{ code: "invalid_terminal_assumptions", refs }],
  };
}

function cloneExplicitPeriod(period: ExplicitPeriodValue): ExplicitPeriodValue {
  return { ...period, refs: [...period.refs] };
}

function cloneBridgeAdjustment(adjustment: BridgeAdjustment): BridgeAdjustment {
  return { ...adjustment, refs: [...adjustment.refs] };
}

function uniqueRefs(refs: readonly CellKey[]): CellKey[] {
  return [...new Set(refs)];
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalidTerminal(message: string, refs: string[] = []): never {
  throw new FinancialModelError("invalid_terminal_assumptions", message, { refs });
}

function missingFormula(message: string, refs: string[] = []): never {
  throw new FinancialModelError("missing_formula_input", message, { refs });
}

function incompleteBridge(message: string, refs: string[] = []): never {
  throw new FinancialModelError("incomplete_equity_bridge", message, { refs });
}
