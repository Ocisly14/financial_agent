import { useEffect, useMemo, useState } from "react";
import { Check, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { UserInputAnswer, UserInputRequestView } from "@/types/core";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function UserInputCard({
    request,
    onSubmit,
}: {
    request: UserInputRequestView;
    onSubmit: (request: UserInputRequestView, answers: UserInputAnswer[]) => Promise<void> | void;
}) {
    const { t } = useTranslation();
    const [submitting, setSubmitting] = useState(false);
    const [selected, setSelected] = useState<Record<string, string[]>>(() =>
        Object.fromEntries(
            request.questions.map((question) => [
                question.id,
                request.answers?.find((answer) => answer.question_id === question.id)?.selected_option_ids ?? [],
            ]),
        ),
    );
    const interactive = request.status === "pending" && !submitting;

    useEffect(() => {
        if (request.status === "skipped") {
            setSelected(Object.fromEntries(request.questions.map((question) => [question.id, []])));
        } else if (request.status === "answered") {
            setSelected(Object.fromEntries(request.questions.map((question) => [
                question.id,
                request.answers?.find((answer) => answer.question_id === question.id)?.selected_option_ids ?? [],
            ])));
        }
    }, [request.status, request.answers, request.questions]);

    const valid = useMemo(
        () => request.questions.every((question) => {
            const count = selected[question.id]?.length ?? 0;
            return count >= question.min_selections && count <= question.max_selections;
        }),
        [request.questions, selected],
    );

    const toggle = (questionId: string, optionId: string, max: number) => {
        if (!interactive) return;
        setSelected((current) => {
            const values = current[questionId] ?? [];
            if (values.includes(optionId)) {
                return { ...current, [questionId]: values.filter((id) => id !== optionId) };
            }
            if (values.length >= max) return current;
            return { ...current, [questionId]: [...values, optionId] };
        });
    };

    const submit = async () => {
        if (!interactive || !valid) return;
        setSubmitting(true);
        try {
            await onSubmit(
                request,
                request.questions.map((question) => ({
                    question_id: question.id,
                    selected_option_ids: selected[question.id] ?? [],
                })),
            );
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
            <div className="space-y-5 px-4 py-4">
                {request.questions.map((question, questionIndex) => {
                    const values = selected[question.id] ?? [];
                    const atMax = values.length >= question.max_selections;
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
                                <span className="mt-0.5 block text-xs text-label-3">
                                    {t("chat.userInput.selectionRange", {
                                        min: question.min_selections,
                                        max: question.max_selections,
                                    })}
                                </span>
                            </legend>
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
                        </fieldset>
                    );
                })}
            </div>
            <div className="flex items-center justify-end gap-3 border-t border-sep bg-background px-4 py-3">
                {request.status !== "pending" ? (
                    <span className="text-xs text-label-3">
                        {request.status === "answered"
                            ? t("chat.userInput.answered")
                            : t("chat.userInput.skipped")}
                    </span>
                ) : null}
                <Button
                    type="button"
                    size="sm"
                    disabled={!interactive || !valid}
                    onClick={() => void submit()}
                >
                    {submitting ? t("chat.userInput.submitting") : t("chat.userInput.submit")}
                </Button>
            </div>
        </section>
    );
}
