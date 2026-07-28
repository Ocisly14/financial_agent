import type { TrendSummary, SupportResistance } from "./indicators.ts";

export function buildTechnicalAnalysisPrompt(
  symbol: string,
  trend: TrendSummary,
  sr: SupportResistance,
): string {
  return `You are writing a Technical Analysis section for ${symbol}.

INDICATOR DATA (raw values — you interpret them):
SMA(20/50/200): ${trend.sma20} / ${trend.sma50} / ${trend.sma200}
EMA(12/26): ${trend.ema12} / ${trend.ema26}
RSI(14): ${trend.rsi14}
MACD: ${trend.macdValue} | Signal: ${trend.macdSignal} | Histogram: ${trend.macdHistogram}
Bollinger Bands: Upper=${trend.bb_upper} Middle=${trend.bb_middle} Lower=${trend.bb_lower} %B=${trend.bb_pctB.toFixed(2)}
ATR(14): ${trend.atr14}
OBV 10-bar change: ${(trend.obvChangePct * 100).toFixed(2)}%
VWAP: ${trend.vwap}
Support levels: ${sr.support.join(", ")}
Resistance levels: ${sr.resistance.join(", ")}

Write a structured technical analysis covering:
1. **Trend**: Judge direction and strength yourself from MA alignment (close vs SMA20/50/200) and momentum.
2. **Momentum**: Interpret the RSI reading (e.g. overbought/oversold) and MACD crossover/divergence yourself.
3. **Volatility**: Bollinger Band context — is price at upper/lower band? ATR in context.
4. **Support & Resistance**: Which levels are most significant?
5. **Volume**: Read the OBV 10-bar change and VWAP — are buyers/sellers in control?
6. **Thesis & Invalidation**: State the primary technical thesis (1 sentence) and what would invalidate it.

Use ONLY the indicator values above. Do not invent levels or patterns not present in the data.`;
}
