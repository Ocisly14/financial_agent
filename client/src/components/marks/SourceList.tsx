import React, { useContext } from "react";
import { cn } from "@/lib/utils";
import { decodeMarkPayload, parseMarkDate, sourceSiteLabel, type AnswerSourceLink } from "@/lib/semanticMarks";
import { AnswerSourcesContext } from "./citationContext";

/**
 * The answer's Sources section, set as compact cards instead of a numbered list
 * of long blue links — six headline-length titles wrapping across three lines
 * each was the noisiest block on the page.
 *
 * Two lines per entry: the title, then publisher and date. The index sits in the
 * same ruled box the inline `[[cite:…]]` marker uses, so following a superscript
 * ③ down to entry 3 is a shape match rather than a hunt.
 */

function publishedLabel(value: string | undefined): string | null {
    if (!value) return null;
    const parsed = parseMarkDate(value);
    return parsed ? parsed.toLocaleDateString(undefined, { year: "numeric", month: "2-digit", day: "2-digit" }) : null;
}

function SourceCard({ item }: { item: AnswerSourceLink }) {
    const { retrieved } = useContext(AnswerSourcesContext);
    const source = retrieved.find((candidate) => candidate.url === item.url);
    const published = publishedLabel(source?.publishedDate);

    return (
        <a
            href={item.url}
            target="_blank"
            rel="noopener noreferrer"
            referrerPolicy="no-referrer"
            className={cn(
                "group flex min-w-0 items-start gap-2.5 rounded-md border border-sep bg-fill-1 px-2.5 py-2",
                "no-underline transition-colors hover:border-brand/40 hover:bg-brand/[0.06]",
                "focus-visible:border-brand/60 focus-visible:outline-none",
            )}
        >
            <span
                className={cn(
                    "fin-figure mt-px shrink-0 rounded-[3px] border px-1 py-px text-[10px] leading-[1.4]",
                    "border-brand/30 text-brand ",
                    "group-hover:border-brand/70 group-hover:bg-brand/10",
                )}
            >
                {item.index}
            </span>
            <span className="min-w-0 flex-1">
                {/* Two lines, not one: at two columns a truncated headline
                    ("Tesla (TSLA) Earnings: Lates…") loses the part that tells
                    you whether it is worth opening. */}
                <span className="line-clamp-2 text-[13px] font-medium leading-snug text-foreground">
                    {source?.title ?? item.title}
                </span>
                <span className="mt-0.5 flex items-baseline gap-1.5 text-[10px] text-label-2">
                    <span className="truncate">{sourceSiteLabel(item.url)}</span>
                    {published && <span className="fin-figure ml-auto shrink-0 opacity-80">{published}</span>}
                </span>
            </span>
        </a>
    );
}

/** Dispatch for `<SourceList items="…" />`, emitted by rewriteSourceList. */
export const SourceListBlock: React.FC<{ items?: string }> = ({ items }) => {
    let parsed: AnswerSourceLink[] = [];
    try {
        parsed = JSON.parse(decodeMarkPayload(items ?? "")) as AnswerSourceLink[];
    } catch {
        return null;
    }
    if (!Array.isArray(parsed) || parsed.length === 0) return null;

    return (
        <div className="mb-3 mt-2 grid gap-1.5 sm:grid-cols-2">
            {parsed.map((item) => (
                <SourceCard key={`${item.index}-${item.url}`} item={item} />
            ))}
        </div>
    );
};
