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
 * The human-readable message that accompanies a structured answer. It becomes
 * the `user_message` on that member's timeline, so it reads as prose rather
 * than as a payload dump.
 */
export function answerText(request: UserInputRequestView, answers: UserInputAnswer[]): string {
  const byQuestion = new Map(answers.map((answer) => [answer.question_id, answer.selected_option_ids]));
  return request.questions
    .map((question) => {
      const selected = new Set(byQuestion.get(question.id) ?? []);
      // Iterate the options, not the answer ids: the line then reads in the
      // order the user saw, regardless of the order they clicked.
      const labels = question.options.filter((option) => selected.has(option.id)).map((option) => option.label);
      return `${question.question}: ${labels.join(", ")}`;
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
