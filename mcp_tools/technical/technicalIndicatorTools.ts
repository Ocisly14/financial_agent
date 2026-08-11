import type { JsonObject, JsonSchema, ToolExecutionResult } from "../../src/framework/types.ts";
import type { RegisteredTool } from "../toolRegistry.ts";
import { atr, bollinger, ema, macd, obv, rsi, sma, supportResistance, vwap } from "./indicators.ts";
import {
  baseTechnicalData,
  COMMON_TECHNICAL_PROPERTIES,
  integerParam,
  loadTechnicalBars,
  numberParam,
  recentSeries,
  type LoadedTechnicalBars,
  type TechnicalToolDeps,
} from "./stockTechnicalData.ts";

export const TECHNICAL_TOOL_NAMES = [
  "stock_sma",
  "stock_ema",
  "stock_rsi",
  "stock_macd",
  "stock_bollinger_bands",
  "stock_atr",
  "stock_obv",
  "stock_vwap",
  "stock_support_resistance",
] as const;

function schema(extra: Record<string, JsonSchema> = {}): JsonSchema {
  return {
    type: "object",
    required: ["symbol"],
    properties: { ...COMMON_TECHNICAL_PROPERTIES, ...extra },
  };
}

function latest(values: number[]): number {
  return values.at(-1) ?? 0;
}

function success(
  loaded: LoadedTechnicalBars,
  indicator: string,
  summary: string,
  values: JsonObject,
  visualization?: JsonObject,
): ToolExecutionResult {
  return {
    summary,
    ...(visualization
      ? {
          visualizations: [{
            type: "stock_technical",
            symbol: loaded.symbol,
            timeframe: loaded.timeframe,
            indicator,
            ...visualization,
          }],
        }
      : {}),
    generation_context: {
      data: { ...baseTechnicalData(loaded, indicator), ...values },
    },
  };
}

export function createStockSmaTool(deps: TechnicalToolDeps = {}): RegisteredTool {
  return {
    name: "stock_sma",
    description: "Calculate a Simple Moving Average (SMA) for a US stock or ETF from bars in the stock database.",
    category: "non_trading",
    inputSchema: schema({
      period: { type: "number", description: "SMA period in bars. Defaults to 20; allowed range 2-500." },
    }),
    execute: async (input) => {
      const period = integerParam(input, "period", 20, 2, 500);
      const loaded = await loadTechnicalBars(input, period, Math.max(60, period * 3), deps);
      if (!loaded.ok) return loaded.result;
      const values = sma(loaded.value.bars.map((bar) => bar.c), period);
      const value = latest(values);
      return success(loaded.value, "SMA", `${loaded.value.symbol} SMA(${period}) = ${value}.`, {
        period,
        value,
        recent_values: recentSeries(loaded.value.bars, values),
      }, {
        placement: "overlay",
        parameters: { period },
        series: [{ key: "sma", label: `SMA(${period})`, points: recentSeries(loaded.value.bars, values, 500) }],
      });
    },
  };
}

export function createStockEmaTool(deps: TechnicalToolDeps = {}): RegisteredTool {
  return {
    name: "stock_ema",
    description: "Calculate an Exponential Moving Average (EMA) for a US stock or ETF from bars in the stock database.",
    category: "non_trading",
    inputSchema: schema({
      period: { type: "number", description: "EMA period in bars. Defaults to 20; allowed range 2-500." },
    }),
    execute: async (input) => {
      const period = integerParam(input, "period", 20, 2, 500);
      const loaded = await loadTechnicalBars(input, period, Math.max(60, period * 3), deps);
      if (!loaded.ok) return loaded.result;
      const values = ema(loaded.value.bars.map((bar) => bar.c), period);
      const value = latest(values);
      return success(loaded.value, "EMA", `${loaded.value.symbol} EMA(${period}) = ${value}.`, {
        period,
        value,
        recent_values: recentSeries(loaded.value.bars, values),
      }, {
        placement: "overlay",
        parameters: { period },
        series: [{ key: "ema", label: `EMA(${period})`, points: recentSeries(loaded.value.bars, values, 500) }],
      });
    },
  };
}

export function createStockRsiTool(deps: TechnicalToolDeps = {}): RegisteredTool {
  return {
    name: "stock_rsi",
    description: "Calculate the Relative Strength Index (RSI) for a US stock or ETF from bars in the stock database.",
    category: "non_trading",
    inputSchema: schema({
      period: { type: "number", description: "RSI period in bars. Defaults to 14; allowed range 2-100." },
    }),
    execute: async (input) => {
      const period = integerParam(input, "period", 14, 2, 100);
      const loaded = await loadTechnicalBars(input, period + 1, Math.max(60, period * 4), deps);
      if (!loaded.ok) return loaded.result;
      const values = rsi(loaded.value.bars.map((bar) => bar.c), period);
      const value = latest(values);
      return success(loaded.value, "RSI", `${loaded.value.symbol} RSI(${period}) = ${value}.`, {
        period,
        value,
        recent_values: recentSeries(loaded.value.bars, values),
      }, {
        placement: "pane",
        parameters: { period },
        reference_levels: [30, 70],
        series: [{ key: "rsi", label: `RSI(${period})`, points: recentSeries(loaded.value.bars, values, 500) }],
      });
    },
  };
}

