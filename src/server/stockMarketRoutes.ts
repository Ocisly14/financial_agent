import type * as http from "node:http";
import { getSnapshotCached, type DailyBar, type Snapshot, type Timeframe } from "../../mcp_tools/stock/alpacaClient.ts";
import type { BarRepository } from "../../mcp_tools/stock/barRepository.ts";
import { getSharedBarRepository } from "../../mcp_tools/stock/sharedRepository.ts";
import { etDateString, marketSession, type MarketSession } from "../../mcp_tools/stock/marketHours.ts";

const DATA_SOURCE = "Alpaca (IEX feed)";
export type StockRange = "1D" | "5D" | "1M" | "3M" | "1Y";
type RequestedRange = StockRange | "none";

const RANGE_CONFIG: Record<StockRange, { timeframe: Timeframe; count: number }> = {
  "1D": { timeframe: "1Min", count: 390 },
  "5D": { timeframe: "5Min", count: 390 },
  "1M": { timeframe: "1Day", count: 21 },
  "3M": { timeframe: "1Day", count: 63 },
  "1Y": { timeframe: "1Day", count: 252 },
};

/** 每分钟允许穿透到 Alpaca 的 snapshot 请求数。见 inline-stock-chart spec §4。 */
const UPSTREAM_CALLS_PER_MINUTE = 120;

/** symbol 与前端 `parseStockChartProps` 用同一条正则，但各自实现。 */
const SYMBOL_RE = /^[A-Z][A-Z.-]{0,5}$/;

export type StockQuoteDeps = {
  /** SQLite 打不开时为 undefined —— 与工具层一致，退化为纯报价模式。 */
  repository: BarRepository | undefined;
  loadSnapshot: (symbol: string, nowMs: number) => Promise<Snapshot>;
  now: () => Date;
  /** 返回 false 表示本分钟的上游预算已用尽。 */
  allowUpstreamCall: () => boolean;
};

export type StockQuoteResult = { status: number; body: unknown };

/**
 * trim + 转大写后再校验。归一化口径必须与前端一致：`aapl` 是合法输入，
 * 不是 400 —— 否则前端归一化过的请求能过、直接调用端点的请求却被拒。
 */
export function normalizeSymbol(raw: string): string | undefined {
  const candidate = raw.trim().toUpperCase();
  return SYMBOL_RE.test(candidate) ? candidate : undefined;
}

/**
 * 缺省为 60；`0` 是显式的"不要 K 线"；其余钳到 [1, MAX_BARS]。
 * 非数字按缺省处理，而不是报错——模型写歪一个参数不该让整块图表消失。
 */
export function parseRangeParam(raw: string | null): RequestedRange {
  if (raw === "none") return "none";
  return raw === "1D" || raw === "5D" || raw === "1M" || raw === "3M" || raw === "1Y"
    ? raw
    : "1D";
}

/**
 * 固定窗口计数器。这不是安全边界，是账单边界——防的是几十个历史图表
 * 同时轮询把 Alpaca 配额打光，不防蓄意攻击。
 */
export function createRateLimiter(
  max: number,
  windowMs: number,
  now: () => number = Date.now,
): () => boolean {
  let windowStart = 0;
  let count = 0;
  return (): boolean => {
    const t = now();
    if (t - windowStart >= windowMs) {
      windowStart = t;
      count = 0;
    }
    if (count >= max) return false;
    count++;
    return true;
  };
}

const allowUpstreamCall = createRateLimiter(UPSTREAM_CALLS_PER_MINUTE, 60_000);

function isNotFound(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Alpaca 404") || message.startsWith("No snapshot data");
}

