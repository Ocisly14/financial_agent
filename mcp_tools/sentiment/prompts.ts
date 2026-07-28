import type { SentiScoreResult } from "./sentiscoreClient.ts";
import type { FearGreedAnalysis } from "./fearGreedClient.ts";
import { SOURCES } from "./sentiscoreClient.ts";

const CATEGORY_LABELS: Record<string, string> = {
  "Crypto News": "Crypto News",
  "KOL": "KOL",
  "Macro": "Macro",
  "Social Media": "Social Media",
};

type Category = "Crypto News" | "KOL" | "Macro" | "Social Media";

function formatStat(label: string, stat: { value: number; observationCount: number; trend: number; std: number }): string {
  return `${label}: ${stat.value.toFixed(3)} (n=${stat.observationCount}, trend=${stat.trend.toFixed(3)}/day, std=${stat.std.toFixed(3)})`;
}

function buildSourceCatalog(): string {
  return SOURCES.map((s) =>
    `  ${s.name} [${s.category}, weight=${s.weight}, ${s.assetAgnostic ? "macro" : "asset-specific"}]: ${s.description}`
  ).join("\n");
}

function buildCategoryBreakdown(result: SentiScoreResult): string {
  const categories: Category[] = ["Crypto News", "KOL", "Macro", "Social Media"];
  const lines: string[] = [];

  for (const cat of categories) {
    const members = SOURCES.filter((s) => s.category === cat);
    const memberNames = members.map((s) => s.name);
    const sourceStats = memberNames
      .filter((name) => name in result.perSource)
      .map((name) => {
        const stats = result.perSource[name]!;
        const cfg = SOURCES.find((s) => s.name === name)!;
        return `    - ${name} (weight=${cfg.weight}): 24h=${stats.h24.value.toFixed(3)} (n=${stats.h24.observationCount}), 7d=${stats.h7d.value.toFixed(3)}, 30d=${stats.h30d.value.toFixed(3)}`;
      });

    if (sourceStats.length === 0) continue;

    // Category aggregate (source-weight-averaged)
    const validMembers = memberNames.filter((n) => n in result.perSource && result.perSource[n]!.h24.observationCount > 0);
    const totalWeight = validMembers.reduce((s, n) => s + (SOURCES.find((c) => c.name === n)?.weight ?? 1), 0);
    const cat24 = totalWeight > 0
      ? validMembers.reduce((s, n) => {
          const w = SOURCES.find((c) => c.name === n)?.weight ?? 1;
          return s + result.perSource[n]!.h24.value * w;
        }, 0) / totalWeight
      : null;

    lines.push(`  ${CATEGORY_LABELS[cat]}:`);
    if (cat24 !== null) lines.push(`    category 24h aggregate: ${cat24.toFixed(3)}`);
    lines.push(...sourceStats);
  }

  return lines.join("\n");
}

function buildDivergenceSection(result: SentiScoreResult): string {
  const { divergence } = result.features;
  const lines: string[] = [];
  for (const [key, label] of [["h24", "24h"], ["h7d", "7d"], ["h30d", "30d"]] as const) {
    const d = divergence[key];
    const topPos = d.topPositive.map((p) => `${p.source}=${p.value.toFixed(3)}`).join(", ");
    const topNeg = d.topNegative.map((p) => `${p.source}=${p.value.toFixed(3)}`).join(", ");
    lines.push(`  ${label}: range=${d.range.toFixed(3)}, spread(std)=${d.spread.toFixed(3)}`);
    lines.push(`    top positive: ${topPos || "n/a"}`);
    lines.push(`    top negative: ${topNeg || "n/a"}`);
  }
  return lines.join("\n");
}

function buildMacroVsAssetSection(result: SentiScoreResult): string {
  const { macroVsAsset } = result.features;
  return [
    `  24h: asset=${macroVsAsset.h24.assetValue.toFixed(3)}, macro=${macroVsAsset.h24.macroValue.toFixed(3)}, delta=${macroVsAsset.h24.delta.toFixed(3)}`,
    `  7d:  asset=${macroVsAsset.h7d.assetValue.toFixed(3)}, macro=${macroVsAsset.h7d.macroValue.toFixed(3)}, delta=${macroVsAsset.h7d.delta.toFixed(3)}`,
    `  30d: asset=${macroVsAsset.h30d.assetValue.toFixed(3)}, macro=${macroVsAsset.h30d.macroValue.toFixed(3)}, delta=${macroVsAsset.h30d.delta.toFixed(3)}`,
  ].join("\n");
}

