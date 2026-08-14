import type { UserInputAnswer, UserInputRequestView } from "@/types/core";

/**
 * One outstanding question card belonging to a member Topic of this Research.
 *
 * The card is only a pointer: the request itself lives on that member's own
 * session, which is also where the answer is delivered. Nothing here is the
 * source of truth for the request's state — it mirrors what the UI has seen.
 */
export type MemberInputCard = {
  topicId: string;
  topicName: string;
  requestId: string;
  status: UserInputRequestView["status"];
};

/**
 * The human-readable rendering of a structured answer, sent as the request's
 * message text.
 *
 * It is NOT what the agent reads: the server recomputes the same text from the
 * validated answers (`validateUserInputAnswers`) and injects it as its own
 * labelled block, and no chat bubble is rendered for it either. This copy only
 * keeps the request self-describing — hence the deliberately identical wording.
 */
export function answerText(request: UserInputRequestView, answers: UserInputAnswer[]): string {
  const byQuestion = new Map(answers.map((answer) => [answer.question_id, answer]));
  return request.questions
    .map((question) => {
      const answer = byQuestion.get(question.id);
      const selected = new Set(answer?.selected_option_ids ?? []);
      // Iterate the options, not the answer ids: the line then reads in the
      // order the user saw, regardless of the order they clicked.
      const parts = question.options.filter((option) => selected.has(option.id)).map((option) => option.label);
      // Same wording as `validateUserInputAnswers` on the server, so the text
      // the agent reads does not depend on which path delivered the answer.
      if (answer?.free_text) parts.push(`Other — "${answer.free_text}"`);
      return `${question.question}: ${parts.join(", ")}`;
    })
    .join("\n");
}

/**
 * Whether the Research turn should now be resumed. True only once every card
 * this turn produced has been resolved — answering one member at a time would
 * otherwise wake the controller with partial information, and it would draw a
 * conclusion from it.
 */
export function shouldContinueResearch(cards: MemberInputCard[]): boolean {
  return cards.length > 0 && cards.every((card) => card.status !== "pending");
}
