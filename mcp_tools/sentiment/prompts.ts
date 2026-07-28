import type { FearGreedAnalysis } from "./fearGreedClient.ts";

export function buildFearGreedPrompt(analysis: FearGreedAnalysis): string {
  const { current, trend, historicalContext } = analysis;

  return `Use the following Fear & Greed Index data to write a Fear & Greed section.

FEAR & GREED DATA (facts only):
Current: ${current.value} (${current.label})
Trend: ${trend.direction} over ${trend.durationDays} days, volatility ${trend.volatility.toFixed(1)}
Historical context: ${historicalContext.percentileRank}th percentile (avg=${historicalContext.avg.toFixed(0)}, std=${historicalContext.std.toFixed(1)}, extreme-fear days=${historicalContext.extremeFearCount}, extreme-greed days=${historicalContext.extremeGreedCount})

Cover these points in order:
1. **Current Reading**: Value ${current.value} (${current.label}). State what this means in simple terms.
2. **Recent Trend**: Trend is ${trend.direction} over ${trend.durationDays} days with volatility ${trend.volatility.toFixed(1)}. Interpret momentum.
3. **Historical Context**: Current value sits at ${historicalContext.percentileRank}th percentile of observed history (avg=${historicalContext.avg.toFixed(0)}, std=${historicalContext.std.toFixed(1)}). Note if the reading is extreme.
4. **Your Read**: Based ONLY on the facts above (reading, trend, percentile), give your own interpretation — including whether a contrarian stance is warranted. Do not cite a pre-computed signal.

Use only the values above. Do not invent statistics.`;
}
