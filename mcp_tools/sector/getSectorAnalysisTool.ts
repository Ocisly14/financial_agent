import type { JsonObject, ToolExecutionResult } from "../../src/framework/types.ts";
import {
  analyzeSectorUniverse,
  SECTOR_UNIVERSE,
  type HorizonValues,
  type SectorAnalysisRow,
  type SectorSymbol,
} from "../../src/data/sector/index.ts";
import {
  getSharedBarRepository,
  type BarRepository,
  type DailyBar,
} from "../../src/data/stock/index.ts";
import type { RegisteredTool } from "../toolRegistry.ts";

const BENCHMARK = "SPY";
const DEFAULT_HISTORY_DAYS = 260;
const MIN_HISTORY_DAYS = 260;
const MAX_HISTORY_DAYS = 1_260;
const MIN_ANALYSIS_BARS = 201;
const DATA_SOURCE = "Alpaca adjusted daily bars via local SQLite repository (IEX feed)";
const VALID_SYMBOLS = new Set<string>(SECTOR_UNIVERSE.map((sector) => sector.symbol));

type ComparisonScope = "full_universe" | "selected_subset" | "single_sector";

export type SectorAnalysisToolDeps = {
  repository?: BarRepository;
  getRepository?: () => Promise<BarRepository | undefined>;
};

function errorResult(code: string, message: string): ToolExecutionResult {
  return {
    summary: `Sector analysis unavailable: ${message}`,
    generation_context: {
      prompt: "The sector analysis could not be completed. State the limitation and do not infer missing market data.",
      data: { error: code, message },
    },
    error: { code, message },
  };
}

function selectedSectors(input: JsonObject):
  | { ok: true; value: Array<{ symbol: SectorSymbol; sector: string }> }
  | { ok: false; result: ToolExecutionResult } {
  const raw = input["sector_symbols"];
  if (raw === undefined) {
    return { ok: true, value: SECTOR_UNIVERSE.map((sector) => ({ ...sector })) };
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, result: errorResult("invalid_sector_symbols", "sector_symbols must be a non-empty array of supported sector ETF symbols.") };
  }
  const symbols = raw.map((value) => typeof value === "string" ? value.trim().toUpperCase() : "");
  if (symbols.some((symbol) => !VALID_SYMBOLS.has(symbol)) || new Set(symbols).size !== symbols.length) {
    return {
      ok: false,
      result: errorResult(
        "invalid_sector_symbols",
        `Use unique symbols from: ${SECTOR_UNIVERSE.map((sector) => sector.symbol).join(", ")}.`,
      ),
    };
  }
  const bySymbol = new Map(SECTOR_UNIVERSE.map((sector) => [sector.symbol, sector]));
  return {
    ok: true,
    value: symbols.map((symbol) => ({ ...bySymbol.get(symbol as SectorSymbol)! })),
  };
}

function historyDays(input: JsonObject): number {
  const raw = input["history_days"];
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_HISTORY_DAYS;
  return Math.max(MIN_HISTORY_DAYS, Math.min(MAX_HISTORY_DAYS, Math.trunc(raw)));
}

