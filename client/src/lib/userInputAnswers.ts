import type { UserInputAnswer, UserInputQuestion } from "@/types/core";

/**
 * The answer-card arithmetic, kept out of the component so it can be tested
 * without a DOM.
 *
 * Every question carries a free-text field alongside its listed options, and
 * that text is a *selection*, not an annotation on one: filling it in occupies
 * a slot against `min_selections`/`max_selections` exactly as clicking an
 * option does. On a single-select question that means an unlisted answer
 * displaces the listed one rather than riding along beside it — which is the
 * point, since the reason to type is that none of the options fit.
 *
 * `validateUserInputAnswers` in `src/server/server.ts` enforces the same rule;
 * these functions only stop the user from submitting something the server would
 * reject.
 */

/** Mirrors `MAX_FREE_TEXT` in `src/server/server.ts`; the field caps input at the
 *  same length the server would reject. */
export const MAX_FREE_TEXT = 500;

/** Selections a question currently holds, counting non-blank free text as one. */
export function questionSelectionCount(selectedOptionIds: string[], freeText: string): number {
  return selectedOptionIds.length + (freeText.trim() ? 1 : 0);
}

/** Whether a question's selections sit within its own limits. */
export function isQuestionSatisfied(
  question: UserInputQuestion,
  selectedOptionIds: string[],
  freeText: string,
): boolean {
  const count = questionSelectionCount(selectedOptionIds, freeText);
  return count >= question.min_selections && count <= question.max_selections;
}

/**
 * The submission payload for the whole card. Questions the user never touched
 * still appear, with an empty selection, so the server's "answers must include
 * every question exactly once" check reports a limit violation rather than a
 * missing-answer one.
 */
export function buildAnswers(
  questions: readonly UserInputQuestion[],
  selected: Record<string, string[]>,
  freeText: Record<string, string>,
): UserInputAnswer[] {
  return questions.map((question) => {
    const text = (freeText[question.id] ?? "").trim();
    return {
      question_id: question.id,
      selected_option_ids: selected[question.id] ?? [],
      ...(text ? { free_text: text } : {}),
    };
  });
}
