import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { JsonObject, ToolExecutionResult } from "../../src/framework/types.ts";
import type { RegisteredTool } from "../toolRegistry.ts";
import { fetchOhlcv } from "../shared/coinglassClient.ts";
import { envOptional } from "../config.ts";
import { buildChartData, renderChartHtml } from "./chartRenderer.ts";

const SYMBOL_PATTERN = /\b(BTC|ETH|SOL|XRP|DOGE|BNB|ADA|MATIC|LINK|AVAX|LTC|DOT)\b/i;

function detectSymbol(task: string, explicit?: unknown): string {
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim().toUpperCase();
  const m = task.match(SYMBOL_PATTERN);
  return m ? m[1]!.toUpperCase() : "BTC";
}

function detectDays(task: string, explicit?: unknown): number {
  if (typeof explicit === "number" && explicit > 0) return Math.floor(explicit);
  const m = task.match(/(\d+)\s*(day|d\b)/i);
  return m ? parseInt(m[1]!, 10) : 30;
}

function safeFilename(symbol: string, from: string, to: string): string {
  return `Price Chart ${symbol} ${from}_${to}.html`.replace(/[^a-zA-Z0-9 ._-]/g, "_");
}

export function createPriceChartTool(): RegisteredTool {
  return {
    name: "price_chart",
    description:
      "Generate an interactive HTML price chart (Chart.js) for a crypto asset using OHLCV data from CoinGlass. Saves the chart file locally and returns the file path as an artifact.",
    category: "non_trading",
    inputSchema: {
      type: "object",
      required: ["task"],
      properties: {
        task: {
          type: "string",
          description: "Natural-language request, e.g. 'Draw BTC price chart for the last 30 days'.",
        },
        symbol: {
          type: "string",
          description: "Crypto ticker (e.g. BTC, ETH). Detected from task if omitted.",
        },
        days: {
          type: "number",
          description: "Number of days of history to chart. Detected from task; defaults to 30.",
        },
        exchange: {
          type: "string",
          description: "Exchange to source OHLCV from. Defaults to Binance.",
        },
      },
    },
    execute: async (input: JsonObject): Promise<ToolExecutionResult> => {
      const task = typeof input.task === "string" ? input.task : "";
      const symbol = detectSymbol(task, input.symbol);
      const days = Math.min(Math.max(detectDays(task, input.days), 1), 365);
      const exchange = typeof input.exchange === "string" && input.exchange.trim()
        ? input.exchange.trim()
        : "Binance";

      let bars: Awaited<ReturnType<typeof fetchOhlcv>>;
      try {
        bars = await fetchOhlcv(symbol, days, exchange);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          summary: `Price chart for ${symbol} failed: could not fetch OHLCV data. ${message}`,
          generation_context: {
            prompt: `Price chart generation failed for ${symbol}. Error: ${message}`,
            data: { symbol, days, error: message },
          },
        };
      }

      if (bars.length === 0) {
        return {
          summary: `Price chart for ${symbol}: no data returned from ${exchange}.`,
          generation_context: {
            prompt: `No OHLCV data available for ${symbol} from ${exchange}.`,
            data: { symbol, days, exchange, barCount: 0 },
          },
        };
      }

      const chartData = buildChartData(bars);
      const from = chartData.dates[0] ?? "";
      const to = chartData.dates[chartData.dates.length - 1] ?? "";
      const html = renderChartHtml(symbol, from, to, chartData);

      const outputDir = resolve(envOptional("CHART_OUTPUT_DIR", "./charts"));
      const filename = safeFilename(symbol, from, to);
      const filePath = join(outputDir, filename);

      try {
        await mkdir(outputDir, { recursive: true });
        await writeFile(filePath, html, "utf8");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          summary: `Price chart for ${symbol} generated but could not be saved: ${message}`,
          generation_context: {
            prompt: `Price chart data was computed for ${symbol} (${from} to ${to}) but file write failed: ${message}`,
            data: { symbol, from, to, barCount: bars.length, error: message },
          },
        };
      }

      const pctChange = chartData.startPrice > 0
        ? (((chartData.endPrice - chartData.startPrice) / chartData.startPrice) * 100).toFixed(2)
        : "0.00";

      const data: JsonObject = {
        symbol,
        exchange,
        from,
        to,
        barCount: bars.length,
        startPrice: chartData.startPrice,
        endPrice: chartData.endPrice,
        highPrice: chartData.highPrice,
        lowPrice: chartData.lowPrice,
        pctChange: parseFloat(pctChange),
      };

      return {
        summary: `Price chart for ${symbol} (${from} to ${to}, ${bars.length} days): $${chartData.startPrice.toLocaleString()} → $${chartData.endPrice.toLocaleString()} (${parseFloat(pctChange) >= 0 ? "+" : ""}${pctChange}%).`,
        generation_context: {
          prompt: `A price chart for ${symbol} covering ${from} to ${to} (${bars.length} days) has been generated and saved. When referencing this chart, note: start price $${chartData.startPrice.toLocaleString()}, end price $${chartData.endPrice.toLocaleString()}, period high $${chartData.highPrice.toLocaleString()}, period low $${chartData.lowPrice.toLocaleString()}, change ${parseFloat(pctChange) >= 0 ? "+" : ""}${pctChange}%. Refer users to the chart artifact for the visual.`,
          data,
        },
        artifacts: [
          { type: "chart", ref: filePath, label: `${symbol} price chart ${from} to ${to}` },
        ],
      };
    },
  };
}
