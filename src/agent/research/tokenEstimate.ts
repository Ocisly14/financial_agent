/** Cheap, intentionally approximate prompt-size estimate used only to cap
 * workspace roster and sidebar digest input. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}
