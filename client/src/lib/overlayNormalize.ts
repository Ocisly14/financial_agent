/**
 * Pure normalization and alignment maths for the multi-symbol overlay chart.
 *
 * The goal is to let a viewer compare tickers that trade at wildly different
 * price levels (e.g. AAPL near $300 vs. NVDA near $150) on a single axis by
 * rebasing every line to a common starting point. Getting this wrong is
 * dangerous precisely because a bad chart still *looks* normal: nobody
 * reading it can tell a line was rebased to the wrong point, or that a gap
 * was silently filled in. See the design doc (§3.4) for the full rationale.
 *
 * Hard rules enforced here:
 *  1. Never interpolate — the axis is the INTERSECTION of every input's
 *     timestamps, never the union. A point invented to fill a gap is
 *     fabricated market data.
 *  2. A symbol whose history starts later than the others keeps its own
 *     base (its own first point in the visible window), and `baseDate`
 *     reports that honestly rather than borrowing another symbol's base.
 *  3. A zero or non-finite base drops that symbol (recorded in `dropped`)
 *     instead of producing `Infinity` or `NaN`.
 *  4. Fewer than two overlapping points yields no series at all, not a
 *     flat line — a flat line reads as "no movement", which is a
 *     different and misleading claim.
 */

export type Bar = { t: string; c: number };

export type SeriesInput = { symbol: string; bars: Bar[] };

export type NormalizeMode = "pct" | "index100";

export type NormalizedSeries = {
  symbol: string;
  points: Array<{ t: string; v: number }>;
  baseDate: string;
  baseValue: number;
};

export type OverlayResult = {
  series: NormalizedSeries[];
  axis: string[];
  dropped: string[];
};

/** Rounds away binary floating-point noise (e.g. 110.00000000000001 -> 110). */
function roundTiny(value: number): number {
  return Math.round(value * 1e9) / 1e9;
}

/** Applies the chosen normalization mode to a raw close relative to a base. */
function applyMode(value: number, base: number, mode: NormalizeMode): number {
  const raw = mode === "pct" ? (value / base - 1) * 100 : (value / base) * 100;
  return roundTiny(raw);
}

/**
 * Normalizes and aligns multiple symbols' bar series onto one shared axis.
 *
 * @param inputs Per-symbol bar series, in the order they should appear in
 *   the output (legend order must be predictable, not reshuffled).
 * @param mode `"pct"` (default reading: `+18.3%`) or `"index100"`
 *   (reading: `118.3`). The two are linear transforms of each other.
 * @param visibleFrom Optional left edge of the visible window (inclusive).
 *   When provided, timestamps before it are excluded and every symbol's
 *   base is recomputed from its first point at-or-after this edge — the
 *   base follows the visible window, matching TradingView. If this edge
 *   falls after every bar (nothing would remain), it is ignored and the
 *   full range is used instead, so zooming past the data never empties
 *   the chart.
 */
export function normalizeOverlay(
  inputs: SeriesInput[],
  mode: NormalizeMode,
  visibleFrom?: string,
): OverlayResult {
  // Drop symbols with no bars at all up front; they cannot contribute to
  // an intersection and have nothing to be based on.
  const withBars = inputs.filter((input) => input.bars.length > 0);
  const droppedNoBars = inputs
    .filter((input) => input.bars.length === 0)
    .map((input) => input.symbol);

  // Determine whether visibleFrom actually leaves any data for every
  // series; if it would wipe out the intersection entirely (i.e. it is
  // past every bar of every symbol), fall back to the full range.
  const effectiveFrom = resolveEffectiveFrom(withBars, visibleFrom);

  // Build a per-symbol map keyed by timestamp, restricted to the
  // effective window, preserving each series' own chronological order.
  const windowed = withBars.map((input) => {
    const bars = effectiveFrom
      ? input.bars.filter((bar) => bar.t >= effectiveFrom)
      : input.bars;
    return { symbol: input.symbol, bars };
  });

  const dropped: string[] = [...droppedNoBars];

  // The shared axis is defined by the symbols that carry at least two
  // bars in the effective window — a series with only a single bar can
  // never contribute to a *trend* intersection, and letting it define
  // the axis would either collapse the whole chart to one date or (worse)
  // force other symbols' genuinely-later data off the axis. A late
  // starter (e.g. an IPO with a single bar) is instead re-attached below,
  // using only the axis dates on which it actually traded — never a date
  // it didn't, and never rebased to anyone else's base.
  const axisDefiners = windowed.filter((w) => w.bars.length >= 2);
  const axis = intersectTimestamps(axisDefiners.map((w) => w.bars.map((b) => b.t)));

  if (axis.length < 2) {
    return { series: [], axis: [], dropped };
  }

  const axisSet = new Set(axis);

  const series: NormalizedSeries[] = [];
  for (const { symbol, bars } of windowed) {
    const onAxis = bars.filter((bar) => axisSet.has(bar.t));
    // A symbol may have data outside the intersection (e.g. it listed
    // later, or was missing on days others traded); its base is its own
    // first point that IS on the shared axis, never another symbol's.
    if (onAxis.length === 0) {
      dropped.push(symbol);
      continue;
    }
    const base = onAxis[0]!;
    if (!Number.isFinite(base.c) || base.c === 0) {
      dropped.push(symbol);
      continue;
    }
    const points = onAxis.map((bar) => ({
      t: bar.t,
      v: applyMode(bar.c, base.c, mode),
    }));
    series.push({
      symbol,
      points,
      baseDate: base.t,
      baseValue: base.c,
    });
  }

  if (series.length === 0) {
    return { series: [], axis: [], dropped };
  }

  return { series, axis, dropped };
}

/** Intersects several lists of timestamps, preserving sorted chronological order. */
function intersectTimestamps(lists: string[][]): string[] {
  if (lists.length === 0) return [];
  let acc = new Set(lists[0]);
  for (let i = 1; i < lists.length; i++) {
    const next = new Set(lists[i]);
    acc = new Set([...acc].filter((t) => next.has(t)));
  }
  return [...acc].sort();
}

/**
 * Decides the effective left edge of the visible window. If `visibleFrom`
 * falls after every bar in every input (i.e. the window would be entirely
 * empty), it is treated as unusable and the full range is used instead —
 * zooming past the end of the data must not empty the chart.
 */
function resolveEffectiveFrom(
  inputs: SeriesInput[],
  visibleFrom: string | undefined,
): string | undefined {
  if (!visibleFrom) return undefined;
  const isPastEveryBar = inputs.every((input) =>
    input.bars.every((bar) => bar.t < visibleFrom),
  );
  return isPastEveryBar ? undefined : visibleFrom;
}
