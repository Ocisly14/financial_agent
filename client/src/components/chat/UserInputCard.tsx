import { useEffect, useMemo, useState } from "react";
import { Check, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { UserInputAnswer, UserInputRequestView } from "@/types/core";
import { Button } from "@/components/ui/button";
import { buildAnswers, isQuestionSatisfied, MAX_FREE_TEXT, questionSelectionCount } from "@/lib/userInputAnswers";
import { cn } from "@/lib/utils";

export function UserInputCard({
    request,
    onSubmit,
    memberTopicName,
}: {
    request: UserInputRequestView;
    onSubmit: (request: UserInputRequestView, answers: UserInputAnswer[]) => Promise<void> | void;
    /** Set only when the question travelled in from a Research member's own
     *  window; then the label names both the Topic and the agent inside it. */
    memberTopicName?: string;
}) {
    const { t } = useTranslation();
    // Missing asked_by = history recorded before the field existed, all of which
    // is the Topic agent's own asking.
    const agent = t(`chat.userInput.agentNames.${request.asked_by ?? "orchestrator"}`, {
        defaultValue: t("chat.userInput.agentNames.fallback"),
    });
    const askedBy = memberTopicName
        ? t("chat.userInput.askedByMember", { topic: memberTopicName, agent })
        : t("chat.userInput.askedBy", { agent });
    const [submitting, setSubmitting] = useState(false);
    const [selected, setSelected] = useState<Record<string, string[]>>(() =>
        Object.fromEntries(
            request.questions.map((question) => [
                question.id,
                request.answers?.find((answer) => answer.question_id === question.id)?.selected_option_ids ?? [],
            ]),
        ),
    );
    const [freeText, setFreeText] = useState<Record<string, string>>(() =>
        Object.fromEntries(
            request.questions.map((question) => [
                question.id,
                request.answers?.find((answer) => answer.question_id === question.id)?.free_text ?? "",
            ]),
        ),
    );
    const interactive = request.status === "pending" && !submitting;
    // Once answered or skipped the card stops being a form and becomes the record
    // of what was chosen — the timeline shows nothing else about it.
    const resolved = request.status !== "pending";

    useEffect(() => {
        if (request.status === "skipped") {
            setSelected(Object.fromEntries(request.questions.map((question) => [question.id, []])));
            setFreeText(Object.fromEntries(request.questions.map((question) => [question.id, ""])));
        } else if (request.status === "answered") {
            setSelected(Object.fromEntries(request.questions.map((question) => [
                question.id,
                request.answers?.find((answer) => answer.question_id === question.id)?.selected_option_ids ?? [],
            ])));
            setFreeText(Object.fromEntries(request.questions.map((question) => [
                question.id,
                request.answers?.find((answer) => answer.question_id === question.id)?.free_text ?? "",
            ])));
        }
    }, [request.status, request.answers, request.questions]);

    const valid = useMemo(
        () => request.questions.every((question) =>
            isQuestionSatisfied(question, selected[question.id] ?? [], freeText[question.id] ?? "")),
        [request.questions, selected, freeText],
    );

    const toggle = (questionId: string, optionId: string, max: number) => {
        if (!interactive) return;
        setSelected((current) => {
            const values = current[questionId] ?? [];
            if (values.includes(optionId)) {
                return { ...current, [questionId]: values.filter((id) => id !== optionId) };
            }
            if (questionSelectionCount(values, freeText[questionId] ?? "") >= max) return current;
            return { ...current, [questionId]: [...values, optionId] };
        });
    };

    const submit = async () => {
        if (!interactive || !valid) return;
        setSubmitting(true);
        try {
            await onSubmit(request, buildAnswers(request.questions, selected, freeText));
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <section
            className="mt-4 overflow-hidden rounded-lg border border-sep bg-fill-1"
            aria-label={t("chat.userInput.title")}
            data-testid="user-input-card"
        >
            <div className="border-b border-sep px-4 pt-3 pb-2">
                <span className="text-xs text-muted-foreground">{askedBy}</span>
            </div>
            <div className="space-y-5 px-4 py-4">
                {request.questions.map((question, questionIndex) => {
                    const values = selected[question.id] ?? [];
                    const text = freeText[question.id] ?? "";
                    const atMax = questionSelectionCount(values, text) >= question.max_selections;
                    return (
                        <fieldset key={question.id} className="min-w-0 space-y-2.5">
                            <legend className="w-full">
                                {question.header ? (
                                    <span className="fin-label block text-label-3">{question.header}</span>
                                ) : request.questions.length > 1 ? (
                                    <span className="fin-label block text-label-3">
                                        {t("chat.userInput.questionNumber", { number: questionIndex + 1 })}
                                    </span>
                                ) : null}
                                <span className="mt-1 block text-sm font-semibold leading-6 text-label-1">
                                    {question.question}
                                </span>
                                {resolved ? null : (
                                    <span className="mt-0.5 block text-xs text-label-3">
                                        {t("chat.userInput.selectionRange", {
                                            min: question.min_selections,
                                            max: question.max_selections,
                                        })}
                                    </span>
                                )}
                            </legend>
                            {resolved ? (
                                <div className="flex flex-wrap gap-1.5">
                                    {question.options.filter((option) => values.includes(option.id)).map((option) => (
                                        <span
                                            key={option.id}
                                            className="inline-flex items-center gap-1.5 rounded-md border border-brand bg-brand-sub px-2 py-1 text-xs font-medium text-label-1"
                                        >
                                            <Check className="size-3 text-brand" />
                                            {option.label}
                                        </span>
                                    ))}
                                    {text ? (
                                        <span className="inline-flex items-center gap-1.5 rounded-md border border-brand bg-brand-sub px-2 py-1 text-xs font-medium text-label-1">
                                            <Check className="size-3 text-brand" />
                                            {text}
                                        </span>
                                    ) : null}
                                    {values.length === 0 && !text ? (
                                        <span className="text-xs text-label-3">{t("chat.userInput.nothingChosen")}</span>
                                    ) : null}
                                </div>
                            ) : (
                                <>
                                    <div className="grid gap-2 sm:grid-cols-2">
                                        {question.options.map((option) => {
                                            const checked = values.includes(option.id);
                                            const disabled = !interactive || (atMax && !checked);
                                            return (
                                                <button
                                                    key={option.id}
                                                    type="button"
                                                    role="checkbox"
                                                    aria-checked={checked}
                                                    disabled={disabled}
                                                    onClick={() => toggle(question.id, option.id, question.max_selections)}
                                                    className={cn(
                                                        "flex min-h-14 items-start gap-3 rounded-md border px-3 py-2.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2",
                                                        checked
                                                            ? "border-brand bg-brand-sub"
                                                            : "border-sep bg-background hover:bg-fill-2",
                                                        disabled && !checked && "cursor-not-allowed opacity-45",
                                                    )}
                                                >
                                                    <span
                                                        aria-hidden="true"
                                                        className={cn(
                                                            "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-sm border",
                                                            checked ? "border-brand bg-brand text-white" : "border-sep-strong bg-raised",
                                                        )}
                                                    >
                                                        {checked ? <Check className="size-3" /> : null}
                                                    </span>
                                                    <span className="min-w-0 flex-1">
                                                        <span className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-label-1">
                                                            {option.label}
                                                            {option.recommended ? (
                                                                <span className="inline-flex items-center gap-1 rounded-sm bg-brand-sub px-1.5 py-0.5 text-[10px] font-semibold text-brand">
                                                                    <Sparkles className="size-2.5" />
                                                                    {t("chat.userInput.recommended")}
                                                                </span>
                                                            ) : null}
                                                        </span>
                                                        {option.description ? (
                                                            <span className="mt-1 block text-xs leading-5 text-label-2">
                                                                {option.description}
                                                            </span>
                                                        ) : null}
                                                    </span>
                                                </button>
                                            );
                                        })}
                                    </div>
                                    {/* The options are never the whole answer space: a question
                                        the user cannot answer from the list still has somewhere
                                        to go. Non-blank text is one selection, so it is disabled
                                        exactly when an unchecked option would be. */}
                                    <label className="block">
                                        <span className="mb-1 block text-xs text-label-3">
                                            {t("chat.userInput.freeTextLabel")}
                                        </span>
                                        <input
                                            type="text"
                                            value={text}
                                            maxLength={MAX_FREE_TEXT}
                                            readOnly={!interactive}
                                            disabled={interactive && atMax && !text}
                                            placeholder={t("chat.userInput.freeTextPlaceholder")}
                                            onChange={(event) =>
                                                setFreeText((current) => ({ ...current, [question.id]: event.target.value }))
                                            }
                                            className={cn(
                                                "w-full rounded-md border px-3 py-2 text-sm text-label-1 outline-none transition-colors placeholder:text-label-3 focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2",
                                                text ? "border-brand bg-brand-sub" : "border-sep bg-background",
                                                interactive && atMax && !text && "cursor-not-allowed opacity-45",
                                            )}
                                        />
                                    </label>
                                </>
                            )}
                        </fieldset>
                    );
                })}
            </div>
            <div className="flex items-center justify-end gap-3 border-t border-sep bg-background px-4 py-3">
                {resolved ? (
                    <span className="text-xs text-label-3">
                        {request.status === "answered"
                            ? t("chat.userInput.answered")
                            : t("chat.userInput.skipped")}
                    </span>
                ) : (
                    <Button
                        type="button"
                        size="sm"
                        disabled={!interactive || !valid}
                        onClick={() => void submit()}
                    >
                        {submitting ? t("chat.userInput.submitting") : t("chat.userInput.submit")}
                    </Button>
                )}
            </div>
        </section>
    );
}
