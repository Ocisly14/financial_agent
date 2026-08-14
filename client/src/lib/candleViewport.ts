/**
 * Which slice of a candle series is on screen.
 *
 * Zoom is not a separate rendering mode: `CandleScope` spreads whatever candles it is given
 * across the plot, so showing fewer of them *is* zooming in. All this module does is decide
 * which ones.
 *
 * `pinned` exists because "at the right edge" and "somewhere in the middle" want opposite
 * behaviour when a new candle arrives. A window watching the live edge must follow it; a window
 * the user dragged back to read history must not slide out from under them. Storing only a start
 * index gets the second right and the first wrong, and storing only an offset from the end gets
 * the first right and the second wrong — so the distinction is recorded rather than inferred.
 *
 * `null` means "not zoomed": the whole series, always following. It is a distinct state from a
 * viewport that happens to span everything, which is what makes double-click-to-reset a matter
 * of dropping state rather than recomputing it.
 */

export interface CandleViewport {
  /** First visible candle, used when the window is not pinned to the live edge. */
  startIndex: number;
  visibleCount: number;
  /** Whether the window tracks the newest candle as the series grows. */
  pinned: boolean;
}

/** Below this the chart stops being a chart and becomes a handful of rectangles. */
export const MIN_VISIBLE_CANDLES = 15;

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

export function resolveViewport(vp: CandleViewport | null, total: number): { start: number; end: number } {
  if (total <= 0) return { start: 0, end: 0 };
  if (!vp) return { start: 0, end: total };

  const count = clamp(Math.round(vp.visibleCount), Math.min(MIN_VISIBLE_CANDLES, total), total);
  if (vp.pinned) return { start: total - count, end: total };

  const start = clamp(Math.round(vp.startIndex), 0, total - count);
  return { start, end: start + count };
}

/** Build a viewport from a resolved window, re-deriving whether it sits at the live edge. */
function fromWindow(start: number, count: number, total: number): CandleViewport {
  const visibleCount = clamp(Math.round(count), Math.min(MIN_VISIBLE_CANDLES, total), Math.max(total, 1));
  const startIndex = clamp(Math.round(start), 0, Math.max(0, total - visibleCount));
  return { startIndex, visibleCount, pinned: startIndex + visibleCount >= total };
}

/**
 * Scale the window by `factor` (below 1 zooms in), holding the candle at `anchorRatio` — the
 * pointer's position across the plot, 0 at the left edge and 1 at the right — in place.
 */
export function zoomViewport(
  vp: CandleViewport | null,
  total: number,
  factor: number,
  anchorRatio: number,
): CandleViewport {
  const { start, end } = resolveViewport(vp, total);
  const visible = end - start;
  const anchorIndex = start + anchorRatio * visible;

  // Not clamped here: fromWindow is the one place the floor and the ceiling are applied.
  const nextCount = visible * factor;
  return fromWindow(anchorIndex - anchorRatio * nextCount, nextCount, total);
}

/** Slide the window; positive moves towards newer candles. */
export function panViewport(
  vp: CandleViewport | null,
  total: number,
  deltaCandles: number,
): CandleViewport {
  const { start, end } = resolveViewport(vp, total);
  return fromWindow(start + deltaCandles, end - start, total);
}