const SYSTEM_PROMPT = `You are a senior crypto sentiment analyst writing for traders and investors. You receive ONLY structured statistics — no charts, no raw article text. Produce a detailed sentiment report in the exact Markdown structure below.

REFERENCE THRESHOLDS:
- SentiScore values are in [-1, +1]. |value| < 0.2 is neutral, 0.2 to 0.6 is directional, >= 0.6 is extreme.
- Trend/change magnitude: < 0.02/day is small, 0.02 to 0.08 is moderate, >= 0.08 is large.
- Volatility (std): < 0.08 is low, 0.08 to 0.20 is moderate, >= 0.20 is high.
- Baseline deviation: |sigma| < 1 is within normal range, |sigma| >= 1 is notable, |sigma| >= 2 is extreme.
- Divergence range >= 0.4 indicates meaningful cross-source disagreement.

SOURCE CATEGORIES:
- Crypto News: crypto-focused news outlets.
- KOL: research analysts, X influencers, YouTube, podcast creators.
- Macro: crypto policy, broad macro/financial news.
- Social Media: Reddit, general X posts.

NARRATIVE RULES:
- Use only source/statistical evidence in the payload.
- Do not invent external events, headlines, market prices, or named news catalysts.
- Never cite a chart. Never use "bullish" or "bearish" without a supporting number.
- When a category has no data, state "insufficient data" for that category.
- Keep every requested bullet present with one concise but analytical sentence.
- Preserve exact section titles and bullet labels.

OUTPUT FORMAT (strict):
# Detailed Sentiment Report: <ASSET>

## 1. TL;DR
- Current sentiment bias:
- Change over the last 24 hours:
- Main positive drivers:
- Main negative drivers:
- Final interpretation:

## 2. Aggregate SentiScore Trend

### 24h
- Current SentiScore:
- 24h trend (slope):
- 24h volatility (std):
- 24h observation count:

### 7d
- 7d SentiScore:
- 7d trend:
- 7d volatility:

### 30d
- 30d SentiScore:
- 30d trend:
- 30d volatility:

### Cross-period interpretation
- Short-term vs medium-term momentum:
- Medium-term vs long-term trend:
- Overall directional bias:

## 3. Sentiment Breakdown by Category

### Crypto News
- 24h score:
- 7d score:
- 30d score:
- Interpretation:

### KOL
- 24h score:
- 7d score:
- 30d score:
- Interpretation:

### Macro
- 24h score:
- 7d score:
- 30d score:
- Interpretation:

### Social Media
- 24h score:
- 7d score:
- 30d score:
- Interpretation:

## 4. Source Divergence
- 24h divergence (range, spread):
- 7d divergence:
- 30d divergence:
- Most bullish source (24h):
- Most bearish source (24h):
- Are sources broadly aligned or divergent?

## 5. Macro vs Asset-Specific Sentiment
- 24h macro vs asset delta:
- 7d macro vs asset delta:
- 30d macro vs asset delta:
- Interpretation:

## 6. Baseline Deviation
- Sigma from 30d baseline:
- Statistical significance:

## 7. Narrative Drivers
### Bullish narratives
1.
2.
3.

### Bearish narratives
1.
2.
3.

## 8. Market Interpretation
- What the sentiment shift suggests:
- Whether retail sentiment confirms or conflicts with KOL/professional narratives:
- Whether macro conditions reinforce or contradict asset-specific sentiment:

## 9. Forward Outlook
- Bullish confirmation to watch:
- Bearish warning signs:
- Final sentiment stance:

<LOCALE_NOTE>`;

export function buildSentiscorePrompt(
  symbol: string,
  fromDate: string,
  toDate: string,
  result: SentiScoreResult,
  locale: "en" | "zh-CN" = "en",
): string {
  const { horizons, features } = result;

  const localeNote = locale === "zh-CN"
    ? "Respond in Simplified Chinese, but keep the Markdown section titles and bullet labels exactly as written above."
    : "Respond in English.";

  const system = SYSTEM_PROMPT
    .replace(/<ASSET>/g, symbol)
    .replace(/<LOCALE_NOTE>/g, localeNote);

  const payload = `SENTIMENT DATA FOR ${symbol} (${fromDate} to ${toDate})

SOURCE CATALOG:
${buildSourceCatalog()}

AGGREGATE HORIZONS (source-quality-weight-averaged, aligned with 2.0 fuseHourly):
${formatStat("24h", horizons.h24)}
${formatStat("7d",  horizons.h7d)}
${formatStat("30d", horizons.h30d)}

CATEGORY BREAKDOWN (per-source, per-horizon):
${buildCategoryBreakdown(result)}

SOURCE DIVERGENCE (range = max-min, spread = std of source values):
${buildDivergenceSection(result)}

MACRO VS ASSET-SPECIFIC (source-weight-averaged):
${buildMacroVsAssetSection(result)}

FEATURES:
  Baseline deviation: ${features.baselineDeviationSigma.toFixed(2)} sigma from 30d mean
  Excluded sources: ${features.excludedSources.length > 0 ? features.excludedSources.join(", ") : "none"}

Use only the values above. Cite numeric values. Do not fabricate readings.`;

  return `${system}\n\n---\n\n${payload}`;
}

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