export function createStockMacdTool(deps: TechnicalToolDeps = {}): RegisteredTool {
  return {
    name: "stock_macd",
    description: "Calculate MACD, signal, and histogram values for a US stock or ETF from bars in the stock database.",
    category: "non_trading",
    inputSchema: schema({
      fast_period: { type: "number", description: "Fast EMA period. Defaults to 12." },
      slow_period: { type: "number", description: "Slow EMA period. Defaults to 26." },
      signal_period: { type: "number", description: "Signal EMA period. Defaults to 9." },
    }),
    execute: async (input) => {
      const fast = integerParam(input, "fast_period", 12, 2, 200);
      const slow = integerParam(input, "slow_period", 26, fast + 1, 500);
      const signal = integerParam(input, "signal_period", 9, 2, 100);
      const minimum = slow + signal - 1;
      const loaded = await loadTechnicalBars(input, minimum, Math.max(100, minimum * 2), deps);
      if (!loaded.ok) return loaded.result;
      const values = macd(loaded.value.bars.map((bar) => bar.c), fast, slow, signal);
      const macdValue = latest(values.macd);
      const signalValue = latest(values.signal);
      const histogramValue = latest(values.histogram);
      return success(
        loaded.value,
        "MACD",
        `${loaded.value.symbol} MACD(${fast},${slow},${signal}) = ${macdValue}; signal=${signalValue}; histogram=${histogramValue}.`,
        {
          fast_period: fast,
          slow_period: slow,
          signal_period: signal,
          macd: macdValue,
          signal: signalValue,
          histogram: histogramValue,
          recent_macd: recentSeries(loaded.value.bars, values.macd),
          recent_signal: recentSeries(loaded.value.bars, values.signal),
          recent_histogram: recentSeries(loaded.value.bars, values.histogram),
        },
        {
          placement: "pane",
          parameters: { fast_period: fast, slow_period: slow, signal_period: signal },
          reference_levels: [0],
          series: [
            { key: "macd", label: "MACD", points: recentSeries(loaded.value.bars, values.macd, 500) },
            { key: "signal", label: "Signal", points: recentSeries(loaded.value.bars, values.signal, 500) },
            { key: "histogram", label: "Histogram", points: recentSeries(loaded.value.bars, values.histogram, 500) },
          ],
        },
      );
    },
  };
}

export function createStockBollingerBandsTool(deps: TechnicalToolDeps = {}): RegisteredTool {
  return {
    name: "stock_bollinger_bands",
    description: "Calculate Bollinger Bands for a US stock or ETF from bars in the stock database.",
    category: "non_trading",
    inputSchema: schema({
      period: { type: "number", description: "Moving-average period. Defaults to 20." },
      standard_deviations: { type: "number", description: "Band width in standard deviations. Defaults to 2." },
    }),
    execute: async (input) => {
      const period = integerParam(input, "period", 20, 2, 500);
      const standardDeviations = numberParam(input, "standard_deviations", 2, 0.1, 10);
      const loaded = await loadTechnicalBars(input, period, Math.max(60, period * 3), deps);
      if (!loaded.ok) return loaded.result;
      const values = bollinger(loaded.value.bars.map((bar) => bar.c), period, standardDeviations);
      const upper = latest(values.upper);
      const middle = latest(values.middle);
      const lower = latest(values.lower);
      const percentB = latest(values.pctB);
      const bandwidth = latest(values.bandwidth);
      return success(
        loaded.value,
        "Bollinger Bands",
        `${loaded.value.symbol} Bollinger Bands(${period},${standardDeviations}): upper=${upper}, middle=${middle}, lower=${lower}.`,
        { period, standard_deviations: standardDeviations, upper, middle, lower, percent_b: percentB, bandwidth },
        {
          placement: "overlay",
          parameters: { period, standard_deviations: standardDeviations },
          series: [
            { key: "upper", label: "Upper", points: recentSeries(loaded.value.bars, values.upper, 500) },
            { key: "middle", label: "Middle", points: recentSeries(loaded.value.bars, values.middle, 500) },
            { key: "lower", label: "Lower", points: recentSeries(loaded.value.bars, values.lower, 500) },
          ],
        },
      );
    },
  };
}

export function createStockAtrTool(deps: TechnicalToolDeps = {}): RegisteredTool {
  return {
    name: "stock_atr",
    description: "Calculate Average True Range (ATR) for a US stock or ETF from bars in the stock database.",
    category: "non_trading",
    inputSchema: schema({
      period: { type: "number", description: "ATR period in bars. Defaults to 14." },
    }),
    execute: async (input) => {
      const period = integerParam(input, "period", 14, 2, 100);
      const loaded = await loadTechnicalBars(input, period + 1, Math.max(60, period * 4), deps);
      if (!loaded.ok) return loaded.result;
      const values = atr(loaded.value.bars, period);
      const value = latest(values);
      return success(loaded.value, "ATR", `${loaded.value.symbol} ATR(${period}) = ${value}.`, {
        period,
        value,
        recent_values: recentSeries(loaded.value.bars, values),
      }, {
        placement: "pane",
        parameters: { period },
        series: [{ key: "atr", label: `ATR(${period})`, points: recentSeries(loaded.value.bars, values, 500) }],
      });
    },
  };
}

