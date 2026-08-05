import { FinancialModelError } from "../errors.ts";
import type { PeriodGrid } from "../periodGrid.ts";
import type { Ast } from "./parser.ts";

export type CellKey = string;

export function cellKey(lineItemId: string, periodId: string): CellKey {
  return `${lineItemId}@${periodId}`;
}

export function splitCellKey(key: CellKey): { lineItemId: string; periodId: string } {
  const at = key.lastIndexOf("@");
  return { lineItemId: key.slice(0, at), periodId: key.slice(at + 1) };
}

export type GraphContext = {
  grid: PeriodGrid;
  /** Valuation functions begin strictly after this immutable configured period. */
  valuationAnchorPeriodId: string;
  /** Line-item display order; breaks ties so the evaluation sequence is total. */
  rankOf(lineItemId: string): number;
};

function refId(ast: Ast | undefined, fn: string): string {
  if (ast?.t !== "ref") {
    throw new FinancialModelError(
      "invalid_formula",
      `${fn} requires a line-item reference as its first argument`,
    );
  }
  return ast.id;
}

function intArg(ast: Ast | undefined): number {
  if (ast?.t === "num") return ast.v;
  if (ast?.t === "neg" && ast.e.t === "num") return -ast.e.v;
  throw new FinancialModelError("invalid_formula", "expected an integer literal argument");
}

/**
 * The cells this formula reads when evaluated at (lineItemId, periodId).
 *
 * Edges that fall off the grid are omitted rather than reported: an offset past
 * the first period is a missing value, which is a property of the cell, not a
 * defect in the graph.
 */
export function dependenciesOf(
  ast: Ast,
  lineItemId: string,
  periodId: string,
  ctx: GraphContext,
): CellKey[] {
  const out: CellKey[] = [];
  const push = (id: string, pid: string | undefined): void => {
    if (pid !== undefined) out.push(cellKey(id, pid));
  };

  function walk(node: Ast): void {
    switch (node.t) {
      case "num":
        return;
      case "ref":
        push(node.id, periodId);
        return;
      case "neg":
        walk(node.e);
        return;
      case "bin":
        walk(node.l);
        walk(node.r);
        return;
      case "call": {
        switch (node.fn) {
          case "LAG": {
            const id = refId(node.args[0], "LAG");
            push(id, ctx.grid.at(periodId, -intArg(node.args[1]))?.id);
            return;
          }
          case "YOY": {
            const id = refId(node.args[0], "YOY");
            push(id, periodId);
            push(id, ctx.grid.at(periodId, -1)?.id);
            return;
          }
          case "CAGR": {
            const id = refId(node.args[0], "CAGR");
            push(id, periodId);
            push(id, ctx.grid.at(periodId, -intArg(node.args[1]))?.id);
            return;
          }
          case "SUM":
          case "AVERAGE": {
            const id = refId(node.args[0], node.fn);
            for (const period of ctx.grid.range(
              periodId,
              intArg(node.args[1]),
              intArg(node.args[2]),
            )) {
              push(id, period.id);
            }
            return;
          }
          case "DISCOUNT_FACTOR": {
            const id = refId(node.args[0], "DISCOUNT_FACTOR");
            const anchor = ctx.grid.positionOf(ctx.valuationAnchorPeriodId);
            const forecasts = ctx.grid.ordered.filter(
              (period) =>
                period.cls === "forecast" && ctx.grid.positionOf(period.id) > anchor,
            );
            const current = forecasts.findIndex((period) => period.id === periodId);
            for (let i = 0; i <= current; i += 1) push(id, forecasts[i]?.id);
            return;
          }
          case "YEAR_INDEX":
            return;
          default:
            node.args.forEach(walk);
            return;
        }
      }
    }
  }

  // Keep the target identity in this interface: callers build one graph node
  // per target cell, while dependencies themselves come only from the AST.
  void lineItemId;
  walk(ast);
  return out;
}

/**
 * Kahn's algorithm with a total tie-break. Two models with identical content
 * must evaluate in identical order, because float64 reproducibility is the
 * whole basis of the determinism guarantee.
 */
export function topoOrder(
  nodes: readonly CellKey[],
  deps: ReadonlyMap<CellKey, readonly CellKey[]>,
  ctx: GraphContext,
): CellKey[] {
  const present = new Set(nodes);
  const indegree = new Map<CellKey, number>(nodes.map((node) => [node, 0]));
  const dependents = new Map<CellKey, CellKey[]>(nodes.map((node) => [node, []]));

  for (const node of nodes) {
    for (const dependency of deps.get(node) ?? []) {
      if (!present.has(dependency)) continue;
      indegree.set(node, (indegree.get(node) ?? 0) + 1);
      dependents.get(dependency)!.push(node);
    }
  }

  const compareText = (left: string, right: string): number =>
    left < right ? -1 : left > right ? 1 : 0;
  const compareCells = (leftKey: CellKey, rightKey: CellKey): number => {
    if (leftKey === rightKey) return 0;
    const left = splitCellKey(leftKey);
    const right = splitCellKey(rightKey);
    const period = ctx.grid.positionOf(left.periodId) - ctx.grid.positionOf(right.periodId);
    if (period !== 0) return period;
    const lineOrder = ctx.rankOf(left.lineItemId) - ctx.rankOf(right.lineItemId);
    if (lineOrder !== 0) return lineOrder;
    const lineId = compareText(left.lineItemId, right.lineItemId);
    return lineId !== 0 ? lineId : compareText(leftKey, rightKey);
  };

  const ready = nodes
    .filter((node) => (indegree.get(node) ?? 0) === 0)
    .sort(compareCells);
  const order: CellKey[] = [];

  while (ready.length > 0) {
    const next = ready.shift()!;
    order.push(next);
    for (const dependent of dependents.get(next) ?? []) {
      const remaining = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, remaining);
      if (remaining === 0) {
        ready.push(dependent);
        ready.sort(compareCells);
      }
    }
  }

  if (order.length !== nodes.length) {
    const cycle = nodes.filter((node) => !order.includes(node)).sort(compareCells);
    throw new FinancialModelError(
      "circular_dependency",
      "the formula graph contains a cycle",
      { cells: cycle },
    );
  }
  return order;
}
