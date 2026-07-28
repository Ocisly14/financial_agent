import type { RegisteredTool } from "../toolRegistry.ts";
import type { JsonObject } from "../../src/framework/types.ts";
import { binanceFetch, type BinanceCredentials } from "./binanceClient.ts";
import { resolveCredentials } from "./resolveCredentials.ts";

type FuturesPosition = {
  symbol: string;
  positionAmt: string;
  entryPrice: string;
  unrealizedProfit: string;
  leverage: string;
  marginType: string;
  liquidationPrice: string;
  positionSide?: string;
};

type MarginAsset = {
  asset: string;
  netAsset: string;
  borrowed: string;
  interest: string;
  free: string;
  locked: string;
};

export function createGetPositionsTool(): RegisteredTool {
  return {
    name: "get_positions",
    description:
      "Get open futures and margin positions from Binance. Returns entry price, unrealized PnL, leverage, and margin type for each position. Requires Binance API credentials with futures permissions.",
    category: "trading",
    inputSchema: {
      type: "object",
      required: ["task"],
      properties: {
        task: {
          type: "string",
          description: "Natural-language description of what the user wants to know about their positions.",
        },
        exchange: {
          type: "string",
          description: "Exchange to query. Currently only 'binance' is supported. Defaults to 'binance'.",
        },
        api_key: {
          type: "string",
          description: "Binance API key.",
        },
        api_secret: {
          type: "string",
          description: "Binance API secret.",
        },
        margin_type: {
          type: "string",
          description: "Account type: 'futures' (USD-M perpetuals), 'cross' (cross-margin spot). Defaults to 'futures'.",
        },
      },
    },
    execute: async (input: JsonObject) => {
      const marginType =
        typeof input["margin_type"] === "string" ? input["margin_type"].toLowerCase() : "futures";

      try {
        const creds = resolveCredentials(input);
        if (creds.exchange !== "binance") {
          return {
            summary: "get_positions currently only supports Binance.",
            generation_context: {
              prompt: "Position data is only available from Binance futures/margin.",
              data: { error: "unsupported exchange", exchange: creds.exchange },
            },
          };
        }
        const binanceCreds: BinanceCredentials = { apiKey: creds.apiKey, apiSecret: creds.apiSecret };

        // ── Futures positions ─────────────────────────────────────────────
        if (marginType === "futures" || marginType === "isolated") {
          const raw = (await binanceFetch(
            binanceCreds,
            "GET",
            "/fapi/v1/positionRisk",
          )) as FuturesPosition[];

          const positions = raw.filter((p) => parseFloat(p.positionAmt) !== 0);

          if (positions.length === 0) {
            return {
              summary: "No open futures positions found.",
              generation_context: {
                prompt: "The user has no open futures positions on Binance.",
                data: { exchange: "binance", marginType, positions: [] },
              },
            };
          }

          const headerLine = `### Open Futures Positions (${positions.length})`;
          const tableHeader =
            "| Symbol | Amt | Entry Price | Liq. Price | Unreal. PnL | Leverage | Margin |";
          const tableSep =
            "|--------|-----|-------------|------------|-------------|----------|--------|";
          const rows = positions.map((p) => {
            const pnl = parseFloat(p.unrealizedProfit);
            const pnlStr = (pnl >= 0 ? "+" : "") + pnl.toFixed(2);
            return `| ${p.symbol} | ${p.positionAmt} | ${p.entryPrice} | ${p.liquidationPrice} | ${pnlStr} | ${p.leverage}x | ${p.marginType} |`;
          });

          const summary = [headerLine, tableHeader, tableSep, ...rows].join("\n");

          return {
            summary,
            generation_context: {
              prompt: [
                "Use the following open futures positions to answer the user's question.",
                "Highlight any positions with large unrealized losses or close to liquidation.",
                "Show entry price, current PnL, leverage, and margin type.",
              ].join("\n"),
              data: {
                exchange: "binance",
                marginType,
                positionCount: positions.length,
                positions,
              },
            },
          };
        }

        // ── Cross-margin account ───────────────────────────────────────────
        if (marginType === "cross") {
          const raw = (await binanceFetch(
            binanceCreds,
            "GET",
            "/sapi/v1/margin/account",
          )) as {
            marginLevel: string;
            totalAssetOfBtc: string;
            totalLiabilityOfBtc: string;
            totalNetAssetOfBtc: string;
            userAssets: MarginAsset[];
          };

          const assets = (raw.userAssets ?? []).filter((a) => {
            const borrowed = parseFloat(a.borrowed ?? "0");
            const interest = parseFloat(a.interest ?? "0");
            const net = parseFloat(a.netAsset ?? "0");
            return borrowed > 0 || interest > 0 || Math.abs(net) > 0;
          });

          if (assets.length === 0) {
            return {
              summary: "No active cross-margin assets found.",
              generation_context: {
                prompt: "The user has no active cross-margin positions on Binance.",
                data: { exchange: "binance", marginType, assets: [] },
              },
            };
          }

          const headerLine = `### Cross Margin Account (Margin Level: ${raw.marginLevel})`;
          const tableHeader = "| Asset | Net | Borrowed | Interest | Free | Locked |";
          const tableSep = "|-------|-----|----------|----------|------|--------|";
          const rows = assets.map(
            (a) =>
              `| ${a.asset} | ${a.netAsset} | ${a.borrowed} | ${a.interest} | ${a.free} | ${a.locked} |`,
          );

          const summary = [headerLine, tableHeader, tableSep, ...rows].join("\n");

          return {
            summary,
            generation_context: {
              prompt: [
                "Use the following cross-margin account data to answer the user's question.",
                "Highlight any assets with outstanding borrowed amounts or accrued interest.",
                `Overall margin level is ${raw.marginLevel} (below 1.1 triggers liquidation on Binance).`,
              ].join("\n"),
              data: {
                exchange: "binance",
                marginType,
                marginLevel: raw.marginLevel,
                totalAssetOfBtc: raw.totalAssetOfBtc,
                totalLiabilityOfBtc: raw.totalLiabilityOfBtc,
                totalNetAssetOfBtc: raw.totalNetAssetOfBtc,
                assets,
              },
            },
          };
        }

        return {
          summary: `Unsupported margin_type: '${marginType}'. Use 'futures' or 'cross'.`,
          generation_context: {
            prompt: "Invalid margin_type provided.",
            data: { error: `unsupported margin_type: ${marginType}` },
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          summary: `Positions fetch failed: ${message}`,
          generation_context: {
            prompt: `No position data available. Error: ${message}`,
            data: { exchange: "binance", marginType, error: message },
          },
        };
      }
    },
  };
}
