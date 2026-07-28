import type { JsonObject } from "../../src/framework/types.ts";
import type { RegisteredTool } from "../toolRegistry.ts";
import { fetchWhalePositions } from "../shared/coinglassClient.ts";
import { dateRange } from "../shared/dateUtils.ts";
import { cacheRawData } from "../shared/rawDataCache.ts";
import { curateRecords } from "../shared/curate.ts";
import { WHALE_ALERT_PROMPT } from "./prompts.ts";
import { cryptoInfo } from "./analysisHelpers.ts";

const WHALE_POSITION_KEYS = [
  "user",
  "symbol",
  "side",
  "position_size",
  "position_value_usd",
  "entry_price",
  "mark_price",
  "liq_price",
  "leverage",
  "margin_balance",
  "unrealized_pnl",
  "funding_fee",
  "margin_mode",
  "create_time",
  "update_time",
];

type WhalePosition = {
  user?: string;
  symbol?: string;
  position_value_usd?: number;
  position_size?: number;
  entry_price?: number;
  mark_price?: number;
  liq_price?: number;
  leverage?: number;
  margin_balance?: number;
  unrealized_pnl?: number;
  funding_fee?: number;
  margin_mode?: string;
  create_time?: number;
  update_time?: number;
  side?: string;
  [key: string]: unknown;
};

function positionSide(position: WhalePosition): "long" | "short" | "unknown" {
  const side = String(position.side ?? "").toLowerCase();
  if (side === "long" || side === "short") return side;
  if (typeof position.position_size === "number") {
    if (position.position_size > 0) return "long";
    if (position.position_size < 0) return "short";
  }
  return "unknown";
}

