import type { RegisteredTool } from "../toolRegistry.ts";
import type { JsonObject } from "../../src/framework/types.ts";
import { binanceFetch, type BinanceCredentials } from "./binanceClient.ts";
import { resolveCredentials } from "./resolveCredentials.ts";

type IncomeRecord = {
  symbol: string;
  incomeType: string;
  income: string;
  asset: string;
  time: number;
  tranId: string;
  tradeId: string;
  info?: string;
};

type PositionRisk = {
  symbol: string;
  positionAmt: string;
  unrealizedProfit: string;
  entryPrice: string;
  leverage: string;
  marginType: string;
};

/** Split [startTime, endTime] into chunks of at most maxMs milliseconds. */
function timeChunks(
  startTime: number,
  endTime: number,
  maxMs: number,
): Array<{ startTime: number; endTime: number }> {
  const chunks: Array<{ startTime: number; endTime: number }> = [];
  let cursor = startTime;
  while (cursor < endTime) {
    const chunkEnd = Math.min(cursor + maxMs, endTime);
    chunks.push({ startTime: cursor, endTime: chunkEnd });
    cursor = chunkEnd + 1;
  }
  return chunks;
}

export function createGetPnlTool(): RegisteredTool {
  return {
    name: "get_pnl",
    description:
      "Get realized and unrealized P&L from Binance futures. Shows income history for the past 30 days (default) and current unrealized PnL from open positions. Requires Binance API credentials with futures permissions.",
    category: "trading",
    inputSchema: {
      type: "object",
      required: ["task"],
      properties: {
        task: {
          type: "string",
          description: "Natural-language description of what the user wants to know about their P&L.",
        },
        exchange: {
          type: "string",
          description: "Exchange to query. Currently only 'binance' is supported.",
        },
        api_key: {
          type: "string",
          description: "Binance API key.",
        },
        api_secret: {
          type: "string",
          description: "Binance API secret.",
        },
        days: {
          type: "number",
          description: "Number of days of history to include (1-90). Defaults to 30.",
        },
        symbol: {
          type: "string",
          description: "Optional base asset filter, e.g. 'BTC'. Returns all symbols if omitted.",
        },
      },
    },
    execute: async (input: JsonObject) => {
      const rawDays = typeof input["days"] === "number" ? input["days"] : 30;
      const days = Math.max(1, Math.min(90, Math.round(rawDays)));
      const rawSymbol = typeof input["symbol"] === "string" ? input["symbol"].trim().toUpperCase() : undefined;
      const symbolFilter = rawSymbol ? rawSymbol + "USDT" : undefined;

      try {
        const creds = resolveCredentials(input);
        if (creds.exchange !== "binance") {
          return {
            summary: "get_pnl currently only supports Binance futures.",
            generation_context: {
              prompt: "P&L data is only available from Binance futures.",
              data: { error: "unsupported exchange", exchange: creds.exchange },
            },
          };
        }
        const binanceCreds: BinanceCredentials = { apiKey: creds.apiKey, apiSecret: creds.apiSecret };

        const endTime = Date.now();
        const startTime = endTime - days * 24 * 60 * 60 * 1000;

        // Binance /fapi/v1/income max window = 7 days; use 6-day chunks to stay safe
        const SIX_DAYS_MS = 6 * 24 * 60 * 60 * 1000;
        const chunks = timeChunks(startTime, endTime, SIX_DAYS_MS);

        const chunkResults = await Promise.allSettled(
          chunks.map((chunk) => {
            const params: Record<string, string | number> = {
              incomeType: "REALIZED_PNL",
              startTime: chunk.startTime,
              endTime: chunk.endTime,
              limit: 1000,
            };
            if (symbolFilter) params["symbol"] = symbolFilter;
            return binanceFetch(binanceCreds, "GET", "/fapi/v1/income", params) as Promise<IncomeRecord[]>;
          }),
        );

        const allRecords: IncomeRecord[] = [];
        for (const result of chunkResults) {
          if (result.status === "fulfilled" && Array.isArray(result.value)) {
            allRecords.push(...result.value);
          }
        }

        // Fetch unrealized PnL from open positions
        const positionsRaw = await binanceFetch(binanceCreds, "GET", "/fapi/v2/positionRisk") as PositionRisk[];
        const openPositions = positionsRaw.filter((p) => parseFloat(p.positionAmt) !== 0);

        // Aggregate realized PnL by symbol
        const realizedBySymbol: Record<string, number> = {};
        for (const rec of allRecords) {
          const sym = rec.symbol;
          realizedBySymbol[sym] = (realizedBySymbol[sym] ?? 0) + parseFloat(rec.income);
        }

        // Aggregate unrealized PnL by symbol
        const unrealizedBySymbol: Record<string, number> = {};
        let totalUnrealized = 0;
        for (const pos of openPositions) {
          const upnl = parseFloat(pos.unrealizedProfit);
          unrealizedBySymbol[pos.symbol] = (unrealizedBySymbol[pos.symbol] ?? 0) + upnl;
          totalUnrealized += upnl;
        }

        // Merge symbols
        const allSymbols = Array.from(
          new Set([...Object.keys(realizedBySymbol), ...Object.keys(unrealizedBySymbol)]),
        ).sort();

        let totalRealized = 0;
        for (const v of Object.values(realizedBySymbol)) totalRealized += v;
        const netTotal = totalRealized + totalUnrealized;

        const fmt = (n: number) => (n >= 0 ? "+" : "") + n.toFixed(4);

        const headerLine = `### P&L Summary (${days}-day window)`;
        const totalsLine = `**Realized:** ${fmt(totalRealized)} USDT | **Unrealized:** ${fmt(totalUnrealized)} USDT | **Net:** ${fmt(netTotal)} USDT`;
        const tableHeader = "| Symbol | Realized PnL | Unrealized PnL | Net PnL |";
        const tableSep = "|--------|-------------|----------------|---------|";
        const rows = allSymbols.map((sym) => {
          const real = realizedBySymbol[sym] ?? 0;
          const unreal = unrealizedBySymbol[sym] ?? 0;
          const net = real + unreal;
          return `| ${sym} | ${fmt(real)} | ${fmt(unreal)} | ${fmt(net)} |`;
        });

        const noDataNote =
          allSymbols.length === 0
            ? "\n_No P&L records found for the selected period._"
            : "";

        const summary = [headerLine, totalsLine, "", tableHeader, tableSep, ...rows, noDataNote]
          .filter((l) => l !== undefined)
          .join("\n");

        return {
          summary,
          generation_context: {
            prompt: [
              `Use the following P&L data (last ${days} days) to answer the user's question.`,
              "Show realized, unrealized, and net PnL per symbol and overall.",
              "Highlight symbols with significant losses. Note the total net PnL clearly.",
            ].join("\n"),
            data: {
              exchange: "binance",
              days,
              symbol: rawSymbol ?? null,
              realized_usd: totalRealized,
              unrealized_usd: totalUnrealized,
              net_usd: netTotal,
              by_symbol: allSymbols.map((sym) => ({
                symbol: sym,
                realized: realizedBySymbol[sym] ?? 0,
                unrealized: unrealizedBySymbol[sym] ?? 0,
                net: (realizedBySymbol[sym] ?? 0) + (unrealizedBySymbol[sym] ?? 0),
              })),
              recordCount: allRecords.length,
              openPositionCount: openPositions.length,
            },
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          summary: `P&L fetch failed: ${message}`,
          generation_context: {
            prompt: `No P&L data available. Error: ${message}`,
            data: { exchange: "binance", days, error: message },
          },
        };
      }
    },
  };
}
