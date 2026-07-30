import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import * as Popover from "@radix-ui/react-popover";
import { useTranslation } from "react-i18next";
import { API_BASE_URL } from "@/lib/api";
import { cn } from "@/lib/utils";
import { parseMarkDate, sourceSiteLabel } from "@/lib/semanticMarks";
import { AnswerSourcesContext, type MessageSource } from "./citationContext";

/**
 * An inline citation: a superscript number bound to the answer's Sources list.
 *
 * Hovering opens a preview card built from data we already retrieved (title,
 * snippet, date) plus the page's og:image, fetched lazily through our own
 * endpoint. A live iframe is deliberately not used: publishers block framing,
 * and it would hand the reader's IP to the site on mere hover.
 */

const OPEN_DELAY_MS = 120;
const CLOSE_DELAY_MS = 200;

interface LinkPreview {
    url: string;
    siteName?: string;
    title?: string;
    description?: string;
    image?: string;
}

async function fetchLinkPreview(url: string): Promise<LinkPreview | null> {
    const response = await fetch(`${API_BASE_URL}/link-preview?url=${encodeURIComponent(url)}`);
    if (!response.ok) return null;
    const body = (await response.json()) as { preview?: LinkPreview | null };
    return body.preview ?? null;
}

function formatPublished(value: string | undefined): string | null {
    if (!value) return null;
    // parseMarkDate, not new Date(): a bare 2026-07-27 is UTC midnight and would
    // print as the 26th anywhere west of Greenwich.
    const parsed = parseMarkDate(value);
    return parsed
        ? parsed.toLocaleDateString(undefined, { year: "numeric", month: "2-digit", day: "2-digit" })
        : value;
}

function CitationCard({ url, title, retrieved }: { url: string; title: string; retrieved?: MessageSource }) {
    const { t } = useTranslation();
    const site = sourceSiteLabel(url);
    // Only the image is missing from what we already have, so a failed or slow
    // preview never blocks the card.
    const preview = useQuery({
        queryKey: ["link-preview", url],
        queryFn: () => fetchLinkPreview(url),
        staleTime: 6 * 60 * 60_000,
        retry: false,
    });
    const published = formatPublished(retrieved?.publishedDate);
    const snippet = retrieved?.snippet ?? preview.data?.description;
    const image = preview.data?.image;

    return (
        <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            referrerPolicy="no-referrer"
            className={cn(
                "group/card block w-[22rem] max-w-[85vw] overflow-hidden rounded-lg border border-border/70",
                "bg-popover text-left shadow-xl shadow-black/10 outline-none transition-colors",
                "hover:border-sky-500/40 focus-visible:border-sky-500/60",
            )}
        >
            {image && (
                <span className="block h-28 w-full overflow-hidden border-b border-border/60 bg-muted/40">
                    <img
                        src={image}
                        alt=""
                        loading="lazy"
                        referrerPolicy="no-referrer"
                        className="size-full object-cover transition-transform duration-500 group-hover/card:scale-[1.03]"
                        onError={(event) => { event.currentTarget.parentElement!.style.display = "none"; }}
                    />
                </span>
            )}
            <span className="block px-3 py-2.5">
                {/* Masthead: publisher and date on one ruled line, the way a
                    clipping is filed. */}
                <span className="flex items-baseline gap-1.5 border-b border-border/50 pb-1.5">
                    <span className="fin-label truncate text-muted-foreground">
                        {preview.data?.siteName ?? site}
                    </span>
                    {published && (
                        <span className="fin-figure ml-auto shrink-0 text-[10px] text-muted-foreground/80">
                            {published}
                        </span>
                    )}
                </span>
                <span className="mt-1.5 line-clamp-2 text-[13px] font-semibold leading-snug text-foreground">
                    {retrieved?.title ?? preview.data?.title ?? title}
                </span>
                {snippet && (
                    <span className="mt-1 line-clamp-3 text-[11px] leading-relaxed text-muted-foreground">
                        {snippet}
                    </span>
                )}
                <span className="fin-label mt-2 flex items-center gap-1 text-sky-600 dark:text-sky-400">
                    {t("marks.openSource")}
                    <span aria-hidden="true" className="transition-transform group-hover/card:translate-x-0.5">↗</span>
                </span>
            </span>
        </a>
    );
}

export function CitationMark({ text, extra }: { text: string; extra: string }) {
    const { t } = useTranslation();
    const { links, retrieved } = useContext(AnswerSourcesContext);
    const [open, setOpen] = useState(false);
    const timer = useRef<number | null>(null);
    useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current); }, []);

    const index = Number(extra);
    const link = Number.isFinite(index) ? links.get(index) : undefined;
    const source = useMemo(
        () => (link ? retrieved.find((candidate) => candidate.url === link.url) : undefined),
        [link, retrieved],
    );

    const schedule = (next: boolean) => {
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setOpen(next), next ? OPEN_DELAY_MS : CLOSE_DELAY_MS);
    };

    // Nothing to point at — the claim still reads, it just carries no citation.
    if (!link) return <>{text}</>;

    return (
        <Popover.Root open={open} onOpenChange={setOpen}>
            <Popover.Trigger asChild>
                <a
                    href={link.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    referrerPolicy="no-referrer"
                    title={source?.title ?? link.title}
                    onMouseEnter={() => schedule(true)}
                    onMouseLeave={() => schedule(false)}
                    onFocus={() => setOpen(true)}
                    onBlur={() => setOpen(false)}
                    onClick={(event) => {
                        // Touch: the first tap opens the card, the second follows the link.
                        if (!open && window.matchMedia("(hover: none)").matches) {
                            event.preventDefault();
                            setOpen(true);
                        }
                    }}
                    // No underline on the cited phrase. The prompt asks the model
                    // to cite every claim it took from search, and it complies —
                    // which meant an answer where nearly every clause carried a
                    // dotted rule and the prose drowned. The marker alone is the
                    // affordance; hovering tints the span it belongs to, so you
                    // can still see exactly how much of the sentence is sourced.
                    className={cn(
                        "group/cite rounded-[3px] text-inherit no-underline transition-colors",
                        "hover:bg-sky-500/10 focus-visible:bg-sky-500/10",
                        open && "bg-sky-500/10",
                    )}
                >
                    {text}
                    {/* A ruled numeral rather than a bare superscript: it reads as
                        a footnote marker you can hit, and it holds its shape next
                        to a metric that is already set in figures. */}
                    <sup
                        className={cn(
                            "fin-figure ml-0.5 rounded-[2px] border px-[2px] py-px text-[8.5px] leading-none transition-colors",
                            "border-sky-600/30 text-sky-700 dark:border-sky-400/30 dark:text-sky-400",
                            "group-hover/cite:border-sky-500/70 group-hover/cite:bg-sky-500/10",
                            open && "border-sky-500/70 bg-sky-500/10",
                        )}
                    >
                        {link.index}
                    </sup>
                    <span className="sr-only">（{t("marks.source")}: {source?.title ?? link.title}）</span>
                </a>
            </Popover.Trigger>
            <Popover.Portal>
                <Popover.Content
                    side="top"
                    align="start"
                    sideOffset={6}
                    collisionPadding={12}
                    // Hover previews must not steal focus or the reading position.
                    onOpenAutoFocus={(event) => event.preventDefault()}
                    onMouseEnter={() => schedule(true)}
                    onMouseLeave={() => schedule(false)}
                    className="z-50 animate-in fade-in-0 zoom-in-95 duration-150"
                >
                    <CitationCard url={link.url} title={link.title} retrieved={source} />
                </Popover.Content>
            </Popover.Portal>
        </Popover.Root>
    );
}
