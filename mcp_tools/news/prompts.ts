export function buildNewsPrompt(
  symbol: string,
  date: string,
  avgSentiment: number,
  formattedList: string,
): string {
  if (!formattedList) {
    return `No news data available for ${symbol} on ${date}.`;
  }
  return [
    `Use the following news items for ${symbol} (${date}) to write a News section.`,
    `Cover: key headline themes, sentiment tone (overall ${avgSentiment.toFixed(4)}), notable URLs.`,
    `Cite article URLs. Do not invent facts beyond the provided data.`,
    ``,
    formattedList,
  ].join("\n");
}
