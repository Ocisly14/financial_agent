/**
 * Presentation-side helpers for the overlay comparison chart.
 *
 * The normalization maths lives in `overlayNormalize.ts` and is not repeated
 * here. What this file owns is the small set of *decisions* the renderer has
 * to make that are still pure enough to reason about (and test) without a
 * React runtime: which colour a line gets, how a base date is printed, how a
 * stored range degrades, and how a brushed pixel window becomes an axis
 * window. The client has no React test runner, so anything that can live
 * outside a component does.
 */

import { DEFAULT_STOCK_RANGE, parseStockRange, type StockRange } from "./stockChart.ts";

/**
 * The categorical ramp, by reference. These resolve to `--series-1..6`, which
 * are declared once per theme in `index.css` — the component never states a
 * colour value, so a theme switch re-points every line without the chart
 * knowing a theme exists.
 *
 * Six entries, matching the overlay cap of six symbols (design §2). There is
 * deliberately no modulo fallback consumer-side beyond `seriesColor`: a
 * seventh line would reuse the first line's colour, which reads as "these two
 * are the same series".
 */
export const SERIES_COLORS = [
    "var(--series-1)",
    "var(--series-2)",
    "var(--series-3)",
    "var(--series-4)",
    "var(--series-5)",
    "var(--series-6)",
] as const;

/** Colour for the nth line. Wraps, but the overlay spec caps inputs at six. */
export function seriesColor(index: number): string {
    return SERIES_COLORS[index % SERIES_COLORS.length]!;
}

/**
 * The label an overlay tab shows: `AAPL+NVDA`. Joined rather than abbreviated
 * because the point of the tab is knowing what is being compared — a tab
 * reading "Overlay" would force a click to find out.
 */
export function overlayTabLabel(symbols: string[]): string {
    return symbols.join("+");
}

/**
 * An overlay's range comes out of durable storage as a plain string, so it may
 * hold a value this build no longer knows. Degrade to the default rather than
 * throw — same contract as `storedRange` in `topicCharts.ts`.
 */
export function resolveOverlayRange(value: number): StockRange {
    return parseStockRange(value) ?? DEFAULT_STOCK_RANGE;
}

/**
 * Trims an ISO timestamp down to its calendar date for the basis label.
 *
 * The basis line answers "rebased from when", and for that question the clock
 * time is noise: intraday bars would make the label flicker on every zoom
 * nudge while conveying nothing a reader of a comparison chart acts on.
 */
export function formatBaseDate(timestamp: string): string {
    return timestamp.slice(0, 10);
}

/**
 * Round gridline values stepping through a normalized domain.
 *
 * Kept separate from the near-identical helper inside
 * `FinancialChartRenderer` rather than shared: that one calibrates raw
 * indicator values of unknown magnitude, this one always works on a
 * normalization output whose useful steps are small and known (a percent
 * change or an index around 100). Merging them would mean one function
 * carrying both sets of assumptions, and the study pane is not a file this
 * feature should be reaching into.
 */
export function overlayValueTicks(minValue: number, maxValue: number, target = 4): number[] {
    const span = maxValue - minValue;
    if (!(span > 0)) return [];
    const magnitude = 10 ** Math.floor(Math.log10(span / target));
    // Pick the nice step that actually lands closest to `target` lines, rather
    // than the smallest one at or above the ideal width. The ladder's gaps are
    // wide at the top (10 → 20 → 25), so a strict ceiling can double the step
    // over a rounding hair and leave a chart with two gridlines, one of which
    // is the baseline it already draws. Counting is the thing being asked for,
    // so count it. Ties go to the wider step: fewer lines over more.
    const step = [1, 2, 2.5, 5, 10]
        .map((multiple) => multiple * magnitude)
        .reduce((best, candidate) =>
            Math.abs(countTicks(minValue, maxValue, candidate) - target)
                <= Math.abs(countTicks(minValue, maxValue, best) - target)
                ? candidate
                : best,
        );
    const ticks: number[] = [];
    for (let index = Math.ceil(minValue / step); index * step <= maxValue; index++) {
        ticks.push(Number((index * step).toPrecision(12)));
    }
    return ticks;
}

/** How many multiples of `step` fall inside the domain. */
function countTicks(minValue: number, maxValue: number, step: number): number {
    return Math.floor(maxValue / step) - Math.ceil(minValue / step) + 1;
}

/**
 * Prints a normalized reading in the mode's own convention: `+18.3%` for a
 * percent change (the sign is explicit — an unsigned "18.3%" on a comparison
 * chart is ambiguous about direction), `118.3` for an index.
 */
export function formatOverlayValue(value: number, mode: "pct" | "index100"): string {
    if (mode === "index100") return value.toFixed(1);
    return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

/**
 * Turns a horizontal brush over the plot into an axis window.
 *
 * `fromFraction`/`toFraction` are positions across the plot in 0..1, in the
 * order they were dragged (either direction). The result is a pair of axis
 * timestamps, snapped outward to real axis points — snapping outward rather
 * than to the nearest point means a brush never excludes a bar the user's
 * selection visibly covered.
 *
 * Returns `null` when the selection is too thin to be a deliberate zoom (fewer
 * than two axis points survive), so an accidental click-drag of a few pixels
 * leaves the chart alone instead of collapsing it to a single date.
 */
export function brushToWindow(
    axis: string[],
    fromFraction: number,
    toFraction: number,
): { from: string; to: string } | null {
    if (axis.length < 2) return null;
    const low = Math.min(fromFraction, toFraction);
    const high = Math.max(fromFraction, toFraction);
    const lastIndex = axis.length - 1;
    const startIndex = Math.max(0, Math.min(lastIndex, Math.floor(low * lastIndex)));
    const endIndex = Math.max(0, Math.min(lastIndex, Math.ceil(high * lastIndex)));
    if (endIndex - startIndex < 1) return null;
    return { from: axis[startIndex]!, to: axis[endIndex]! };
}
