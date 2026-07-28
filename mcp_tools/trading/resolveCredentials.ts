import type { JsonObject } from "../../src/framework/types.ts";

export type ExchangeCredentials =
  | { exchange: "coinbase"; apiKeyName: string; apiKeySecret: string }
  | { exchange: "binance"; apiKey: string; apiSecret: string };

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function envStr(key: string): string {
  return (process.env[key] ?? "").trim();
}

export function resolveCredentials(input: JsonObject): ExchangeCredentials {
  const exchange = str(input["exchange"]) || "binance";

  if (exchange === "coinbase") {
    // Input takes priority; fall back to env
    const apiKeyName = str(input["api_key_name"]) || envStr("COINBASE_API_KEY_NAME");
    const apiKeySecret = str(input["api_secret"]) || envStr("COINBASE_PRIVATE_KEY");

    if (!apiKeyName) throw new Error("Coinbase credentials require api_key_name (or set COINBASE_API_KEY_NAME env var)");
    if (!apiKeySecret) throw new Error("Coinbase credentials require api_secret (or set COINBASE_PRIVATE_KEY env var)");

    return { exchange: "coinbase", apiKeyName, apiKeySecret };
  }

  if (exchange === "binance") {
    // Input takes priority; fall back to env
    const apiKey = str(input["api_key"]) || envStr("BINANCE_API_KEY");
    const apiSecret = str(input["api_secret"]) || envStr("BINANCE_API_SECRET");

    if (!apiKey) throw new Error("Binance credentials require api_key (or set BINANCE_API_KEY env var)");
    if (!apiSecret) throw new Error("Binance credentials require api_secret (or set BINANCE_API_SECRET env var)");

    return { exchange: "binance", apiKey, apiSecret };
  }

  throw new Error(`Unsupported exchange: ${exchange}. Supported: coinbase, binance`);
}