export function createStockObvTool(deps: TechnicalToolDeps = {}): RegisteredTool {
  return {
    name: "stock_obv",
    description: "Calculate On-Balance Volume (OBV) and its recent change for a US stock or ETF from bars in the stock database.",
    category: "non_trading",
    inputSchema: schema({
      change_bars: { type: "number", description: "Number of bars over which to measure OBV change. Defaults to 10." },
    }),
    execute: async (input) => {
      const changeBars = integerParam(input, "change_bars", 10, 1, 250);
      const loaded = await loadTechnicalBars(input, changeBars + 1, Math.max(100, changeBars * 5), deps);
      if (!loaded.ok) return loaded.result;
      const values = obv(loaded.value.bars);
      const value = latest(values);
      const prior = values[Math.max(0, values.length - changeBars - 1)] ?? 0;
      const change = value - prior;
      const changePercent = prior === 0 ? null : (change / Math.abs(prior)) * 100;
      return success(loaded.value, "OBV", `${loaded.value.symbol} OBV = ${value}; ${changeBars}-bar change=${change}.`, {
        value,
        change_bars: changeBars,
        change,
        change_percent: changePercent,
        recent_values: recentSeries(loaded.value.bars, values),
      }, {
        placement: "pane",
        parameters: { change_bars: changeBars },
        series: [{ key: "obv", label: "OBV", points: recentSeries(loaded.value.bars, values, 500) }],
      });
    },
  };
}

export function createStockVwapTool(deps: TechnicalToolDeps = {}): RegisteredTool {
  return {
    name: "stock_vwap",
    description: "Calculate cumulative VWAP over a selected stock-database bar window for a US stock or ETF.",
    category: "non_trading",
    inputSchema: schema(),
    execute: async (input) => {
      const loaded = await loadTechnicalBars(input, 2, 20, deps);
      if (!loaded.ok) return loaded.result;
      const values = vwap(loaded.value.bars);
      const value = latest(values);
      return success(loaded.value, "VWAP", `${loaded.value.symbol} VWAP over ${loaded.value.bars.length} bars = ${value}.`, {
        window_bars: loaded.value.bars.length,
        value,
        recent_values: recentSeries(loaded.value.bars, values),
      }, {
        placement: "overlay",
        parameters: { window_bars: loaded.value.bars.length },
        series: [{ key: "vwap", label: "VWAP", points: recentSeries(loaded.value.bars, values, 500) }],
      });
    },
  };
}

export function createStockSupportResistanceTool(deps: TechnicalToolDeps = {}): RegisteredTool {
  return {
    name: "stock_support_resistance",
    description: "Calculate pivot-based support and resistance levels for a US stock or ETF from bars in the stock database.",
    category: "non_trading",
    inputSchema: schema({
      pivot_lookback: { type: "number", description: "Bars on each side of a pivot. Defaults to 20." },
      max_levels: { type: "number", description: "Maximum support and resistance levels to return. Defaults to 5." },
    }),
    execute: async (input) => {
      const lookback = integerParam(input, "pivot_lookback", 20, 2, 100);
      const maxLevels = integerParam(input, "max_levels", 5, 1, 20);
      const minimum = lookback * 2 + 1;
      const loaded = await loadTechnicalBars(input, minimum, Math.max(252, minimum * 3), deps);
      if (!loaded.ok) return loaded.result;
      const levels = supportResistance(loaded.value.bars.map((bar) => bar.c), lookback, maxLevels);
      return success(
        loaded.value,
        "Support/Resistance",
        `${loaded.value.symbol} support=${levels.support.join("/") || "none"}; resistance=${levels.resistance.join("/") || "none"}.`,
        { pivot_lookback: lookback, max_levels: maxLevels, support: levels.support, resistance: levels.resistance },
        {
          placement: "overlay",
          parameters: { pivot_lookback: lookback, max_levels: maxLevels },
          levels: [
            ...levels.support.map((value) => ({ value, kind: "support", label: "Support" })),
            ...levels.resistance.map((value) => ({ value, kind: "resistance", label: "Resistance" })),
          ],
        },
      );
    },
  };
}

export function createTechnicalIndicatorTools(deps: TechnicalToolDeps = {}): RegisteredTool[] {
  return [
    createStockSmaTool(deps),
    createStockEmaTool(deps),
    createStockRsiTool(deps),
    createStockMacdTool(deps),
    createStockBollingerBandsTool(deps),
    createStockAtrTool(deps),
    createStockObvTool(deps),
    createStockVwapTool(deps),
    createStockSupportResistanceTool(deps),
  ];
}
