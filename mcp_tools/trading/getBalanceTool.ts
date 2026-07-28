import type { RegisteredTool } from "../toolRegistry.ts";
import type { JsonObject, JsonValue } from "../../src/framework/types.ts";
import { resolveCredentials } from "./resolveCredentials.ts";
import { coinbaseFetch } from "./coinbaseAuth.ts";
import { binanceFetch } from "./binanceClient.ts";

type NormalizedAccount = {
  currency: string;
  available: string;
  locked: string;
};

function normalizeCoinbaseAccounts(raw: unknown): NormalizedAccount[] {
  const data = raw as { accounts?: Array<{ currency?: string; available_balance?: { value?: string }; hold?: { value?: string } }> };
  const accounts = data?.accounts ?? [];
  return accounts
    .filter((a) => {
      const avail = parseFloat(a.available_balance?.value ?? "0");
      const locked = parseFloat(a.hold?.value ?? "0");
      return avail > 0 || locked > 0;
    })
    .map((a) => ({
      currency: a.currency ?? "UNKNOWN",
      available: a.available_balance?.value ?? "0",
      locked: a.hold?.value ?? "0",
    }));
}

function normalizeBinanceAccounts(raw: unknown): NormalizedAccount[] {
  const data = raw as { balances?: Array<{ asset?: string; free?: string; locked?: string }> };
  const balances = data?.balances ?? [];
  return balances
    .filter((b) => {
      const free = parseFloat(b.free ?? "0");
      const locked = parseFloat(b.locked ?? "0");
      return free > 0 || locked > 0;
    })
    .map((b) => ({
      currency: b.asset ?? "UNKNOWN",
      available: b.free ?? "0",
      locked: b.locked ?? "0",
    }));
}

export function createGetBalanceTool(): RegisteredTool {
  return {
    name: "get_balance",
    description:
      "Fetch account balances from a centralized exchange (Coinbase or Binance) and return structured portfolio data for report generation.",
    category: "trading",
    inputSchema: {
      type: "object",
      required: ["task"],
      properties: {
        task: {
          type: "string",
          description: "Natural-language request describing what the user wants to know about their balance.",
        },
        exchange: {
          type: "string",
          description: "Exchange to query: 'coinbase' or 'binance'. Defaults to 'binance'.",
        },
        api_key: {
          type: "string",
          description: "API key for Binance.",
        },
        api_secret: {
          type: "string",
          description: "API secret for Binance, or EC private key PEM for Coinbase.",
        },
        api_key_name: {
          type: "string",
          description: "API key name (path) for Coinbase Advanced Trade.",
        },
      },
    },
    execute: async (input: JsonObject) => {
      const exchange = typeof input["exchange"] === "string" ? input["exchange"] : "binance";

      try {
        const creds = resolveCredentials(input);
        let accounts: NormalizedAccount[];

        if (creds.exchange === "coinbase") {
          const raw = await coinbaseFetch(creds, "GET", "/api/v3/brokerage/accounts");
          accounts = normalizeCoinbaseAccounts(raw);
        } else {
          const raw = await binanceFetch(creds, "GET", "/api/v3/account");
          accounts = normalizeBinanceAccounts(raw);
        }

        // Return all non-zero assets — a user's balance is inherently bounded and
        // they expect their full holdings, not a truncated subset.
        const accountsAsJsonValue: JsonValue = accounts.map((a) => ({
          currency: a.currency,
          available: a.available,
          locked: a.locked,
        }));

        return {
          summary: `Balance fetched from ${exchange}: ${accounts.length} non-zero assets.`,
          generation_context: {
            prompt: [
              "Use the following balance data to answer the user's portfolio/balance question.",
              "Show available balances for non-zero assets. Format as a table if multiple assets.",
              "Do not expose API keys or internal IDs.",
            ].join("\n"),
            data: {
              exchange,
              accountCount: accounts.length,
              accounts: accountsAsJsonValue,
            },
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          summary: `Balance fetch failed for ${exchange}: ${message}`,
          generation_context: {
            prompt: `No balance data available from ${exchange}.`,
            data: { exchange, error: message },
          },
        };
      }
    },
  };
}
