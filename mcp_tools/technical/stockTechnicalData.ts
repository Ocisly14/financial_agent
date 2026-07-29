import type { JsonObject, JsonSchema, ToolExecutionResult } from "../../src/framework/types.ts";
import {
  getSharedBarRepository,
  normalizeSymbol,
  type BarRepository,
  type DailyBar,
  type Timeframe,
} from "../../src/data/stock/index.ts";

const MAX_HISTORY_BARS = 1_500;
const MAX_SOURCE_BARS = 200_000;
const MINUTES_PER_REGULAR_SESSION = 390;
const MARKET_OPEN_MINUTE_ET = 9 * 60 + 30;

export type TechnicalTimeframe = "1Day" | `${number}Min`;

export type TechnicalToolDeps = {
  getRepository?: () => Promise<BarRepository | undefined>;
};

export type LoadedTechnicalBars = {
  symbol: string;
  timeframe: TechnicalTimeframe;
  sourceTimeframe: Timeframe;
  bars: DailyBar[];
};

export type LoadTechnicalBarsResult =
  | { ok: true; value: LoadedTechnicalBars }
  | { ok: false; result: ToolExecutionResult };

export const COMMON_TECHNICAL_PROPERTIES: Record<string, JsonSchema> = {
  symbol: {
    type: "string",
    description: "US stock or ETF ticker, e.g. AAPL, MSFT, SPY. Required; never inferred or defaulted.",
  },
  timeframe: {
    type: "string",
    description:
      "Calculation timeframe. Defaults to 1Day. Accepts any 1-390 minute interval such as 3Min, 15m, 45 minutes, 1h, or 4Hour; minute/hour intervals are aggregated from database 1-minute bars.",
  },
  history_bars: {
    type: "number",
    description: `Number of calculation bars requested after timeframe aggregation. Defaults per indicator and is capped at ${MAX_HISTORY_BARS}.`,
  },
};

const ET_CLOCK = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

type ParsedTimeframe = {
  timeframe: TechnicalTimeframe;
  sourceTimeframe: Timeframe;
  aggregateMinutes: number;
};

export function parseTechnicalTimeframe(value: unknown): ParsedTimeframe | undefined {
  if (value === undefined || value === null || value === "") {
    return { timeframe: "1Day", sourceTimeframe: "1Day", aggregateMinutes: 0 };
  }
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase().replace(/\s+/g, "");
  if (normalized === "1day" || normalized === "day" || normalized === "1d" || normalized === "daily") {
    return { timeframe: "1Day", sourceTimeframe: "1Day", aggregateMinutes: 0 };
  }

  const minuteMatch = normalized.match(/^(\d+)(?:m|min|mins|minute|minutes)$/);
  const hourMatch = normalized.match(/^(\d+(?:\.\d+)?)(?:h|hr|hrs|hour|hours)$/);
  const minutes = minuteMatch
    ? Number(minuteMatch[1])
    : hourMatch
      ? Number(hourMatch[1]) * 60
      : Number.NaN;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MINUTES_PER_REGULAR_SESSION) return undefined;
  return {
    timeframe: `${minutes}Min`,
    sourceTimeframe: "1Min",
    aggregateMinutes: minutes,
  };
}

type EtMinute = { date: string; minuteOfDay: number };

function etMinute(timestamp: string): EtMinute {
  const parts = ET_CLOCK.formatToParts(new Date(timestamp));
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
  const hour = get("hour") === "24" ? 0 : Number(get("hour"));
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minuteOfDay: hour * 60 + Number(get("minute")),
  };
}

/** Aggregate database 1-minute bars into arbitrary minute candles aligned to 09:30 ET. */
export function aggregateMinuteBars(bars: DailyBar[], intervalMinutes: number): DailyBar[] {
  if (intervalMinutes <= 1) return bars;
  const aggregated: DailyBar[] = [];
  let key = "";
  let current: DailyBar | undefined;
  let weightedPriceVolume = 0;

  const finish = (): void => {
    if (!current) return;
    current.vw = current.v > 0 ? weightedPriceVolume / current.v : current.c;
    aggregated.push(current);
  };

  for (const bar of bars) {
    const clock = etMinute(bar.t);
    const bucket = Math.floor((clock.minuteOfDay - MARKET_OPEN_MINUTE_ET) / intervalMinutes);
    const nextKey = `${clock.date}:${bucket}`;
    if (nextKey !== key) {
      finish();
      key = nextKey;
      current = { ...bar };
      weightedPriceVolume = bar.vw * bar.v;
      continue;
    }
    current!.h = Math.max(current!.h, bar.h);
    current!.l = Math.min(current!.l, bar.l);
    current!.c = bar.c;
    current!.v += bar.v;
    weightedPriceVolume += bar.vw * bar.v;
  }
  finish();
  return aggregated;
}

