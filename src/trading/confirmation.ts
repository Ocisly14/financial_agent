export type ConfirmState = { count: number };

/**
 * N-sample wick-confirmation stepper. Pure: returns a new state.
 * Increments on a met sample and fires once the run reaches confirmNeeded;
 * any unmet sample resets the run to zero.
 */
export function stepConfirmation(
  state: ConfirmState,
  conditionMet: boolean,
  confirmNeeded: number,
): { state: ConfirmState; fired: boolean } {
  if (!conditionMet) return { state: { count: 0 }, fired: false };
  const count = state.count + 1;
  return { state: { count }, fired: count >= confirmNeeded };
}
