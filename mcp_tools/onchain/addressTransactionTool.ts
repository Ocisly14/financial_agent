import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { JsonObject } from "../../src/framework/types.ts";
import type { RegisteredTool } from "../toolRegistry.ts";
import { fetchCoinMetrics } from "./coinmetricsClient.ts";
import { dateRange } from "../shared/dateUtils.ts";
import { envOptional } from "../config.ts";
import { ADDRESS_TRANSACTION_PROMPT } from "./prompts.ts";
import { cryptoInfo } from "./analysisHelpers.ts";
import { renderAnalysisDashboardHtml, safeChartFilename, type ChartPanel } from "../chart/analysisChartRenderer.ts";

const SYMBOL_TO_ASSET: Record<string, string> = {
  BTC: "btc",
  ETH: "eth",
  SOL: "sol",
};

function detectSymbol(task: string, inputSymbol?: string): string {
  if (inputSymbol) return inputSymbol.toUpperCase();
  const upper = task.toUpperCase();
  for (const sym of ["ETH", "SOL", "BTC"]) {
    if (upper.includes(sym)) return sym;
  }
  return "BTC";
}

function toAssetName(symbol: string): string {
  return SYMBOL_TO_ASSET[symbol.toUpperCase()] ?? symbol.toLowerCase();
}

function calcTrend(values: number[]): number {
  if (values.length < 2) return 0;
  const first = values[0]!;
  const last = values[values.length - 1]!;
  if (first === 0) return 0;
  return ((last - first) / first) * 100;
}

function metricLabel(metric: string): string {
  return metric === "AdrActCnt" ? "Active Address Count" : "Transaction Count";
}

function summarizeMetric(points: { time: string; value: number }[], metric: string) {
  const values = points.map((point) => point.value);
  const firstValue = values[0] ?? 0;
  const lastValue = values[values.length - 1] ?? 0;
  const averageValue = values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  const changePercent = firstValue > 0 ? ((lastValue - firstValue) / firstValue) * 100 : 0;
  const trend = changePercent > 5 ? "INCREASING" : changePercent < -5 ? "DECREASING" : "STABLE";
  return {
    metric,
    metricName: metricLabel(metric),
    latestData: points[points.length - 1] ?? null,
    historicalData: points,
    analysis: {
      dataPoints: points.length,
      startDate: points[0]?.time?.slice(0, 10) ?? null,
      endDate: points[points.length - 1]?.time?.slice(0, 10) ?? null,
      averageValue,
      firstValue,
      lastValue,
      trend,
      changePercent,
      source: "CoinMetrics Community API",
    },
    chartData: {
      labels: points.map((point) => point.time.slice(0, 10)),
      values,
      metricValues: values,
    },
  };
}

const VALID_METRICS = ["TxCnt", "AdrActCnt"] as const;
type ValidMetric = typeof VALID_METRICS[number];

