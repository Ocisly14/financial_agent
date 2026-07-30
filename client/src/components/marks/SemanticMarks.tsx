import React, { useContext } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import {
    classifyLevelRole,
    classifyMetricDirection,
    decodeMarkPayload,
    figureFreshness,
    parseMarkDate,
    type LevelRole,
    type MetricDirection,
} from "@/lib/semanticMarks";
import { MessageTimeContext } from "../stockChartContext";
import { CitationMark } from "./CitationMark";

/**
 * Rendering half of the semantic marks (see lib/semanticMarks.ts for the syntax
 * the orchestrator writes). Every appearance decision lives here: the model
 * marks meaning only, so colour, weight, and layout are ours to pick.
 *
 * THE COLOUR CONTRACT — each hue does exactly one job, and no mark borrows
 * another's. An earlier pass had amber carrying the thesis, catalysts, the
 * uncertainty wave AND citations at once, which meant colour had stopped
 * telling the reader anything.
 *
 *   gold      the analyst's stance          thesis card, and nothing else
 *   rose      the failure mode              risk card chrome
 *   emerald   / rose   direction            metric figures only
 *   sky       provenance — someone else's   citations and outbound links
 *             words, not ours
 *   neutral   uncertainty, time, levels     wave, date rules, level rules
 *
 * Uncertainty, time and price levels are deliberately hue-free: they are
 * encoded by RULE SHAPE instead (wavy, boxed, and four distinct underline
 * styles), which survives greyscale, colour-blindness, and a paragraph that
 * already has four coloured figures in it.
 */

/** Direction is derived client-side, never sent by the model. */
const DIRECTION_CLASS: Record<MetricDirection, string> = {
    up: "text-emerald-700 dark:text-emerald-400",
    down: "text-rose-700 dark:text-rose-400",
    flat: "text-foreground",
};

/**
 * A figure the reader would act on. The number carries the direction hue; its
 * basis rides alongside behind a thin divider rather than in a filled pill, so a
 * sentence with four metrics in it still reads as prose.
 *
 * An earlier pass also drew a direction-tinted hairline under every figure to
 * make a paragraph scan like a ledger. At the opacity that stayed out of the
 * way it was invisible, and at the opacity that read it made body copy dirty —
 * so RULES now belong to `level` alone, where the shape is the whole encoding.
 */
function MetricMark({ text, extra }: { text: string; extra: string }) {
    const direction = classifyMetricDirection(text, extra);
    return (
        <span className="whitespace-nowrap">
            <span className={cn("fin-figure font-semibold", DIRECTION_CLASS[direction])}>{text}</span>
            {extra && (
                <span
                    className={cn(
                        "fin-figure ml-1 border-l pl-1 align-[0.5px] text-[10px] font-normal leading-none",
                        direction === "flat"
                            ? "border-border text-label-2"
                            : cn(DIRECTION_CLASS[direction], "border-current/30 opacity-80"),
                    )}
                >
                    {extra}
                </span>
            )}
        </span>
    );
}

/**
 * Price levels are structural, not directional — a support at 180 is not
 *"good news" — so they take no hue at all. The role is carried by the rule
 * under (or over) the number, which reads as a chart annotation: a support
 * sits on a line, a resistance hangs beneath one, a stop is dashed, a target
 * dotted.
 */
const LEVEL_RULE: Record<LevelRole, string> = {
    support: "border-b border-foreground/45",
    resistance: "border-t border-foreground/45",
    stop: "border-b border-dashed border-foreground/55",
    target: "border-b border-dotted border-foreground/55",
    level: "border-b border-border",
};

function LevelMark({ text, extra }: { text: string; extra: string }) {
    const { t } = useTranslation();
    const role = classifyLevelRole(extra);
    const label = t(`marks.${role}`);
    return (
        <span className="whitespace-nowrap" title={extra || label}>
            {/* A bare price needs no"LEVEL" tag — the role chip only earns its
                space when it says something the number does not. */}
            {role !== "level" && (
                <span className="fin-label mr-1 align-[1.5px] text-label-2">{label}</span>
            )}
            <span className={cn("fin-figure pb-px text-foreground", LEVEL_RULE[role])}>{text}</span>
        </span>
    );
}

/** Local-midnight day delta, so"today" means today in the reader's timezone. */
function daysUntil(date: Date): number {
    const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    return Math.round((startOfDay(date) - startOfDay(new Date())) / 86_400_000);
}

/**
 * A dated event. The date is boxed like a calendar cell rather than tinted, and
 * anything inside the next fortnight also shows its countdown — the form an
 * analyst actually reads a catalyst in ("T-3", not"2026-08-01").
 */
function CatalystMark({ text, extra }: { text: string; extra: string }) {
    const parsed = parseMarkDate(extra);
    const offset = parsed ? daysUntil(parsed) : null;
    const past = offset !== null && offset < 0;
    const countdown = offset !== null && offset >= 0 && offset <= 14 ? (offset === 0 ? "T" : `T-${offset}`) : null;
    if (!extra) return <span className="text-foreground">{text}</span>;
    return (
        <span className="whitespace-nowrap">
            <span className={cn("text-foreground", past && "text-label-2")}>{text}</span>
            <span
                className={cn(
                    "ml-1 inline-flex items-baseline gap-1 rounded-[3px] border px-1 align-[1px]",
                    "fin-figure text-[10px] leading-[1.5]",
                    past ? "border-border/60 text-label-2/60" : "border-foreground/25 text-foreground/80",
                )}
            >
                <span>
                    {parsed
                        ? parsed.toLocaleDateString(undefined, { month: "2-digit", day: "2-digit" })
                        : extra}
                </span>
                {countdown && (
                    <span className="border-l border-foreground/20 pl-1 font-semibold tracking-tight">
                        {countdown}
                    </span>
                )}
            </span>
        </span>
    );
}

