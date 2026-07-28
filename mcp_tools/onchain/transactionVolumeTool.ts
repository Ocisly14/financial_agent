import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { JsonObject } from "../../src/framework/types.ts";
import type { RegisteredTool } from "../toolRegistry.ts";
import { fetchTakerVolume } from "../shared/coinglassClient.ts";
import { dateRange } from "../shared/dateUtils.ts";
import { envOptional } from "../config.ts";
import { TRANSACTION_VOLUME_PROMPT } from "./prompts.ts";
import { buildTakerVolumeContext } from "./analysisHelpers.ts";
import { renderAnalysisDashboardHtml, safeChartFilename, type ChartPanel } from "../chart/analysisChartRenderer.ts";

function detectSymbol(task: string, inputSymbol?: string): string {
  if (inputSymbol) return inputSymbol.toUpperCase();
  const upper = task.toUpperCase();
  for (const sym of ["ETH", "SOL", "BNB", "XRP", "DOGE", "ADA", "AVAX", "DOT", "LINK", "BTC"]) {
    if (upper.includes(sym)) return sym;
  }
  return "BTC";
}

export function createTransactionVolumeTool(): RegisteredTool {
  return {
    name: "transaction_volume_analysis",
    description:
      "Analyze taker buy and sell volume for a crypto asset to assess market conviction and directional momentum.",
    category: "non_trading",
    inputSchema: {
      type: "object",
      required: ["task"],
      properties: {
        task: {
          type: "string",
          description: "Natural-language request for transaction volume analysis.",
        },
        symbol: {
          type: "string",
          description: "Asset symbol (e.g. BTC, ETH). Detected from task if omitted.",
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
    },
    execute: async (input: JsonObject) => {
      const task = (input.task as string) ?? "";
      const symbol = detectSymbol(task, input.symbol ? String(input.symbol) : undefined);
      const { from, to } = dateRange(
        input.from ? String(input.from) : undefined,
        input.to ? String(input.to) : undefined,
        30,
      );

      let raw: unknown;
      try {
        raw = await fetchTakerVolume(symbol, from, to);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          summary: `Transaction volume data unavailable for ${symbol}: ${message}`,
          generation_context: {
            prompt: TRANSACTION_VOLUME_PROMPT + "\n\nDATA: unavailable",
            data: { symbol, from, to, error: message },
          },
        };
      }
      const contextData = buildTakerVolumeContext(
        symbol,
        from,
        to,
        raw as Record<string, unknown>[],
      ) as unknown as JsonObject;
      const analysis = contextData.analysis as Record<string, unknown>;
      const buyDominance = Number(analysis.buyDominance ?? 0);
      const totalVolumeUsd = Number(analysis.totalVolume ?? 0);
      const dataPoints = Number(contextData.dataPoints ?? 0);

      const prompt = TRANSACTION_VOLUME_PROMPT + "\n\nSUMMARY:\n" + JSON.stringify(contextData, null, 2);

      const chartData = contextData.chartData as {
        labels: string[];
        buyVolumeData: number[];
        sellVolumeData: number[];
        ratioData: number[];
      };

      const panels: ChartPanel[] = [
        {
          title: "Buy vs Sell Volume",
          labels: chartData.labels,
          datasets: [
            { label: "Buy Volume ($)", data: chartData.buyVolumeData, color: "rgba(52, 211, 153, 0.95)" },
            { label: "Sell Volume ($)", data: chartData.sellVolumeData, color: "rgba(248, 113, 113, 0.95)" },
          ],
          yTitle: "Volume (USD)",
          yFormat: "compact",
        },
        {
          title: "Buy/Sell Ratio",
          labels: chartData.labels,
          datasets: [
            { label: "Buy/Sell Ratio", data: chartData.ratioData, color: "rgba(56, 189, 248, 0.95)" },
          ],
          yTitle: "Ratio",
          yFormat: "number",
        },
      ];

      const html = renderAnalysisDashboardHtml({
        title: `${symbol} Transaction Volume Analysis`,
        subtitle: `${from} — ${to}`,
        statCards: [
          { label: "Buy Dominance", value: `${buyDominance.toFixed(1)}%` },
          { label: "Total Volume", value: `$${totalVolumeUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}` },
          { label: "Market Sentiment", value: String(analysis.marketSentiment ?? "") },
        ],
        panels,
      });

      let artifacts: { type: "chart"; ref: string; label: string }[] | undefined;
      try {
        const outputDir = resolve(envOptional("CHART_OUTPUT_DIR", "./charts"));
        const filename = safeChartFilename("Transaction Volume Chart", symbol, from, to);
        const filePath = join(outputDir, filename);
        await mkdir(outputDir, { recursive: true });
        await writeFile(filePath, html, "utf8");
        artifacts = [{ type: "chart", ref: filePath, label: `${symbol} transaction volume chart ${from} to ${to}` }];
      } catch {
        // Chart generation is best-effort; analysis still returns without it.
      }

      return {
        summary: `Transaction volume for ${symbol}: buy dominance ${buyDominance.toFixed(1)}%, total $${totalVolumeUsd.toFixed(0)} USD over ${dataPoints} days.`,
        generation_context: {
          prompt,
          data: contextData,
        },
        ...(artifacts ? { artifacts } : {}),
      };
    },
  };
}
