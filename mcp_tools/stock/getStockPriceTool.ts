import type { RegisteredTool } from "../toolRegistry.ts";
import type { JsonObject } from "../../src/framework/types.ts";
import * as alpaca from "./alpacaClient.ts";
import { getSnapshotCached, fetchIntradayBars, type DailyBar, type Snapshot } from "./alpacaClient.ts";
import { marketSession, etDateString } from "./marketHours.ts";
import { createBarRepository, type BarRepository } from "./barRepository.ts";
import { SqliteBarStore } from "./barStore.ts";
import { buildStockPricePrompt } from "./prompts.ts";

const DEFAULT_HISTORY_DAYS = 60;
const DATA_SOURCE = "Alpaca (IEX feed)";

let sharedRepository: BarRepository | undefined;
let repositoryFailed = false;

/** 惰性打开 SQLite 库；失败则退化为纯 API 模式（见 spec §7）。 */
async function getRepository(): Promise<BarRepository | undefined> {
  if (sharedRepository) return sharedRepository;
  if (repositoryFailed) return undefined;
  try {
    const path = process.env["STOCK_DB_PATH"] ?? "data/stock.db";
    const store = SqliteBarStore.open(path);
    sharedRepository = createBarRepository({ store, client: { fetchDailyBars: alpaca.fetchDailyBars } });
    return sharedRepository;
  } catch {
    repositoryFailed = true;
    return undefined;
  }
}

function pct(current: number, base: number): number | null {
  if (!isFinite(base) || base === 0) return null;
  return parseFloat((((current - base) / base) * 100).toFixed(2));
}

function fmtVolume(volume: number | null): string {
  if (volume === null) return "N/A";
  if (volume >= 1e9) return `${(volume / 1e9).toFixed(2)}B`;
  if (volume >= 1e6) return `${(volume / 1e6).toFixed(1)}M`;
  if (volume >= 1e3) return `${(volume / 1e3).toFixed(1)}K`;
  return String(volume);
}

export function createGetStockPriceTool(overrides?: {
  repository?: BarRepository;
  snapshot?: (symbol: string, nowMs: number) => Promise<Snapshot>;
}): RegisteredTool {
  const loadSnapshot = overrides?.snapshot ?? getSnapshotCached;

  return {
    name: "get_stock_price",
    description:
      "Fetch live US stock quotes and recent daily bars for one ticker. You must pass the ticker in the symbol argument. Live quotes come from Alpaca; daily history is served from a local store that updates incrementally.",
    category: "non_trading",
    inputSchema: {
      type: "object",
      required: ["symbol"],
      properties: {
        symbol: {
          type: "string",
          description:
            "US stock ticker to look up, e.g. AAPL, TSLA, NVDA. Required — resolve it from the conversation before calling.",
        },
        task: {
          type: "string",
          description: "Natural-language request, passed through for report context.",
        },
        historyDays: {
          type: "number",
          description: `How many trading days of daily bars to return. Defaults to ${DEFAULT_HISTORY_DAYS}.`,
        },
        includeIntraday: {
          type: "boolean",
          description: "Whether to include today's 1-minute bars. Defaults to false.",
        },
      },
    },
    execute: async (input: JsonObject) => {
      const symbol =
        typeof input["symbol"] === "string" && input["symbol"].trim()
          ? input["symbol"].trim().toUpperCase()
          : undefined;

      if (!symbol) {
        return {
          summary: "No symbol was passed to get_stock_price. Call it again with the ticker in the symbol argument.",
          generation_context: {
            prompt:
              "No ticker was supplied. Determine which stock the user means from the conversation and call get_stock_price again with the symbol argument set.",
            data: { symbol: null, error: "symbol_required" },
          },
        };
      }

      const historyDays =
        typeof input["historyDays"] === "number" && input["historyDays"] > 0
          ? Math.floor(input["historyDays"])
          : DEFAULT_HISTORY_DAYS;
      const includeIntraday = input["includeIntraday"] === true;
      const current = new Date();
      const session = marketSession(current);

      // 日 K：优先走本地库；库不可用时直接拉 API
      let dailyBars: DailyBar[] = [];
      try {
        const repository = overrides?.repository ?? (await getRepository());
        if (repository) {
          dailyBars = await repository.getDailyBars(symbol, historyDays);
        } else {
          // Mongo 不可用：退化为纯 API 模式。多取自然日以覆盖 historyDays 个交易日
          const from = new Date(current);
          from.setUTCDate(from.getUTCDate() - Math.ceil(historyDays * 1.5) - 5);
          const fetched = await alpaca.fetchDailyBars(
            symbol,
            from.toISOString().slice(0, 10),
            etDateString(current),
          );
          dailyBars = fetched.slice(Math.max(0, fetched.length - historyDays));
        }
      } catch {
        dailyBars = [];
      }

      let snapshot: Snapshot | undefined;
      let snapshotError: string | undefined;
      try {
        snapshot = await loadSnapshot(symbol, current.getTime());
      } catch (err) {
        snapshotError = err instanceof Error ? err.message : String(err);
      }

      const latestBar = dailyBars[dailyBars.length - 1];

      if (!snapshot && !latestBar) {
        return {
          summary: `Market data unavailable for ${symbol}: ${snapshotError ?? "no data"}`,
          generation_context: {
            prompt: `No market data available for ${symbol}.`,
            data: { symbol, error: snapshotError ?? "no data", dataSource: DATA_SOURCE },
          },
        };
      }

      const staleness =
        !snapshot && latestBar
          ? `Live quote unavailable; the most recent data is the daily close for ${latestBar.t}.`
          : undefined;

      const price = snapshot?.price ?? latestBar?.c ?? null;
      const prevClose =
        snapshot?.prevClose ?? (dailyBars.length >= 2 ? dailyBars[dailyBars.length - 2]!.c : null);
      const changePercent = price !== null && prevClose !== null ? pct(price, prevClose) : null;

      let intradayBars: DailyBar[] | undefined;
      if (includeIntraday) {
        try {
          intradayBars = await fetchIntradayBars(symbol, etDateString(current));
        } catch {
          intradayBars = [];
        }
      }

      const data: JsonObject = {
        symbol,
        price,
        bidPrice: snapshot?.bidPrice ?? null,
        askPrice: snapshot?.askPrice ?? null,
        dayOpen: snapshot?.dayOpen ?? latestBar?.o ?? null,
        dayHigh: snapshot?.dayHigh ?? latestBar?.h ?? null,
        dayLow: snapshot?.dayLow ?? latestBar?.l ?? null,
        prevClose,
        changePercent,
        volume: snapshot?.volume ?? latestBar?.v ?? null,
        marketSession: session,
        quoteTimestamp: snapshot?.quoteTimestamp ?? latestBar?.t ?? null,
        dailyBars,
        dataSource: DATA_SOURCE,
        ...(intradayBars ? { intradayBars } : {}),
        ...(staleness ? { staleness } : {}),
      };

      const changeStr = changePercent !== null ? `${changePercent >= 0 ? "+" : ""}${changePercent}%` : "N/A";
      const priceStr = price !== null ? `$${price}` : "N/A";
      const suffix = staleness ? ` | 数据截至 ${latestBar?.t}` : ` | ${session}`;

      return {
        summary: `${symbol} ${priceStr} | ${changeStr} | Vol ${fmtVolume(data["volume"] as number | null)}${suffix}`,
        generation_context: {
          prompt: buildStockPricePrompt(symbol, session, staleness),
          data,
        },
      };
    },
  };
}