function toQuote(snapshot: Snapshot, prevCloseFallback: number | null): Record<string, unknown> {
  const prevClose = snapshot.prevClose ?? prevCloseFallback;
  const changePercent =
    snapshot.price !== null && prevClose !== null && prevClose !== 0
      ? parseFloat((((snapshot.price - prevClose) / prevClose) * 100).toFixed(2))
      : null;
  return {
    price: snapshot.price,
    prevClose,
    changePercent,
    bidPrice: snapshot.bidPrice,
    askPrice: snapshot.askPrice,
    dayOpen: snapshot.dayOpen,
    dayHigh: snapshot.dayHigh,
    dayLow: snapshot.dayLow,
    volume: snapshot.volume,
    quoteTimestamp: snapshot.quoteTimestamp,
  };
}

/**
 * `GET /market/stocks/:symbol?range=1D` 的全部逻辑，与 http 无关，便于测试。
 *
 * `range=none` 时省略 `candles` 字段，供高频报价轮询使用。
 */
export async function buildStockQuoteResponse(
  rawSymbol: string,
  rangeParam: string | null,
  deps: StockQuoteDeps,
): Promise<StockQuoteResult> {
  const symbol = normalizeSymbol(rawSymbol);
  if (!symbol) return { status: 400, body: { error: "invalid_symbol" } };

  if (!deps.allowUpstreamCall()) return { status: 429, body: { error: "rate_limited" } };

  const range = parseRangeParam(rangeParam);
  const current = deps.now();

  let candles: DailyBar[] | undefined;
  let timeframe: Timeframe | undefined;
  if (range !== "none") {
    const config = RANGE_CONFIG[range];
    timeframe = config.timeframe;
    try {
      candles = (await deps.repository?.getBars(symbol, timeframe, config.count)) ?? [];
      if (range === "1D" && candles.length > 0) {
        const latestSession = candles[candles.length - 1]!.t.slice(0, 10);
        candles = candles.filter((bar) => bar.t.slice(0, 10) === latestSession);
      }
    } catch {
      candles = [];
    }
  }

  let snapshot: Snapshot | undefined;
  let snapshotError: unknown;
  try {
    snapshot = await deps.loadSnapshot(symbol, current.getTime());
  } catch (error) {
    snapshotError = error;
  }

  // 报价没了、K 线也没有（或没请求）时才算彻底失败。
  if (!snapshot) {
    const latest = candles?.[candles.length - 1];
    if (!latest) {
      return isNotFound(snapshotError)
        ? { status: 404, body: { error: "symbol_not_found" } }
        : { status: 502, body: { error: "market_data_unavailable" } };
    }
  }

  const latest = candles?.[candles.length - 1];
  const prevCloseFallback = candles && candles.length >= 2 ? candles[candles.length - 2]!.c : null;
  const previousSession =
    range === "1D" && latest !== undefined && latest.t.slice(0, 10) !== etDateString(current);

  return {
    status: 200,
    body: {
      symbol,
      quote: snapshot ? toQuote(snapshot, prevCloseFallback) : null,
      session: marketSession(current),
      range,
      ...(timeframe ? { timeframe } : {}),
      ...(candles ? { candles } : {}),
      staleness: !snapshot
        ? { reason: "quote_unavailable", asOf: latest!.t }
        : previousSession
          ? { reason: "previous_session", asOf: latest!.t.slice(0, 10) }
          : null,
      dataSource: DATA_SOURCE,
      fetchedAtMs: current.getTime(),
    },
  };
}

/** 默认依赖：共享 SQLite 句柄 + 带 TTL 的 snapshot 缓存 + 进程内限流。 */
async function defaultDeps(): Promise<StockQuoteDeps> {
  return {
    repository: await getSharedBarRepository(),
    loadSnapshot: getSnapshotCached,
    now: () => new Date(),
    allowUpstreamCall,
  };
}

export async function handleStockQuote(
  rawSymbol: string,
  sp: URLSearchParams,
  res: http.ServerResponse,
  deps?: StockQuoteDeps,
): Promise<void> {
  const { status, body } = await buildStockQuoteResponse(
    decodeURIComponent(rawSymbol),
    sp.get("range"),
    deps ?? (await defaultDeps()),
  );
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export type { MarketSession };