function pct(value: number | null): string {
  if (value === null) return "N/A";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function horizonText(values: HorizonValues): string {
  return [values.d20, values.d60, values.d120, values.d252].map(pct).join("/");
}

function fullSummary(
  asOf: string,
  sectors: SectorAnalysisRow[],
  unavailable: Array<{ symbol: string; reason: string }>,
): string {
  const lines = [
    `Sector comparison as of ${asOf} | benchmark ${BENCHMARK} | ${sectors.length}/${sectors.length + unavailable.length} available`,
    "Rank | Sector (ETF) | Score | Phase | Abs trend | Return 20/60/120/252 | vs SPY 20/60/120/252 | Vol60 | MDD120",
    ...sectors.map((row) =>
      `${row.rank ?? "N/A"} | ${row.sector} (${row.symbol}) | ${row.strength_score?.toFixed(1) ?? "N/A"} | ${row.relative_phase} | ${row.absolute_trend} | ${horizonText(row.returns_pct)} | ${horizonText(row.relative_returns_pct)} | ${pct(row.risk.volatility_60d_annualized_pct)} | ${pct(-row.risk.max_drawdown_120d_pct)}`),
  ];
  if (unavailable.length > 0) {
    lines.push(`Unavailable: ${unavailable.map((entry) => `${entry.symbol} (${entry.reason})`).join(", ")}`);
  }
  return lines.join("\n");
}

function singleSummary(
  asOf: string,
  row: SectorAnalysisRow,
  unavailable: Array<{ symbol: string; reason: string }>,
): string {
  const lines = [
    `${row.sector} (${row.symbol}) as of ${asOf} vs ${BENCHMARK} | no cross-sectional rank`,
    `Phase ${row.relative_phase} | absolute trend ${row.absolute_trend} | close ${row.close}`,
    `Return 20/60/120/252: ${horizonText(row.returns_pct)} | vs SPY: ${horizonText(row.relative_returns_pct)}`,
    `SMA50 ${row.trend.sma50} (${pct(row.trend.distance_from_sma50_pct)}) | SMA200 ${row.trend.sma200} (${pct(row.trend.distance_from_sma200_pct)})`,
    `Relative slope annualized ${pct(row.trend.relative_slope_annualized_pct)} | R² ${row.trend.relative_r_squared.toFixed(4)} | acceleration ${row.trend.relative_acceleration_pct_points.toFixed(2)}pp`,
    `Vol60 ${pct(row.risk.volatility_60d_annualized_pct)} | MDD120 ${pct(-row.risk.max_drawdown_120d_pct)}`,
  ];
  if (unavailable.length > 0) {
    lines.push(`Unavailable: ${unavailable.map((entry) => `${entry.symbol} (${entry.reason})`).join(", ")}`);
  }
  return lines.join("\n");
}

function generationPrompt(scope: ComparisonScope): string {
  const coverageRule = scope === "single_sector"
    ? "This is a single-sector diagnostic. State explicitly that no cross-sectional rank was calculated."
    : "Include every successfully returned sector exactly once in a complete ranking table; never truncate the table to the top three.";
  return [
    "Use the sector ETF analysis payload to explain market leadership and trend.",
    coverageRule,
    "Distinguish relative_phase from absolute_trend: a relative winner can still be falling in absolute terms.",
    "For each sector covered, cite its absolute trend, at least one absolute return, and at least one return relative to SPY.",
    "Compare leading, improving, weakening, and lagging groups; mention unavailable sectors explicitly.",
    "strength_score is a cross-sectional percentile composite, not an upside probability or a buy signal.",
    "Do not invent catalysts or news from price data. These are tradable ETF proxies for sectors, not raw index values.",
    "The adjusted bars use Alpaca's IEX feed, not the consolidated SIP tape; volume is intentionally excluded from the score.",
  ].join("\n");
}

/** Local-repository-backed sector trend and relative-strength analysis. */
export function createGetSectorAnalysisTool(deps: SectorAnalysisToolDeps = {}): RegisteredTool {
  return {
    name: "get_sector_analysis",
    description:
      "Analyze US equity sector trends from adjusted daily bars in the local stock database. With no sector_symbols it compares all 11 GICS sector ETFs against SPY and returns the complete ranking. Pass one supported sector ETF for a single-sector diagnostic without a rank, or pass several for an explicit subset comparison. Computes multi-horizon absolute and relative momentum, SMA50/SMA200 trend, relative trend slope and R-squared, acceleration, volatility, and drawdown.",
    category: "non_trading",
    inputSchema: {
      type: "object",
      properties: {
        sector_symbols: {
          type: "array",
          description:
            "Optional unique subset of sector ETF symbols. Omit for the full 11-sector comparison; pass one for a single-sector diagnostic.",
          items: {
            type: "string",
            enum: SECTOR_UNIVERSE.map((sector) => sector.symbol),
          },
        },
        history_days: {
          type: "number",
          description: `Daily-history window. Defaults to ${DEFAULT_HISTORY_DAYS}; clamped to ${MIN_HISTORY_DAYS}-${MAX_HISTORY_DAYS}.`,
        },
      },
    },
    execute: async (input) => {
      const selected = selectedSectors(input);
      if (!selected.ok) return selected.result;
      const requested = selected.value;
      const days = historyDays(input);
      const repository = deps.repository ?? await (deps.getRepository ?? getSharedBarRepository)();
      if (!repository) {
        return errorResult("stock_database_unavailable", "the local stock database could not be opened.");
      }

      let benchmarkBars: DailyBar[];
      try {
        benchmarkBars = await repository.getBars(BENCHMARK, "1Day", days + 1);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return errorResult("benchmark_data_error", `failed to read ${BENCHMARK} bars: ${message}`);
      }
      if (benchmarkBars.length < MIN_ANALYSIS_BARS) {
        return errorResult(
          "insufficient_benchmark_bars",
          `${BENCHMARK} requires at least ${MIN_ANALYSIS_BARS} daily bars; ${benchmarkBars.length} are available.`,
        );
      }

      const loaded = await Promise.all(requested.map(async (definition) => {
        try {
          const bars = await repository.getBars(definition.symbol, "1Day", days + 1);
          if (bars.length < MIN_ANALYSIS_BARS) {
            return {
              ok: false as const,
              symbol: definition.symbol,
              reason: `insufficient bars: ${bars.length}/${MIN_ANALYSIS_BARS}`,
            };
          }
          return { ok: true as const, ...definition, bars };
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          return { ok: false as const, symbol: definition.symbol, reason: `read failed: ${message}` };
        }
      }));

      const unavailable = loaded
        .filter((entry): entry is Extract<(typeof loaded)[number], { ok: false }> => !entry.ok)
        .map(({ symbol, reason }) => ({ symbol, reason }));
      const available = loaded
        .filter((entry): entry is Extract<(typeof loaded)[number], { ok: true }> => entry.ok)
        .map(({ symbol, sector, bars }) => ({ symbol, sector, bars }));
      if (available.length === 0) {
        return errorResult("insufficient_sector_data", "none of the requested sectors has enough daily bars.");
      }

      const analysis = analyzeSectorUniverse({ benchmarkBars, sectors: available });
      if (analysis.sectors.length === 0) {
        return errorResult("insufficient_sector_data", "the requested sector bars do not overlap with SPY.");
      }
      const scope: ComparisonScope = analysis.sectors.length === 1
        ? "single_sector"
        : requested.length === SECTOR_UNIVERSE.length
          ? "full_universe"
          : "selected_subset";
      const asOf = benchmarkBars.at(-1)!.t;
      const summary = scope === "single_sector"
        ? singleSummary(asOf, analysis.sectors[0]!, unavailable)
        : fullSummary(asOf, analysis.sectors, unavailable);
      const data = {
        benchmark: BENCHMARK,
        as_of: asOf,
        comparison_scope: scope,
        selected_symbols: requested.map((sector) => sector.symbol),
        data_source: DATA_SOURCE,
        methodology: {
          score_is_cross_sectional: true,
          score_available: scope !== "single_sector",
          horizons: [20, 60, 120, 252],
          score_weights: {
            relative_momentum: 0.4,
            absolute_momentum: 0.25,
            trend_quality: 0.2,
            acceleration: 0.1,
            risk_quality: 0.05,
          },
        },
        sectors: analysis.sectors,
        unavailable,
      };
      return {
        summary,
        generation_context: {
          prompt: generationPrompt(scope),
          data: data as unknown as JsonObject,
        },
      };
    },
  };
}

