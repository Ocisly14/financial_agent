import type { MarketSession } from "../../src/data/stock/index.ts";

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
    `Cover: current price versus previous close, intraday range, volume, and trend.`,
    `The payload's bar data is condensed on purpose:`,
    `- daily.recentBars — up to the last 7 trading days, exact OHLCV. Quote these directly.`,
    `- daily.trend — earlier closes, downsampled. 't' and 'c' are parallel arrays: t[i] is the last trading day of bucket i and c[i] its close. Each bucket spans 'bucketDays' trading days. Use this for shape and direction, never as a per-day quote unless bucketDays is 1.`,
    `- daily.stats — exact derived figures over the whole history, computed rather than estimated: quote them as given and do not recompute them yourself.`,
    `  Two pairs of extremes, and picking the wrong one misstates the number: trueHigh/trueLow are the real period high and low, intraday included — use these whenever you say "high", "low", "52-week high" or "peak". min/max are the highest and lowest CLOSE, so name them as closing high / closing low whenever you quote them.`,
    `  mean, stdev, return, max drawdown and the moving averages are all close-based; say so if the distinction could matter to the reader.`,
    `- intraday — present when 1-minute bars were requested. Same three-part shape as daily (recentBars / trend / stats), but its bars are minutes of the most recent session, not trading days: its stats.from/to are timestamps rather than dates, and its sma20/sma50 are averages of the last 20/50 minutes, not the last 20/50 days. Never call intraday.stats.sma20 "the 20-day moving average" or otherwise treat its figures as daily.`,
    `- window — present when an absolute date range was requested AND bars were actually returned for it. Same three-part shape as daily, covering that range instead of the trailing history. Its stats.from and stats.to are the trading days actually returned, which may be narrower than the range asked for; quote dates from there, not from the request. When the range could not be served, window is absent and windowNote explains why.`,
    `- windowNote / historyDaysNote / dailyNote — present only when a request could not be served as asked, or when the daily history could not be read from the local store. State the limitation rather than answering as if it had been.`,
    `Prices come from the Alpaca IEX feed — a single exchange, not the consolidated SIP tape. Treat them as indicative, not as an execution reference.`,
    `Cite numeric values from the payload. Do not invent news catalysts or price levels that are not present.`,
  ];
  if (staleness) lines.push(`IMPORTANT: ${staleness} State this limitation in the section.`);
  return lines.join("\n");
}