export function createWhaleAlertTool(): RegisteredTool {
  return {
    name: "whale_alert",
    description:
      "Fetch and analyze large whale positions from Hyperliquid via CoinGlass. Identifies top positions by USD value, long/short ratio, top symbols, and liquidation risk.",
    category: "non_trading",
    inputSchema: {
      type: "object",
      required: ["task"],
      properties: {
        task: {
          type: "string",
          description: "Natural-language request for whale position analysis.",
        },
        symbol: {
          type: "string",
          description: "Optional asset symbol to filter positions (e.g. BTC, ETH).",
        },
        from: {
          type: "string",
          description: "Optional start date in YYYY-MM-DD format.",
        },
        to: {
          type: "string",
          description: "Optional end date in YYYY-MM-DD format.",
        },
        limit: {
          type: "number",
          description: "Number of top positions to return as detail (default 10, max 50). Aggregates always cover all positions.",
        },
      },
    },
    execute: async (input: JsonObject) => {
      const task = (input.task as string) ?? "";
      const symbolFilter = input.symbol ? String(input.symbol).toUpperCase() : undefined;
      const limit = Math.min((input.limit as number) ?? 10, 50);
      const { from, to } = dateRange(
        input.from ? String(input.from) : undefined,
        input.to ? String(input.to) : undefined,
        7,
      );

      let raw: unknown;
      try {
        raw = await fetchWhalePositions(from, to);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          summary: `Whale alert data unavailable (${from} to ${to}): ${message}`,
          generation_context: {
            prompt: WHALE_ALERT_PROMPT + "\n\nDATA: unavailable",
            data: { symbol: symbolFilter ?? "all", from, to, error: message },
          },
        };
      }
      let positions = raw as WhalePosition[];

      if (symbolFilter) {
        positions = positions.filter(
          (p) => p.symbol && String(p.symbol).toUpperCase() === symbolFilter,
        );
      }

      positions.sort((a, b) => (b.position_value_usd ?? 0) - (a.position_value_usd ?? 0));

      const symbolWindow = positions.slice(0, 20); // fixed window for topSymbols frequency

      const totalPositions = positions.length;
      const totalValueUSD = positions.reduce((sum, p) => sum + (p.position_value_usd ?? 0), 0);
      const longPositions = positions.filter((p) => positionSide(p) === "long");
      const shortPositions = positions.filter((p) => positionSide(p) === "short");
      const longCount = longPositions.length;
      const shortCount = shortPositions.length;
      const avgPositionSizeUSD = totalPositions > 0 ? totalValueUSD / totalPositions : 0;
      const longValueUSD = longPositions.reduce((sum, p) => sum + (p.position_value_usd ?? 0), 0);
      const shortValueUSD = shortPositions.reduce((sum, p) => sum + (p.position_value_usd ?? 0), 0);
      const longShortRatio = shortCount > 0 ? longCount / shortCount : longCount > 0 ? Number.POSITIVE_INFINITY : 0;
      const totalUnrealizedPnlUSD = positions.reduce((sum, p) => sum + (p.unrealized_pnl ?? 0), 0);
      const profitablePositions = positions.filter((p) => (p.unrealized_pnl ?? 0) > 0).length;
      const losingPositions = positions.filter((p) => (p.unrealized_pnl ?? 0) < 0).length;
      const averageLeverage =
        totalPositions > 0 ? positions.reduce((sum, p) => sum + (p.leverage ?? 0), 0) / totalPositions : 0;
      const highLeveragePositions = positions.filter((p) => (p.leverage ?? 0) >= 20).length;

      const symbolCounts = new Map<string, number>();
      for (const p of symbolWindow) {
        if (p.symbol) {
          const sym = String(p.symbol).toUpperCase();
          symbolCounts.set(sym, (symbolCounts.get(sym) ?? 0) + 1);
        }
      }
      const topSymbols = [...symbolCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([sym]) => sym);

      const categoryBreakdown: Record<string, { count: number; totalValue: number; symbols: string[] }> = {};
      for (const p of positions) {
        const sym = p.symbol ? String(p.symbol).toUpperCase() : "UNKNOWN";
        const info = cryptoInfo(sym);
        const current = categoryBreakdown[info.category] ?? { count: 0, totalValue: 0, symbols: [] };
        current.count += 1;
        current.totalValue += p.position_value_usd ?? 0;
        if (!current.symbols.includes(sym)) current.symbols.push(sym);
        categoryBreakdown[info.category] = current;
      }

      const summary = {
        totalTransactions: totalPositions,
        totalValueUSD,
        topSymbols,
        longShortRatio,
        averagePositionSize: avgPositionSizeUSD,
        allTransactionsCount: totalPositions,
        allTransactionsValue: totalValueUSD,
        top10Percentage: totalValueUSD > 0
          ? (positions.slice(0, 10).reduce((sum, p) => sum + (p.position_value_usd ?? 0), 0) / totalValueUSD) * 100
          : 0,
        timeRangeDays: Math.max(1, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 86_400_000)),
        recentTransactionsCount: totalPositions,
        requestedCryptos: symbolFilter ? [symbolFilter] : [],
      };

      // Persist the full sorted position list (all raw fields) to the local
      // cache; data carries the agent-requested number of top positions.
      await cacheRawData("whale_alert", `${symbolFilter ?? "all"}_${from}_${to}`, positions);

      const data: JsonObject = {
        symbol: symbolFilter ?? "all",
        from,
        to,
        transactions: curateRecords(positions.slice(0, limit), WHALE_POSITION_KEYS, limit) as unknown as JsonObject[string],
        summary: summary as unknown as JsonObject[string],
        categoryBreakdown: categoryBreakdown as unknown as JsonObject[string],
        totalPositions,
        totalValueUSD,
        longCount,
        shortCount,
        longValueUSD,
        shortValueUSD,
        longShortRatio,
        avgPositionSizeUSD,
        totalUnrealizedPnlUSD,
        profitablePositions,
        losingPositions,
        averageLeverage,
        highLeveragePositions,
        topSymbols: topSymbols as unknown as JsonObject[string],
        positions: curateRecords(positions.slice(0, limit), WHALE_POSITION_KEYS, limit) as unknown as JsonObject[string],
      };

      const prompt = WHALE_ALERT_PROMPT + "\n\nDATA:\n" + JSON.stringify(data, null, 2);

      return {
        summary: `Whale positions: ${totalPositions} found, total $${totalValueUSD.toFixed(0)} USD. Long/Short: ${longCount}/${shortCount}.`,
        generation_context: {
          prompt,
          data,
        },
      };
    },
  };
}
