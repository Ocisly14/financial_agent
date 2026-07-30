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
            className="block w-[22rem] max-w-[85vw] overflow-hidden rounded-lg border border-border/70 bg-popover text-left shadow-lg outline-none transition-colors hover:border-amber-500/40 focus-visible:border-amber-500/60"
        >
            {image && (
                <span className="block h-28 w-full overflow-hidden border-b border-border/60 bg-muted/40">
                    <img
                        src={image}
                        alt=""
                        loading="lazy"
                        referrerPolicy="no-referrer"
                        className="size-full object-cover"
                        onError={(event) => { event.currentTarget.parentElement!.style.display = "none"; }}
                    />
                </span>
            )}
            <span className="block px-3 py-2">
                <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                    <span className="truncate">{preview.data?.siteName ?? site}</span>
                    {published && <span className="shrink-0 font-mono tabular-nums">· {published}</span>}
                </span>
                <span className="mt-1 block text-[13px] font-medium leading-snug text-foreground line-clamp-2">
                    {retrieved?.title ?? preview.data?.title ?? title}
                </span>
                {snippet && (
                    <span className="mt-1 block text-[11px] leading-relaxed text-muted-foreground line-clamp-3">
                        {snippet}
                    </span>
                )}
                <span className="mt-2 block text-[10px] uppercase tracking-wider text-amber-600 dark:text-amber-400">
                    {t("marks.openSource")} ↗
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
                    className={cn(
                        "underline decoration-dotted decoration-muted-foreground/60 underline-offset-4",
                        "hover:decoration-amber-500 focus-visible:decoration-amber-500",
                    )}
                >
                    {text}
                    <sup className="ml-0.5 font-mono text-[9px] tabular-nums text-amber-600 dark:text-amber-400">
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
