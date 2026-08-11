import { FinancialModelError } from "./errors.ts";
import type { Period, PeriodClass } from "./types.ts";

/**
 * The caller-supplied period sequence is authoritative model state.
 *
 * Every formula offset is a position on this grid, never calendar arithmetic:
 * a fiscal-calendar change or a 53-week year must not silently shift a
 * reference. TTM periods are excluded from the offset axis entirely — a
 * trailing-twelve-month window overlaps the fiscal year before it, so treating
 * the two as consecutive positions produces a growth rate describing nothing.
 */
export type PeriodGrid = {
  /** All periods including TTM, preserving the validated creation-time order. */
  readonly all: readonly Period[];
  /** The formula offset axis: the same order with TTM removed. */
  readonly ordered: readonly Period[];
  /** Position on the complete displayed timeline, including TTM. */
  positionOf(periodId: string): number;
  /** Position on the non-TTM formula offset axis; -1 for TTM or unknown IDs. */
  offsetIndexOf(periodId: string): number;
  at(periodId: string, offset: number): Period | undefined;
  /** Inclusive window. Returns [] when the window is not fully covered. */
  range(periodId: string, from: number, to: number): Period[];
  get(periodId: string): Period | undefined;
};

export function buildGrid(periods: readonly Period[]): PeriodGrid {
  const all = [...periods];
  const byId = new Map<string, Period>();
  const classRank: Record<PeriodClass, number> = { actual: 0, ttm: 1, forecast: 2 };
  let previousClass = -1;
  let previousEnd: string | undefined;
  let previousNonTtmEnd: string | undefined;
  let ttmCount = 0;

  for (const period of all) {
    if (byId.has(period.id)) {
      throw new FinancialModelError("incompatible_periods", `duplicate period id: ${period.id}`);
    }
    if (!isIsoDate(period.start) || !isIsoDate(period.end) || period.start > period.end) {
      throw new FinancialModelError("incompatible_periods", `invalid period dates: ${period.id}`);
    }
    if (previousEnd !== undefined && period.end < previousEnd) {
      throw new FinancialModelError("incompatible_periods", `periods are not chronological at: ${period.id}`);
    }
    const rank = classRank[period.cls];
    if (rank < previousClass) {
      throw new FinancialModelError("incompatible_periods", `period classes are interleaved at: ${period.id}`);
    }
    if (period.cls === "ttm" && ++ttmCount > 1) {
      throw new FinancialModelError("incompatible_periods", "at most one TTM period is allowed");
    }
    if (period.cls !== "ttm") {
      if (previousNonTtmEnd !== undefined && period.end <= previousNonTtmEnd) {
        throw new FinancialModelError(
          "incompatible_periods",
          `non-TTM period ends are not strictly increasing at: ${period.id}`,
        );
      }
      previousNonTtmEnd = period.end;
    }
    byId.set(period.id, period);
    previousEnd = period.end;
    previousClass = rank;
  }

  const ordered = all.filter((period) => period.cls !== "ttm");
  const position = new Map(all.map((period, index) => [period.id, index]));
  const axisIndex = new Map(ordered.map((period, index) => [period.id, index]));

  function offsetIndexOf(periodId: string): number {
    return axisIndex.get(periodId) ?? -1;
  }

  function at(periodId: string, offset: number): Period | undefined {
    const index = offsetIndexOf(periodId);
    if (index < 0) return undefined;
    return ordered[index + offset];
  }

  function range(periodId: string, from: number, to: number): Period[] {
    if (from > to) return [];
    const result: Period[] = [];
    for (let offset = from; offset <= to; offset += 1) {
      const period = at(periodId, offset);
      if (!period) return [];
      result.push(period);
    }
    return result;
  }

  return {
    all,
    ordered,
    positionOf: (periodId) => position.get(periodId) ?? -1,
    offsetIndexOf,
    at,
    range,
    get: (periodId) => byId.get(periodId),
  };
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}
