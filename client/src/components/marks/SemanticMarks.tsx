import React, { useContext } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import {
    classifyLevelRole,
    classifyMetricDirection,
    decodeMarkPayload,
    figureFreshness,
    parseMarkDate,
    type MetricDirection,
} from "@/lib/semanticMarks";
import { MessageTimeContext } from "../stockChartContext";
import { CitationMark } from "./CitationMark";

/**
 * Rendering half of the semantic marks (see lib/semanticMarks.ts for the syntax
 * the orchestrator writes). Every appearance decision lives here: the model
 * marks meaning only, so colour, weight, and layout are ours to pick.
 *
 * Inline marks stay inline — they change weight, numerals, and underline shape
 * but never break the reading flow. Only thesis and risk earn a card.
 */

/** Direction is derived client-side, never sent by the model. */
const DIRECTION_CLASS: Record<MetricDirection, string> = {
    up: "text-emerald-700 dark:text-emerald-400",
    down: "text-rose-700 dark:text-rose-400",
    flat: "text-foreground",
};

function FreshnessDot({ sentAtMs }: { sentAtMs: number | null }) {
    const { t } = useTranslation();
    const { level, minutes } = figureFreshness(sentAtMs, Date.now());
    if (level === "fresh" || sentAtMs === null) return null;
    const time = new Date(sentAtMs).toLocaleString(undefined, {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
    });
    return (
        <span
            title={t(level === "stale" ? "marks.figureStale" : "marks.figureAging", { time, minutes })}
            className={cn(
                "ml-0.5 inline-block size-1 shrink-0 translate-y-[-3px] rounded-full",
                level === "stale" ? "bg-amber-500" : "bg-muted-foreground/50",
            )}
        />
    );
}

function MetricMark({ text, extra }: { text: string; extra: string }) {
    const sentAtMs = useContext(MessageTimeContext);
    const direction = classifyMetricDirection(text, extra);
    return (
        <span className="whitespace-nowrap">
            <span className={cn("font-mono font-semibold tabular-nums", DIRECTION_CLASS[direction])}>{text}</span>
            {extra && (
                <span className="ml-1 rounded bg-muted/70 px-1 py-px align-[1px] font-mono text-[10px] tabular-nums text-muted-foreground">
                    {extra}
                </span>
            )}
            <FreshnessDot sentAtMs={sentAtMs} />
        </span>
    );
}

function LevelMark({ text, extra }: { text: string; extra: string }) {
    const { t } = useTranslation();
    const role = classifyLevelRole(extra);
    const label = t(`marks.${role}`);
    return (
        <span className="whitespace-nowrap" title={extra || label}>
            {/* A bare price needs no "LEVEL" tag — the role chip only earns its
                space when it says something the number does not. */}
            {role !== "level" && (
                <span className="mr-1 align-[1px] text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
            )}
            <span className="border-b border-dashed border-current/50 pb-px font-mono tabular-nums text-foreground">
                {text}
            </span>
        </span>
    );
}

function CatalystMark({ text, extra }: { text: string; extra: string }) {
    const parsed = parseMarkDate(extra);
    const past = parsed !== null && parsed.getTime() < Date.now();
    return (
        <span className="whitespace-nowrap">
            <span className="text-foreground">{text}</span>
            {extra && (
                <span className={cn(
                    "ml-1 rounded border px-1 py-px align-[1px] font-mono text-[10px] tabular-nums",
                    past
                        ? "border-border/60 text-muted-foreground/70"
                        : "border-amber-500/40 text-amber-700 dark:text-amber-400",
                )}>
                    {parsed
                        ? parsed.toLocaleDateString(undefined, { year: "numeric", month: "2-digit", day: "2-digit" })
                        : extra}
                </span>
            )}
        </span>
    );
}

/**
 * The most valuable mark and the one that must never be foldable: analysts need
 * to see which statements are grounded and which are synthesis, inline.
 */
function UnverifiedMark({ text, extra }: { text: string; extra: string }) {
    const { t } = useTranslation();
    const reason = extra || t("marks.unverifiedTitle");
    return (
        <span
            title={reason}
            className="text-muted-foreground underline decoration-amber-500/70 decoration-wavy decoration-from-font underline-offset-4"
        >
            {text}
            <span aria-hidden="true" className="ml-0.5 align-super text-[9px] text-amber-600 dark:text-amber-400">?</span>
            <span className="sr-only">（{reason}）</span>
        </span>
    );
}

/** Dispatch for `<Mark k="…" t="…" x="…" />`, emitted by rewriteSemanticMarks. */
export const InlineMark: React.FC<{ k?: string; t?: string; x?: string }> = ({ k, t: encodedText, x }) => {
    const text = decodeMarkPayload(encodedText ?? "");
    const extra = decodeMarkPayload(x ?? "");
    if (!text) return null;
    switch (k) {
        case "metric":
            return <MetricMark text={text} extra={extra} />;
        case "level":
            return <LevelMark text={text} extra={extra} />;
        case "catalyst":
            return <CatalystMark text={text} extra={extra} />;
        case "unverified":
            return <UnverifiedMark text={text} extra={extra} />;
        case "cite":
            return <CitationMark text={text} extra={extra} />;
        default:
            return <>{text}</>;
    }
};

/**
 * Card chrome for thesis and risk. The body is rendered by the caller, which
 * owns the markdown pipeline — keeps this module free of a cycle back into
 * MarkdownRenderer.
 *
 * Thesis carries the amber accent shared with the live chart marks; risk stays
 * on a neutral surface with a rose spine so it reads as serious without
 * colliding with a metric that happens to be down.
 */
export const MarkCard: React.FC<{ kind: "thesis" | "risk"; children: React.ReactNode }> = ({ kind, children }) => {
    const { t } = useTranslation();
    return (
        <section
            className={cn(
                "my-3 overflow-hidden rounded-lg border",
                kind === "thesis"
                    ? "border-amber-500/30 bg-amber-500/[0.06]"
                    : "border-border/70 bg-muted/30",
            )}
        >
            <div className="flex gap-3">
                <span
                    aria-hidden="true"
                    className={cn("w-0.5 shrink-0", kind === "thesis" ? "bg-amber-500" : "bg-rose-500/70")}
                />
                <div className="min-w-0 flex-1 py-2 pr-3">
                    <span className={cn(
                        "mb-1 block text-[10px] font-semibold uppercase tracking-[0.14em]",
                        kind === "thesis" ? "text-amber-700 dark:text-amber-400" : "text-rose-700 dark:text-rose-400",
                    )}>
                        {t(`marks.${kind}`)}
                    </span>
                    <div className={cn("min-w-0 [&>*:last-child]:mb-0", kind === "thesis" && "text-[15px] leading-relaxed")}>
                        {children}
                    </div>
                </div>
            </div>
        </section>
    );
};