export function integerParam(
  input: JsonObject,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = input[key];
  const value = typeof raw === "number" && Number.isFinite(raw) ? Math.trunc(raw) : fallback;
  return Math.max(min, Math.min(value, max));
}

export function numberParam(
  input: JsonObject,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = input[key];
  const value = typeof raw === "number" && Number.isFinite(raw) ? raw : fallback;
  return Math.max(min, Math.min(value, max));
}

export async function loadTechnicalBars(
  input: JsonObject,
  minimumBars: number,
  defaultHistoryBars: number,
  deps: TechnicalToolDeps = {},
): Promise<LoadTechnicalBarsResult> {
  const rawSymbol = typeof input.symbol === "string" ? input.symbol : "";
  const symbol = normalizeSymbol(rawSymbol);
  if (!symbol) {
    return {
      ok: false,
      result: {
        summary: "Stock technical calculation failed: a valid symbol is required.",
        error: { code: "invalid_symbol", message: "A valid US stock or ETF symbol is required." },
      },
    };
  }

  const parsedTimeframe = parseTechnicalTimeframe(input.timeframe);
  if (!parsedTimeframe) {
    return {
      ok: false,
      result: {
        summary: `Stock technical calculation for ${symbol} failed: invalid timeframe.`,
        error: {
          code: "invalid_timeframe",
          message: "Use 1Day or a 1-390 minute/hour interval such as 3Min, 15m, 1h, or 4Hour.",
        },
      },
    };
  }
  const historyBars = integerParam(
    input,
    "history_bars",
    Math.max(defaultHistoryBars, minimumBars),
    minimumBars,
    MAX_HISTORY_BARS,
  );

  const repository = await (deps.getRepository ?? getSharedBarRepository)();
  if (!repository) {
    return {
      ok: false,
      result: {
        summary: `Stock technical calculation for ${symbol} failed: stock database is unavailable.`,
        error: { code: "stock_database_unavailable", message: "Stock database is unavailable." },
      },
    };
  }

  try {
    const sourceCount = parsedTimeframe.sourceTimeframe === "1Day"
      ? historyBars
      : Math.min(
          MAX_SOURCE_BARS,
          Math.max(MINUTES_PER_REGULAR_SESSION, historyBars * parsedTimeframe.aggregateMinutes),
        );
    const sourceBars = await repository.getBars(symbol, parsedTimeframe.sourceTimeframe, sourceCount);
    const bars = (
      parsedTimeframe.sourceTimeframe === "1Min"
        ? aggregateMinuteBars(sourceBars, parsedTimeframe.aggregateMinutes)
        : sourceBars
    ).slice(-historyBars);
    if (bars.length < minimumBars) {
      return {
        ok: false,
        result: {
          summary: `Stock technical calculation for ${symbol} needs ${minimumBars} bars but the database returned ${bars.length}.`,
          error: {
            code: "insufficient_bars",
            message: `At least ${minimumBars} ${parsedTimeframe.timeframe} bars are required; ${bars.length} are available.`,
          },
        },
      };
    }
    return {
      ok: true,
      value: {
        symbol,
        timeframe: parsedTimeframe.timeframe,
        sourceTimeframe: parsedTimeframe.sourceTimeframe,
        bars,
      },
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      result: {
        summary: `Stock technical calculation for ${symbol} failed while reading stock bars: ${message}`,
        error: { code: "stock_data_error", message },
      },
    };
  }
}

export function recentSeries(bars: DailyBar[], values: number[], limit = 10): JsonObject[] {
  const count = Math.min(limit, values.length);
  const valueStart = values.length - count;
  const barStart = bars.length - count;
  return Array.from({ length: count }, (_, index) => ({
    timestamp: bars[barStart + index]!.t,
    value: values[valueStart + index]!,
  }));
}

export function baseTechnicalData(loaded: LoadedTechnicalBars, indicator: string): JsonObject {
  const latest = loaded.bars.at(-1)!;
  return {
    indicator,
    symbol: loaded.symbol,
    timeframe: loaded.timeframe,
    source_timeframe: loaded.sourceTimeframe,
    bar_count: loaded.bars.length,
    latest_close: latest.c,
    as_of: latest.t,
    data_source: "Local stock bar database (Alpaca-backed)",
  };
}
