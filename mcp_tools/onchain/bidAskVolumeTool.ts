import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { JsonObject } from "../../src/framework/types.ts";
import type { RegisteredTool } from "../toolRegistry.ts";
import { fetchBidAskHistory } from "../shared/coinglassClient.ts";
import { dateRange } from "../shared/dateUtils.ts";
import { envOptional } from "../config.ts";
import { BID_ASK_VOLUME_PROMPT } from "./prompts.ts";
import { buildBidAskContext } from "./analysisHelpers.ts";
import { renderAnalysisDashboardHtml, safeChartFilename, type ChartPanel } from "../chart/analysisChartRenderer.ts";

function detectSymbol(task: string, inputSymbol?: string): string {
  if (inputSymbol) return inputSymbol.toUpperCase();
  const upper = task.toUpperCase();
  for (const sym of ["ETH", "SOL", "BNB", "XRP", "DOGE", "ADA", "AVAX", "DOT", "LINK", "BTC"]) {
    if (upper.includes(sym)) return sym;
  }
  return "BTC";
}

export function createBidAskVolumeTool(): RegisteredTool {
  return {
    name: "bid_ask_volume_analysis",
    description:
      "Analyze bid and ask volume, market depth, and spread for a crypto asset using CoinGlass order book history.",
    category: "non_trading",
    inputSchema: {
      type: "object",
      required: ["task"],
      properties: {
        task: {
          type: "string",
          description: "Natural-language request for bid/ask volume and market depth analysis.",
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
        7,
      );

      let raw: unknown;
      try {
        raw = await fetchBidAskHistory(symbol, from, to);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          summary: `Bid/Ask volume data unavailable for ${symbol}: ${message}`,
          generation_context: {
            prompt: BID_ASK_VOLUME_PROMPT + "\n\nDATA: unavailable",
            data: { symbol, from, to, error: message },
          },
        };
      }
      const contextData = buildBidAskContext(
        symbol,
        from,
        to,
        raw as Record<string, unknown>[],
      ) as unknown as JsonObject;
      const latestData = contextData.latestData as Record<string, unknown>;
      const analysis = contextData.analysis as Record<string, unknown>;
      const bidShareOfBookPct = Number(latestData.bid_usd_dominance ?? 50);
      const spreadPct = Number(analysis.spreadPercentage ?? 0);

      const prompt = BID_ASK_VOLUME_PROMPT + "\n\nSUMMARY:\n" + JSON.stringify(contextData, null, 2);

      const chartData = contextData.chartData as {
        labels: string[];
        bidVolumeData: number[];
        askVolumeData: number[];
        bidUsdData: number[];
        askUsdData: number[];
        spreadData: number[];
        depthScoreData: number[];
      };

      const panels: ChartPanel[] = [
        {
          title: "Bid vs Ask Volume",
          labels: chartData.labels,
          datasets: [
            { label: "Bid Volume", data: chartData.bidVolumeData, color: "rgba(52, 211, 153, 0.95)" },
            { label: "Ask Volume", data: chartData.askVolumeData, color: "rgba(248, 113, 113, 0.95)" },
          ],
          yTitle: "Volume",
          yFormat: "compact",
        },
        {
          title: "Bid vs Ask USD Amount",
          labels: chartData.labels,
          datasets: [
            { label: "Bid USD (M)", data: chartData.bidUsdData, color: "rgba(52, 211, 153, 0.95)", type: "bar" },
            { label: "Ask USD (M)", data: chartData.askUsdData, color: "rgba(248, 113, 113, 0.95)", type: "bar" },
          ],
          yTitle: "USD (Millions)",
          yFormat: "usd_millions",
        },
        {
          title: "Spread & Market Depth",
          labels: chartData.labels,
          datasets: [
            { label: "Spread %", data: chartData.spreadData, color: "rgba(56, 189, 248, 0.95)", yAxisID: "y" },
            { label: "Market Depth Score", data: chartData.depthScoreData, color: "rgba(129, 140, 248, 0.95)", yAxisID: "y1" },
          ],
          yTitle: "Spread (%)",
          y1Title: "Depth Score",
          yFormat: "percent",
          y1Format: "number",
        },
      ];

      const html = renderAnalysisDashboardHtml({
        title: `${symbol} Bid/Ask Volume Analysis`,
        subtitle: `${from} — ${to}`,
        statCards: [
          { label: "Spread %", value: `${spreadPct.toFixed(3)}%` },
          { label: "Bid Share", value: `${bidShareOfBookPct.toFixed(1)}%` },
          { label: "Market Sentiment", value: String(analysis.marketSentiment ?? "") },
        ],
        panels,
      });

      let artifacts: { type: "chart"; ref: string; label: string }[] | undefined;
      try {
        const outputDir = resolve(envOptional("CHART_OUTPUT_DIR", "./charts"));
        const filename = safeChartFilename("Bid Ask Volume Chart", symbol, from, to);
        const filePath = join(outputDir, filename);
        await mkdir(outputDir, { recursive: true });
        await writeFile(filePath, html, "utf8");
        artifacts = [{ type: "chart", ref: filePath, label: `${symbol} bid/ask volume chart ${from} to ${to}` }];
      } catch {
        // Chart generation is best-effort; analysis still returns without it.
      }

      return {
        summary: `Bid/Ask volume for ${symbol}: bid share ${bidShareOfBookPct.toFixed(1)}%, spread ${spreadPct.toFixed(3)}%.`,
        generation_context: {
          prompt,
          data: contextData,
        },
        ...(artifacts ? { artifacts } : {}),
      };
    },
  };
}