export function createAddressTransactionTool(): RegisteredTool {
  return {
    name: "address_transaction_data",
    description:
      "Fetch on-chain transaction count and active address data from the CoinMetrics community API to gauge network activity.",
    category: "non_trading",
    inputSchema: {
      type: "object",
      required: ["task"],
      properties: {
        task: {
          type: "string",
          description: "Natural-language request for on-chain address and transaction data.",
        },
        symbol: {
          type: "string",
          description: "Asset symbol (e.g. BTC, ETH, SOL). Detected from task if omitted.",
        },
        from: {
          type: "string",
          description: "Optional start date in YYYY-MM-DD format.",
        },
        to: {
          type: "string",
          description: "Optional end date in YYYY-MM-DD format.",
        },
        metric: {
          type: "string",
          enum: ["TxCnt", "AdrActCnt"],
          description: "Primary metric to focus on. Defaults to TxCnt.",
        },
      },
    },
    execute: async (input: JsonObject) => {
      const task = (input.task as string) ?? "";
      const symbol = detectSymbol(task, input.symbol ? String(input.symbol) : undefined);
      const asset = toAssetName(symbol);
      const { from, to } = dateRange(
        input.from ? String(input.from) : undefined,
        input.to ? String(input.to) : undefined,
        30,
      );

      const rawMetric = (input.metric as string) ?? "TxCnt";
      const metric: ValidMetric = VALID_METRICS.includes(rawMetric as ValidMetric)
        ? (rawMetric as ValidMetric)
        : "TxCnt";

      // Always fetch both metrics; deduplicate if metric is AdrActCnt
      const metricsToFetch = metric === "AdrActCnt" ? ["AdrActCnt", "TxCnt"] : ["TxCnt", "AdrActCnt"];

      let allSeries: Awaited<ReturnType<typeof fetchCoinMetrics>>;
      try {
        allSeries = await fetchCoinMetrics(asset, metricsToFetch, from, to);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          summary: `On-chain data unavailable for ${symbol}: ${message}`,
          generation_context: {
            prompt: ADDRESS_TRANSACTION_PROMPT + "\n\nDATA: unavailable",
            data: { symbol, from, to, error: message },
          },
        };
      }

      const txSeries = allSeries.find((s) => s.metric === "TxCnt");
      const adrSeries = allSeries.find((s) => s.metric === "AdrActCnt");

      const txPoints = txSeries?.points ?? [];
      const adrPoints = adrSeries?.points ?? [];

      const txSummary = summarizeMetric(txPoints, "TxCnt");
      const adrSummary = summarizeMetric(adrPoints, "AdrActCnt");
      const primarySummary = metric === "AdrActCnt" ? adrSummary : txSummary;

      const contextData: JsonObject = {
        symbol,
        asset,
        assetInfo: cryptoInfo(symbol),
        from,
        to,
        metric,
        metricName: metricLabel(metric),
        latestData: primarySummary.latestData,
        historicalData: primarySummary.historicalData,
        analysis: primarySummary.analysis,
        chartData: primarySummary.chartData,
        metrics: {
          TxCnt: txSummary,
          AdrActCnt: adrSummary,
        },
        latestTxCnt: Number(txSummary.analysis.lastValue),
        latestAdrActCnt: Number(adrSummary.analysis.lastValue),
        txCntTrend: calcTrend(txPoints.map((p) => p.value)),
        adrActCntTrend: calcTrend(adrPoints.map((p) => p.value)),
      } as unknown as JsonObject;

      const prompt =
        ADDRESS_TRANSACTION_PROMPT + "\n\nSUMMARY:\n" + JSON.stringify(contextData, null, 2);

      const chartData = primarySummary.chartData as { labels: string[]; values: number[] };
      const isAddressMetric = metric === "AdrActCnt";
      const chartColor = isAddressMetric ? "rgba(52, 211, 153, 0.95)" : "rgba(56, 189, 248, 0.95)";

      const panels: ChartPanel[] = [
        {
          title: primarySummary.metricName,
          labels: chartData.labels,
          datasets: [
            { label: primarySummary.metricName, data: chartData.values, color: chartColor, fill: true },
          ],
          yTitle: primarySummary.metricName,
          yFormat: "compact",
        },
      ];

      const html = renderAnalysisDashboardHtml({
        title: `${symbol} ${primarySummary.metricName}`,
        subtitle: `${from} — ${to}`,
        statCards: [
          { label: "Latest Value", value: Number(primarySummary.analysis.lastValue).toLocaleString(undefined, { maximumFractionDigits: 0 }) },
          { label: "Average", value: Number(primarySummary.analysis.averageValue).toLocaleString(undefined, { maximumFractionDigits: 0 }) },
          { label: "Trend", value: `${primarySummary.analysis.trend} (${primarySummary.analysis.changePercent.toFixed(1)}%)` },
        ],
        panels,
      });

      let artifacts: { type: "chart"; ref: string; label: string }[] | undefined;
      try {
        const outputDir = resolve(envOptional("CHART_OUTPUT_DIR", "./charts"));
        const filename = safeChartFilename(
          isAddressMetric ? "Active Address Chart" : "Transaction Count Chart",
          symbol,
          from,
          to,
        );
        const filePath = join(outputDir, filename);
        await mkdir(outputDir, { recursive: true });
        await writeFile(filePath, html, "utf8");
        artifacts = [{ type: "chart", ref: filePath, label: `${symbol} ${primarySummary.metricName} chart ${from} to ${to}` }];
      } catch {
        // Chart generation is best-effort; analysis still returns without it.
      }

      return {
        summary: `On-chain data for ${symbol}: TxCnt=${txSummary.analysis.lastValue}, Active Addresses=${adrSummary.analysis.lastValue}. Period: ${from} to ${to}.`,
        generation_context: {
          prompt,
          data: contextData,
        },
        ...(artifacts ? { artifacts } : {}),
      };
    },
  };
}
