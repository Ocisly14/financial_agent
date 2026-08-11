/** Below this the chart stops being readable and becomes decoration. */
export const MIN_CHART_WIDTH = 360;
/** Prose below ~480px wraps every sentence and a research note reads as a chat log. */
export const MIN_CONVERSATION_WIDTH = 480;
export const DEFAULT_CHART_RATIO = 0.46;

export type SplitConstraints = { totalWidth: number; railWidth: number };

function available({ totalWidth, railWidth }: SplitConstraints): number {
    return Math.max(0, totalWidth - railWidth);
}

/** Whether both panes can meet their minimums side by side. */
export function chartFits(constraints: SplitConstraints): boolean {
    return available(constraints) >= MIN_CHART_WIDTH + MIN_CONVERSATION_WIDTH;
}

/**
 * Clamp a stored ratio against the live container. Returns 0 when the chart
 * cannot fit at all — the caller renders a single column, which is a stable
 * state and not a degraded one.
 */
export function clampChartRatio(ratio: number, constraints: SplitConstraints): number {
    if (!chartFits(constraints)) return 0;
    const width = available(constraints);
    const safe = Number.isFinite(ratio) ? ratio : DEFAULT_CHART_RATIO;
    return Math.min(Math.max(safe, MIN_CHART_WIDTH / width), 1 - MIN_CONVERSATION_WIDTH / width);
}
