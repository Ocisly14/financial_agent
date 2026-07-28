import type { JsonObject, ToolExecutionResult } from "../../src/framework/types.ts";
import type { RegisteredTool } from "../toolRegistry.ts";
import { fetchOhlcv } from "../shared/coinglassClient.ts";
import { computeTrend, supportResistance } from "./indicators.ts";
import { buildTechnicalAnalysisPrompt } from "./prompts.ts";

const SYMBOL_PATTERN = /\b(BTC|ETH|SOL|XRP|DOGE|BNB|ADA)\b/i;
const DEFAULT_SYMBOL = "BTC";
const OHLCV_DAYS = 200;

function detectSymbol(task: string, explicit?: unknown): string {
  if (typeof explicit === "string" && explicit.trim().length > 0) {
    return explicit.trim().toUpperCase();
  }
  const match = task.match(SYMBOL_PATTERN);
  if (match) return match[1]!.toUpperCase();
  return DEFAULT_SYMBOL;
}

export function createTechnicalAnalysisTool(): RegisteredTool {
  return {
    name: "technical_analysis",
    description:
      "Fetch 200 days of OHLCV data for a crypto asset and compute technical indicators " +
      "(SMA, EMA, RSI, MACD, Bollinger Bands, ATR, OBV, VWAP, support/resistance). " +
      "Returns a structured analysis prompt and indicator summary for downstream LLM generation.",
    category: "non_trading",
    inputSchema: {
      type: "object",
      required: ["task"],
      properties: {
        task: {
          type: "string",
          description: "Natural-language request describing the technical analysis to perform.",
        },
        symbol: {
          type: "string",
          description:
            "Crypto symbol (e.g. BTC, ETH, SOL). Detected from task if omitted. Defaults to BTC.",
        },
        from: {
          type: "string",
          description: "Optional start date (YYYY-MM-DD). Reserved for future use.",
        },
        to: {
          type: "string",
          description: "Optional end date (YYYY-MM-DD). Reserved for future use.",
        },
      },
    },
    execute: async (input: JsonObject): Promise<ToolExecutionResult> => {
      return executeTechnicalAnalysis(input);
    },
  };
}

async function executeTechnicalAnalysis(input: JsonObject): Promise<ToolExecutionResult> {
  const task = typeof input.task === "string" ? input.task : "";
  const symbol = detectSymbol(task, input.symbol);

  let bars: Awaited<ReturnType<typeof fetchOhlcv>>;
  try {
    bars = await fetchOhlcv(symbol, OHLCV_DAYS);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      summary: `Technical analysis for ${symbol} failed: could not fetch OHLCV data. ${message}`,
      generation_context: {
        prompt: `Technical analysis for ${symbol} is unavailable. Data fetch error: ${message}`,
        data: {
          error: true,
          code: "FETCH_ERROR",
          message,
          symbol,
        },
      },
    };
  }

  if (bars.length === 0) {
    return {
      summary: `Technical analysis for ${symbol} failed: no OHLCV bars returned.`,
      generation_context: {
        prompt: `Technical analysis for ${symbol} is unavailable. No price data was returned from the data source.`,
        data: {
          error: true,
          code: "NO_DATA",
          message: "No OHLCV bars returned.",
          symbol,
        },
      },
    };
  }

  let trend: ReturnType<typeof computeTrend>;
  try {
    trend = computeTrend(bars);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      summary: `Technical analysis for ${symbol} failed: indicator computation error. ${message}`,
      generation_context: {
        prompt: `Technical analysis for ${symbol} is unavailable. Indicator error: ${message}`,
        data: {
          error: true,
          code: "INDICATOR_ERROR",
          message,
          symbol,
          barCount: bars.length,
        },
      },
    };
  }

  const closes = bars.map((b) => b.close);
  const sr = supportResistance(closes, 20);

  const prompt = buildTechnicalAnalysisPrompt(symbol, trend, sr);

  const latestClose = bars.at(-1)?.close ?? 0;

  const summary =
    `Technical indicators for ${symbol}: close=${latestClose}, ` +
    `RSI=${trend.rsi14.toFixed(1)}, MACD histogram=${trend.macdHistogram.toFixed(4)}. ` +
    `Support: ${sr.support.slice(0, 2).join("/")}, Resistance: ${sr.resistance.slice(0, 2).join("/")}.`;

  const data: JsonObject = {
    symbol,
    barCount: bars.length,
    latestClose,
    trend: trend as unknown as JsonObject,
    supportLevels: sr.support,
    resistanceLevels: sr.resistance,
  };

  return {
    summary,
    generation_context: {
      prompt,
      data,
    },
  };
}
