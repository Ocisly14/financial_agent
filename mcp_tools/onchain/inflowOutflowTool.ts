import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { JsonObject } from "../../src/framework/types.ts";
import type { RegisteredTool } from "../toolRegistry.ts";
import { fetchBidAskHistory } from "../shared/coinglassClient.ts";
import { dateRange } from "../shared/dateUtils.ts";
import { envOptional } from "../config.ts";
import { INFLOW_OUTFLOW_PROMPT } from "./prompts.ts";
import { buildInflowOutflowContext } from "./analysisHelpers.ts";
import { renderAnalysisDashboardHtml, safeChartFilename, type ChartPanel } from "../chart/analysisChartRenderer.ts";

function detectSymbol(task: string, inputSymbol?: string): string {
  if (inputSymbol) return inputSymbol.toUpperCase();
  const upper = task.toUpperCase();
  for (const sym of ["ETH", "SOL", "BNB", "XRP", "DOGE", "ADA", "AVAX", "DOT", "LINK", "BTC"]) {
    if (upper.includes(sym)) return sym;
  }
  return "BTC";
}

export function createInflowOutflowTool(): RegisteredTool {
  return {
    name: "inflow_outflow_analysis",
    description:
      "Analyze inflow and outflow pressure for a crypto asset using bid/ask order book history from CoinGlass.",
    category: "non_trading",
    inputSchema: {
      type: "object",
      required: ["task"],
      properties: {
        task: {
          type: "string",
          description: "Natural-language request for inflow/outflow analysis.",
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
          summary: `Inflow/Outflow data unavailable for ${symbol}: ${message}`,
          generation_context: {
            prompt: INFLOW_OUTFLOW_PROMPT + "\n\nDATA: unavailable",
            data: { symbol, from, to, error: message },
          },
        };
      }
      const contextData = buildInflowOutflowContext(
        symbol,
        from,
        to,
        raw as Record<string, unknown>[],
      ) as unknown as JsonObject;
      const latestData = contextData.latestData as Record<string, unknown>;
      const analysis = contextData.analysis as Record<string, unknown>;
      const latestBidsUsd = Number(latestData.aggregated_bids_usd ?? 0);
      const latestAsksUsd = Number(latestData.aggregated_asks_usd ?? 0);
      const inflowDominance = Number(analysis.inflowDominance ?? 50);

      const prompt = INFLOW_OUTFLOW_PROMPT + "\n\nSUMMARY:\n" + JSON.stringify(contextData, null, 2);

      const chartData = contextData.chartData as {
        labels: string[];
        inflowData: number[];
        outflowData: number[];
        liquidityData: number[];
        dominanceData: number[];
        momentumData: number[];
      };

      const panels: ChartPanel[] = [
        {
          title: "Inflow vs Outflow Liquidity",
          labels: chartData.labels,
          datasets: [
            { label: "Inflow (Bids, $M)", data: chartData.inflowData, color: "rgba(52, 211, 153, 0.95)" },
            { label: "Outflow (Asks, $M)", data: chartData.outflowData, color: "rgba(248, 113, 113, 0.95)" },
          ],
          yTitle: "USD (Millions)",
          yFormat: "usd_millions",
        },
        {
          title: "Inflow Dominance & Flow Momentum",
          labels: chartData.labels,
          datasets: [
            { label: "Inflow Dominance %", data: chartData.dominanceData, color: "rgba(56, 189, 248, 0.95)", yAxisID: "y" },
            { label: "Flow Momentum", data: chartData.momentumData, color: "rgba(167, 139, 250, 0.95)", yAxisID: "y1" },
          ],
          yTitle: "Dominance (%)",
          y1Title: "Momentum",
          yFormat: "percent",
          y1Format: "number",
        },
        {
          title: "Total Liquidity Trend",
          labels: chartData.labels,
          datasets: [
            { label: "Total Liquidity ($M)", data: chartData.liquidityData, color: "rgba(129, 140, 248, 0.95)", type: "bar" },
          ],
          yTitle: "USD (Millions)",
          yFormat: "usd_millions",
        },
      ];

      const html = renderAnalysisDashboardHtml({
        title: `${symbol} Inflow/Outflow Analysis`,
        subtitle: `${from} — ${to}`,
        statCards: [
          { label: "Inflow Dominance", value: `${inflowDominance.toFixed(1)}%` },
          { label: "Bids (Inflow)", value: `$${latestBidsUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}` },
          { label: "Asks (Outflow)", value: `$${latestAsksUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}` },
          { label: "Market Sentiment", value: String(analysis.marketSentiment ?? "") },
        ],
        panels,
      });

      let artifacts: { type: "chart"; ref: string; label: string }[] | undefined;
      try {
        const outputDir = resolve(envOptional("CHART_OUTPUT_DIR", "./charts"));
        const filename = safeChartFilename("Inflow Outflow Chart", symbol, from, to);
        const filePath = join(outputDir, filename);
        await mkdir(outputDir, { recursive: true });
        await writeFile(filePath, html, "utf8");
        artifacts = [{ type: "chart", ref: filePath, label: `${symbol} inflow/outflow chart ${from} to ${to}` }];
      } catch {
        // Chart generation is best-effort; analysis still returns without it.
      }

      return {
        summary: `Inflow/Outflow for ${symbol}: latest bids $${latestBidsUsd.toFixed(0)} vs asks $${latestAsksUsd.toFixed(0)}. Inflow dominance: ${inflowDominance.toFixed(1)}%.`,
        generation_context: {
          prompt,
          data: contextData,
        },
        ...(artifacts ? { artifacts } : {}),
      };
    },
  };
}
