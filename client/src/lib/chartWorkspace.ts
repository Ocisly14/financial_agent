import { DEFAULT_STOCK_RANGE, STOCK_RANGES, extractStockCharts, type StockRange } from "./stockChart.ts";

export type TechnicalPoint = { timestamp: string; value: number };
export type TechnicalSeries = { key: string; label: string; points: TechnicalPoint[] };
export type TechnicalLevel = { value: number; kind: string; label: string };

export type TechnicalStudy = {
  id: string;
  indicator: string;
  timeframe: string;
  placement: "overlay" | "pane";
  parameters: Record<string, unknown>;
  series: TechnicalSeries[];
  referenceLevels: number[];
  levels: TechnicalLevel[];
};

export type WorkspaceVisualization =
  | { type: "stock_price"; symbol: string; range: StockRange }
  | { type: "stock_technical"; symbol: string; study: TechnicalStudy };

export type SymbolChartWorkspace = {
  symbol: string;
  range: StockRange;
  createdAt: number | null;
  studies: TechnicalStudy[];
};

export type ChartWorkspaceMessage = {
  user?: string;
  text?: string;
  createdAt?: number;
  visualizations?: unknown[];
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function ticker(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const symbol = value.trim().toUpperCase();
  return /^[A-Z][A-Z.-]{0,5}$/.test(symbol) ? symbol : undefined;
}

function stockRange(value: unknown): StockRange {
  return typeof value === "string" && (STOCK_RANGES as readonly string[]).includes(value)
    ? value as StockRange
    : DEFAULT_STOCK_RANGE;
}

function technicalSeries(value: unknown): TechnicalSeries[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    const source = record(candidate);
    if (!source || typeof source.key !== "string") return [];
    const points = Array.isArray(source.points)
      ? source.points.flatMap((pointCandidate) => {
          const point = record(pointCandidate);
          return point && typeof point.timestamp === "string" && typeof point.value === "number" && Number.isFinite(point.value)
            ? [{ timestamp: point.timestamp, value: point.value }]
            : [];
        })
      : [];
    if (points.length === 0) return [];
    return [{ key: source.key, label: typeof source.label === "string" ? source.label : source.key, points }];
  });
}

export function parseWorkspaceVisualization(value: unknown): WorkspaceVisualization | undefined {
  const source = record(value);
  const symbol = ticker(source?.symbol);
  if (!source || !symbol) return undefined;
  if (source.type === "stock_price") {
    return { type: "stock_price", symbol, range: stockRange(source.range) };
  }
  if (source.type !== "stock_technical" || typeof source.indicator !== "string" || typeof source.timeframe !== "string") {
    return undefined;
  }

  const parameters = record(source.parameters) ?? {};
  const placement = source.placement === "pane" ? "pane" : "overlay";
  const series = technicalSeries(source.series);
  const referenceLevels = Array.isArray(source.reference_levels)
    ? source.reference_levels.filter((item): item is number => typeof item === "number" && Number.isFinite(item))
    : [];
  const levels = Array.isArray(source.levels)
    ? source.levels.flatMap((candidate) => {
        const level = record(candidate);
        return level && typeof level.value === "number" && Number.isFinite(level.value)
          ? [{
              value: level.value,
              kind: typeof level.kind === "string" ? level.kind : "level",
              label: typeof level.label === "string" ? level.label : "Level",
            }]
          : [];
      })
    : [];
  if (series.length === 0 && levels.length === 0) return undefined;

  const parameterKey = Object.entries(parameters)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, parameter]) => `${key}=${String(parameter)}`)
    .join(",");
  return {
    type: "stock_technical",
    symbol,
    study: {
      id: `${source.indicator}:${source.timeframe}:${parameterKey}`,
      indicator: source.indicator,
      timeframe: source.timeframe,
      placement,
      parameters,
      series,
      referenceLevels,
      levels,
    },
  };
}

export function rangeForTechnicalTimeframe(timeframe: string): StockRange {
  return timeframe === "1Day" ? "1Y" : "1D";
}

/** Fold all assistant turns into one persistent main chart per symbol. */
export function buildSymbolChartWorkspace(
  messages: ChartWorkspaceMessage[],
  streamingText = "",
): { charts: SymbolChartWorkspace[]; focusSymbol?: string; focusRevision: number } {
  type MutableSymbolChart = SymbolChartWorkspace & { studiesById: Map<string, TechnicalStudy> };
  const bySymbol = new Map<string, MutableSymbolChart>();
  let focusSymbol: string | undefined;
  let focusRevision = 0;
  const focus = (symbol: string) => {
    focusSymbol = symbol;
    focusRevision += 1;
  };

  const chartFor = (symbol: string, createdAt: number | null): MutableSymbolChart => {
    const existing = bySymbol.get(symbol);
    if (existing) {
      existing.createdAt = createdAt ?? existing.createdAt;
      return existing;
    }
    const created: MutableSymbolChart = {
      symbol,
      range: DEFAULT_STOCK_RANGE,
      createdAt,
      studies: [],
      studiesById: new Map(),
    };
    bySymbol.set(symbol, created);
    return created;
  };

  for (const message of messages) {
    if (message.user === "user") continue;
    const createdAt = typeof message.createdAt === "number" ? message.createdAt : null;
    const visualizations = (message.visualizations ?? [])
      .map(parseWorkspaceVisualization)
      .filter((item): item is WorkspaceVisualization => item !== undefined);
    const dailyTechnicalSymbols = new Set(
      visualizations
        .filter((item): item is Extract<WorkspaceVisualization, { type: "stock_technical" }> =>
          item.type === "stock_technical" && item.study.timeframe === "1Day")
        .map((item) => item.symbol),
    );

    for (const visualization of visualizations) {
      if (visualization.type !== "stock_price") continue;
      chartFor(visualization.symbol, createdAt).range = visualization.range;
      focus(visualization.symbol);
    }
    for (const visualization of visualizations) {
      if (visualization.type !== "stock_technical") continue;
      const chart = chartFor(visualization.symbol, createdAt);
      chart.range = rangeForTechnicalTimeframe(visualization.study.timeframe);
      chart.studiesById.set(visualization.study.id, visualization.study);
      focus(visualization.symbol);
    }
    for (const directive of extractStockCharts(message.text ?? "")) {
      const chart = chartFor(directive.symbol, createdAt);
      // The model commonly emits `<StockChart symbol="MSFT" />`, whose parser
      // defaults to 1D. Do not let that presentation default collapse a daily
      // technical study to an intraday price window where timestamps cannot align.
      if (!(dailyTechnicalSymbols.has(directive.symbol) && directive.range === "1D")) {
        chart.range = directive.range;
      }
      focus(directive.symbol);
    }
  }

  for (const directive of extractStockCharts(streamingText)) {
    chartFor(directive.symbol, null).range = directive.range;
    focus(directive.symbol);
  }

  const charts = Array.from(bySymbol.values()).map(({ studiesById, ...chart }) => ({
    ...chart,
    studies: Array.from(studiesById.values()),
  }));
  return focusSymbol ? { charts, focusSymbol, focusRevision } : { charts, focusRevision };
}