/**
 * The most valuable mark and the one that must never be foldable: analysts need
 * to see which statements are grounded and which are synthesis, inline.
 *
 * Hue-free on purpose. The wave alone says"unsettled"; painting it amber put
 * an unverified rumour in the same colour as the answer's own thesis, which is
 * exactly backwards.
 */
function UnverifiedMark({ text, extra }: { text: string; extra: string }) {
    const { t } = useTranslation();
    const reason = extra || t("marks.unverifiedTitle");
    return (
        <span
            title={reason}
            className={cn(
                "text-label-2 underline decoration-wavy decoration-from-font underline-offset-4",
                "decoration-muted-foreground/60 transition-colors hover:text-foreground hover:decoration-foreground/70",
            )}
        >
            {text}
            <span aria-hidden="true" className="ml-0.5 align-super text-[9px] text-label-2/80">
                ?
            </span>
            <span className="sr-only">（{reason}）</span>
        </span>
    );
}

/**
 * How old the figures in this answer are. Message-level on purpose: staleness is
 * a property of the snapshot the whole answer was written from, so stamping a
 * dot after every single metric repeated one fact ten times and read as noise.
 * Rendered once, at the foot of the answer, and only when it is worth saying.
 */
export const FreshnessNote: React.FC = () => {
    const { t } = useTranslation();
    const sentAtMs = useContext(MessageTimeContext);
    const { level, minutes } = figureFreshness(sentAtMs, Date.now());
    if (sentAtMs === null || level === "fresh") return null;
    const time = new Date(sentAtMs).toLocaleString(undefined, {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
    });
    return (
        <p
            className={cn(
                "mt-3 flex items-center gap-1.5 text-[11px]",
                level === "stale" ? "text-amber-700 dark:text-amber-400/90" : "text-label-2",
            )}
        >
            <span
                aria-hidden="true"
                className={cn(
                    "inline-block size-1 shrink-0 rounded-full",
                    level === "stale" ? "bg-amber-500" : "bg-muted-foreground/60",
                )}
            />
            {t(level === "stale" ? "marks.figureStale" : "marks.figureAging", { time, minutes })}
        </p>
    );
};

/** Dispatch for `<Mark k="…" t="…" x="…" />`, emitted by rewriteSemanticMarks. */
export const InlineMark: React.FC<{ k?: string; t?: string; x?: string }> = ({ k, t: encodedText, x }) => {
    const text = decodeMarkPayload(encodedText ?? "");
    const extra = decodeMarkPayload(x ?? "");
    if (!text) return null;
    switch (k) {
        case"metric":
            return <MetricMark text={text} extra={extra} />;
        case"level":
            return <LevelMark text={text} extra={extra} />;
        case"catalyst":
            return <CatalystMark text={text} extra={extra} />;
        case"unverified":
            return <UnverifiedMark text={text} extra={extra} />;
        case"cite":
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
 * Both are tearsheet blocks: the label sits on the baseline of a hairline rule
 * that runs to the right edge, the way a section head does on a printed
 * research note. Gold is the thesis and only the thesis; risk keeps a neutral
 * surface with a rose rule so it reads as serious without competing with a
 * metric that happens to be down.
 */
const CARD_STYLE = {
    thesis: {
        frame: "border-amber-500/30 bg-gradient-to-b from-amber-500/[0.08] to-amber-500/[0.02]",
        spine: "bg-amber-500",
        rule: "bg-amber-500/25",
        label: "text-amber-700 dark:text-amber-400",
    },
    risk: {
        frame: "border-border/70 bg-muted/25",
        spine: "bg-rose-500/70",
        rule: "bg-rose-500/20",
        label: "text-rose-700 dark:text-rose-400",
    },
} as const;

export const MarkCard: React.FC<{ kind: "thesis" |"risk"; children: React.ReactNode }> = ({ kind, children }) => {
    const { t } = useTranslation();
    const style = CARD_STYLE[kind];
    return (
        <section className={cn("my-3 overflow-hidden rounded-lg border", style.frame)}>
            <div className="flex gap-3">
                <span aria-hidden="true" className={cn("w-[3px] shrink-0", style.spine)} />
                <div className="min-w-0 flex-1 py-2 pr-3">
                    {/* Label on the baseline of a rule that runs out to the edge.
                        The rule sweeps in once on mount — the answer's single
                        piece of motion, spent on its most important line. */}
                    <div className="mb-1.5 flex items-center gap-2">
                        <span className={cn("fin-label shrink-0", style.label)}>{t(`marks.${kind}`)}</span>
                        <span
                            aria-hidden="true"
                            className={cn("h-px flex-1 origin-left motion-safe:animate-[fin-rule-sweep_600ms_ease-out]", style.rule)}
                        />
                    </div>
                    <div
                        className={cn(
                            "min-w-0 [&>*:last-child]:mb-0",
                            kind === "thesis" && "text-[15px] leading-relaxed",
                        )}
                    >
                        {children}
                    </div>
                </div>
            </div>
        </section>
    );
};
