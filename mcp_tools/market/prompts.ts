export function buildCryptoPricePrompt(
  symbol: string,
  fearValue: number | null,
  fearLabel: string | null,
): string {
  const lines = [
    `Use the following market data for ${symbol} to write a Market Overview section.`,
    `Cover: current price, 24h change, 7d change, market cap, volume, supply.`,
  ];
  if (fearValue !== null) {
    lines.push(`Also include: Fear & Greed Index is ${fearValue} (${fearLabel ?? "unknown"}).`);
  }
  lines.push("Do not invent values. Use only the data below.");
  return lines.join("\n");
}
