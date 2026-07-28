import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { JsonObject, JsonSchema, ToolExecutionResult } from "../../src/framework/types.ts";
import type { RegisteredTool } from "../toolRegistry.ts";
import { dateRange } from "../shared/dateUtils.ts";
import { cacheRawData } from "../shared/rawDataCache.ts";
import { envOptional } from "../config.ts";
import { fetchFearGreedAnalysis, type FearGreedAnalysis, type FearGreedPoint } from "./fearGreedClient.ts";
import { buildFearGreedPrompt } from "./prompts.ts";
import { renderAnalysisDashboardHtml, safeChartFilename, type ChartPanel } from "../chart/analysisChartRenderer.ts";

const SENTIMENT_BAND_COLORS: Record<FearGreedPoint["label"], string> = {
  "Extreme Fear": "rgba(248, 113, 113, 0.95)",
  "Fear": "rgba(251, 146, 60, 0.95)",
  "Neutral": "rgba(250, 204, 21, 0.95)",
  "Greed": "rgba(52, 211, 153, 0.95)",
  "Extreme Greed": "rgba(22, 163, 74, 0.95)",
};

function sentimentBandColor(label: FearGreedPoint["label"]): string {
  return SENTIMENT_BAND_COLORS[label] ?? "rgba(56, 189, 248, 0.95)";
}

function readString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function fearGreedAnalysisInputSchema(): JsonSchema {
  return {
    type: "object",
    required: ["task"],
    properties: {
      task: {
        type: "string",
        description: "Natural-language request for Fear & Greed Index analysis.",
      },
      from: {
        type: "string",
        description: "Optional start date in YYYY-MM-DD format.",
      },
      to: {
        type: "string",
        description: "Optional end date in YYYY-MM-DD format.",
      },
    },
  };
}

/** Curated subset for generation_context.data — the aggregates the prompt
 * references, without the raw `history` series (that goes to the cache). */
function curatedData(analysis: FearGreedAnalysis): JsonObject {
  return {
    current: analysis.current as unknown as JsonObject,
    trend: analysis.trend as unknown as JsonObject,
    historicalContext: analysis.historicalContext as unknown as JsonObject,
  };
}

export function createFearGreedAnalysisTool(): RegisteredTool {
  return {
    name: "fear_greed_index_analysis",
    description:
      "Fetch and analyze the crypto Fear & Greed Index from CoinMarketCap for market sentiment context.",
    category: "non_trading",
    inputSchema: fearGreedAnalysisInputSchema(),
    execute: async (input: JsonObject): Promise<ToolExecutionResult> => {
      const { from, to } = dateRange(
        readString(input.from) || undefined,
        readString(input.to) || undefined,
        30,
      );

      try {
        const analysis = await fetchFearGreedAnalysis(from, to);
        const { current, trend, historicalContext } = analysis;

        const prompt = buildFearGreedPrompt(analysis);

        const summary =
          `Fear & Greed Index: ${current.value} (${current.label}). ` +
          `Trend: ${trend.direction} over ${trend.durationDays}d. ` +
          `Percentile: ${historicalContext.percentileRank}th.`;

        // Persist full analysis (incl. raw history) to the local cache; hand the
        // generating model only the curated aggregates.
        await cacheRawData("fear_greed", `${from}_${to}`, analysis);

        const data = curatedData(analysis);

        const labels = analysis.history.map((p) =>
          new Date(p.timestamp * 1000).toISOString().slice(0, 10),
        );
        const values = analysis.history.map((p) => p.value);
        const colors = analysis.history.map((p) => sentimentBandColor(p.label));

        const panels: ChartPanel[] = [
          {
            title: "Fear & Greed Index",
            labels,
            datasets: [
              { label: "Fear & Greed Index", data: values, type: "bar", colors, fill: false },
            ],
            yTitle: "Index (0-100)",
            yFormat: "number",
          },
        ];

        const html = renderAnalysisDashboardHtml({
          title: "Crypto Fear & Greed Index",
          subtitle: `${from} — ${to}`,
          statCards: [
            { label: "Current", value: `${current.value} (${current.label})` },
            { label: "Trend", value: `${trend.direction} (${trend.durationDays}d)` },
            { label: "Percentile", value: `${historicalContext.percentileRank}th` },
          ],
          panels,
        });

        let artifacts: { type: "chart"; ref: string; label: string }[] | undefined;
        try {
          const outputDir = resolve(envOptional("CHART_OUTPUT_DIR", "./charts"));
          const filename = safeChartFilename("Fear Index Chart", "Crypto", from, to);
          const filePath = join(outputDir, filename);
          await mkdir(outputDir, { recursive: true });
          await writeFile(filePath, html, "utf8");
          artifacts = [{ type: "chart", ref: filePath, label: `Fear & Greed Index chart ${from} to ${to}` }];
        } catch {
          // Chart generation is best-effort; analysis still returns without it.
        }

        return {
          summary,
          generation_context: {
            prompt,
            data,
          },
          ...(artifacts ? { artifacts } : {}),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          summary: `Fear & Greed Index analysis failed (${from} to ${to}): ${message}`,
          generation_context: {
            prompt: `Fear & Greed Index data could not be retrieved for the period ${from} to ${to}. Error: ${message}. Do not fabricate sentiment values.`,
            data: {
              fromDate: from,
              toDate: to,
              error: message,
              status: "failed",
            } as JsonObject,
          },
        };
      }
    },
  };
}
