export const TOKEN_METADATA_PROMPT: string =
  "Analyze the provided launchpad token data by examining each token's current price, market capitalization, and bonding curve progress to assess its stage in the lifecycle. " +
  "Pay close attention to which phase each token is in — new, bonding, or graduated — as this determines risk profile and potential upside. " +
  "Evaluate volume trends and momentum signals relative to market cap to identify tokens showing early breakout or accumulation patterns. " +
  "Compare tokens across phases to surface which assets are near graduation thresholds and may attract increased attention. " +
  "Summarize the overall launchpad landscape, highlighting the most notable tokens by market cap and flagging any outliers with unusual bonding progress or creation recency.";

export const TOKEN_HOURLY_METRICS_PROMPT: string =
  "Analyze the hourly trading metrics for the provided launchpad token, focusing on the buy/sell ratio to gauge short-term directional pressure. " +
  "Examine transaction count (tx1h) alongside buy and sell volumes to determine whether activity reflects genuine momentum or thin noise. " +
  "Assess total holder count in the context of price and volume to identify whether the token is broadening its base or concentrating. " +
  "Evaluate bonding curve progress against hourly volume to estimate how quickly the token may approach or has surpassed its graduation threshold. " +
  "Synthesize these signals into a concise momentum assessment — bullish, neutral, or bearish — with supporting evidence from the data.";
