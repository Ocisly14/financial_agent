import type { MarketSession } from "./marketHours.ts";

const SESSION_LABEL: Record<MarketSession, string> = {
  "pre-market": "pre-market trading (regular session has not opened)",
  regular: "regular trading hours",
  "after-hours": "after-hours trading (regular session has closed)",
  closed: "outside all trading sessions",
};

export function buildStockPricePrompt(
  symbol: string,
  session: MarketSession,
  staleness: string | undefined,
): string {
  const lines = [
    `Use the following market data for ${symbol} to write a Market section.`,
    `The quote was taken during ${SESSION_LABEL[session]}.`,
    `Cover: current price versus previous close, intraday range, volume, and what the recent daily bars show about trend.`,
    `Prices come from the Alpaca IEX feed — a single exchange, not the consolidated SIP tape. Treat them as indicative, not as an execution reference.`,
    `Cite numeric values from the payload. Do not invent news catalysts or price levels that are not present.`,
  ];
  if (staleness) lines.push(`IMPORTANT: ${staleness} State this limitation in the section.`);
  return lines.join("\n");
}
