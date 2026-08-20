import Markdown from "markdown-to-jsx";
import React, { useMemo } from "react";
import { cn } from "@/lib/utils";
import { stripIncompleteTrailingTag } from "@/lib/stockChart";
import StockChartBlock from "./StockChart";
import { StreamingContext } from "./stockChartContext";
import { FreshnessNote, InlineMark, MarkCard } from "./marks/SemanticMarks";
import {
    BLOCK_TAG,
    INLINE_TAG,
    SOURCE_LIST_TAG,
    decodeMarkPayload,
    parseAnswerSources,
    rewriteSemanticMarks,
    rewriteSourceList,
} from "@/lib/semanticMarks";
import { SourceListBlock } from "./marks/SourceList";
import { AnswerSourcesContext, type MessageSource } from "./marks/citationContext";

/**
 * Extracts plain text from React children (recursively)
 */
const extractText = (children: React.ReactNode): string => {
    if (typeof children === 'string') {
        return children;
    }
    if (Array.isArray(children)) {
        return children.map(extractText).join('');
    }
    if (React.isValidElement(children)) {
        const props = children.props as { children?: React.ReactNode };
        if (props.children) {
            return extractText(props.children);
        }
    }
    return '';
};

/**
 * Removes markdown formatting and emojis from text
 */
const stripLeadingNumbering = (text: string): string => {
    const numberingPattern = /^\s*(?:第\s*)?\d+(?:\.\d+)*(?:[.)、:：]\s*|\s*-\s*)/i;
    let result = text;

    while (numberingPattern.test(result)) {
        result = result.replace(numberingPattern, '').trimStart();
    }

    return result;
};

let generalEmojiRegex: RegExp | null = null;
try {
    generalEmojiRegex = /[\p{Extended_Pictographic}\p{Emoji_Presentation}\p{Emoji}]/gu;
} catch (_error) {
    generalEmojiRegex = null;
}

const removeEmojiCharacters = (text: string): string => {
    if (!text) {
        return '';
    }

    let result = text;
    if (generalEmojiRegex) {
        result = result.replace(generalEmojiRegex, '');
    }

    return result
        .replace(/[\u{1F300}-\u{1F9FF}]/gu, '') // Remove emojis (supplementary plane)
        .replace(/[\u{2600}-\u{26FF}]/gu, '')   // Remove misc symbols (sun, umbrella, etc.)
        .replace(/[\u{2700}-\u{27BF}]/gu, '')   // Remove dingbats
        .replace(/[\u{1F600}-\u{1F64F}]/gu, '') // Remove emoticons
        .replace(/[\u{1F680}-\u{1F6FF}]/gu, '') // Remove transport and map symbols
        .replace(/[\u{1F1E0}-\u{1F1FF}]/gu, '') // Remove flags
        .replace(/[\u{2300}-\u{23FF}]/gu, '')   // Remove misc technical
        .replace(/[\u{2B50}]/gu, '')            // Remove star emoji
        .replace(/[\u{2705}\u{2611}\u{2714}\u{2716}\u{274C}\u{274E}]/gu, ''); // Remove checkmarks and crosses
};

const VARIATION_SELECTORS_REGEX =
    /\uFE00|\uFE01|\uFE02|\uFE03|\uFE04|\uFE05|\uFE06|\uFE07|\uFE08|\uFE09|\uFE0A|\uFE0B|\uFE0C|\uFE0D|\uFE0E|\uFE0F/gu;

const cleanMarkdownFormatting = (text: string): string => {
    const withoutNumbering = stripLeadingNumbering(text);
    const withoutEmojis = removeEmojiCharacters(withoutNumbering);

    const sanitized = withoutEmojis
        .replace(/\*\*/g, '') // Remove bold markers
        .replace(/\*/g, '')   // Remove italic markers
        .replace(/`/g, '')    // Remove code markers
        .replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1') // Remove links, keep text
        .replace(/:/g, '')    // Remove colons
        .replace(VARIATION_SELECTORS_REGEX, '')   // Remove variation selectors
        .replace(/\s+/g, ' ')                   // Normalize whitespace
        .trim();

    return stripLeadingNumbering(sanitized).trim();
};

/**
 * Generates a URL-safe anchor id from heading text
 */
const generateAnchorId = (text: string): string => {
    return text
        .toLowerCase()
        .trim()
        .replace(/\s+/g, '-')
        .replace(/[^\w\u4e00-\u9fa5\-]/g, ''); // Allow Chinese characters
};

export const cleanMarkdownHeadingText = cleanMarkdownFormatting;
export const slugifyMarkdownHeading = generateAnchorId;

/**
 * Heal ordered list items where the model split the digit and its content
 * across lines, e.g. emitting
 *
 *     1.
 *     **Short-term (24h)** (60% confidence)
 *
 * which markdown-to-jsx renders as an empty `<li>` followed by a separate
 * paragraph — visually broken. Join the digit line with the next non-empty
 * line when that line opens with `**` (a heading-style bold) or any inline
 * content. We only act when the digit line itself is empty after the period,
 * so legitimate"1. text…" lines pass through untouched. Code blocks are
 * skipped to avoid touching language samples.
 */
export function normalizeOrderedListItemBreak(text: string): string {
    if (!/^\s*\d+\.\s*$/m.test(text)) return text;
    const lines = text.split("\n");
    let inFence = false;
    const out: string[] = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.trimStart().startsWith("```")) {
            inFence = !inFence;
            out.push(line);
            continue;
        }
        if (inFence) {
            out.push(line);
            continue;
        }
        const m = line.match(/^(\s*)(\d+\.)\s*$/);
        if (!m) {
            out.push(line);
            continue;
        }
        // Look ahead for the next non-empty, non-fence line within a small
        // window. If it's a content line that should belong to this item,
        // merge it. We bail when the next line is itself a list marker
        // (the model meant an empty item) or a heading.
        let j = i + 1;
        while (j < lines.length && lines[j].trim() === "") j++;
        if (j >= lines.length) {
            out.push(line);
            continue;
        }
        const next = lines[j];
        const nextTrim = next.trimStart();
        const looksLikeMarker = /^(?:\d+\.\s|[-*]\s|#{1,6}\s|```)/.test(nextTrim);
        if (looksLikeMarker) {
            out.push(line);
            continue;
        }
        out.push(`${m[1]}${m[2]} ${nextTrim}`);
        i = j;
    }
    return out.join("\n");
}

/**
 * CommonMark allows at most 3 spaces before ATX `#` headings. LLM output often uses deeper
 * indentation, which makes parsers treat `# Title` as plain text — share images then show
 * literal `#` characters. Strip excess leading whitespace on ATX-looking lines only.
 * Lines inside triple-backtick fenced code blocks are left unchanged.
 */
export function normalizeMarkdownAtxHeadingIndent(text: string): string {
    if (!text.includes("#")) return text;
    const lines = text.split("\n");
    let inFence = false;
    const out: string[] = [];
    for (const line of lines) {
        const fenceStart = line.trimStart().startsWith("```");
        if (fenceStart) {
            inFence = !inFence;
            out.push(line);
            continue;
        }
        if (inFence) {
            out.push(line);
            continue;
        }
        const m = line.match(/^(\s*)(#{1,6})(?!#)(\s*)([\s\S]*)$/);
        if (!m || m[1].length <= 3) {
            out.push(line);
            continue;
        }
        const rest = m[4] ?? "";
        const sep = m[3] || (rest.trim().length > 0 ? " " : "");
        out.push(`${m[2]}${sep}${rest}`);
    }
    return out.join("\n");
}

// Body copy. With a real reading measure (see the chat grid) the line height
// has to come up with it — 1.75 is what keeps a 60-character line tracking.
const CustomParagraph: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    return (
        <p className="mb-3 leading-[1.75] text-foreground">
            {children}
        </p>
    );
};

// Custom line break component
const CustomBreak: React.FC = () => {
    return <br className="leading-normal" />;
};

// Factory to create heading components with anchor ids and optional prefixes
const createHeadingComponent = (
    Tag: "h1" |"h2" |"h3",
    className: string,
    anchorPrefix: string
) => {
    const HeadingComponent: React.FC<{ children: React.ReactNode }> = ({ children }) => {
        const text = extractText(children);
        const cleanedText = cleanMarkdownFormatting(text);
        const anchorId = `${anchorPrefix}${generateAnchorId(cleanedText)}`;

        return React.createElement(
            Tag,
            {
                id: anchorId,
                className,
            },
            children
        );
    };

    HeadingComponent.displayName = `Custom${Tag.toUpperCase()}`;
    return HeadingComponent;
};

const CustomH4: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <h4 className="text-base font-semibold mb-2 mt-2 text-foreground">{children}</h4>
);

const CustomH5: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <h5 className="text-sm font-semibold mb-2 mt-2 text-foreground">{children}</h5>
);

const CustomH6: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <h6 className="text-xs font-semibold mb-2 mt-2 text-foreground">{children}</h6>
);

// Custom list components.
//
// Use `list-outside` (markers in the left gutter) instead of `list-inside`.
// `list-inside` looked compact for plain-text bullets, but it breaks on
// list items whose first child is a block element (e.g. `<p>` produced when
// markdown-to-jsx sees a blank line inside a list item): the marker takes
// its baseline on the first line and the `<p>` then forces a line break
// before its content, producing the visible"1." alone followed by the
// item text on the next line. With `list-outside`, the marker sits in the
// padded gutter and the block content flows beside it.
const CustomUL: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <ul className="mb-3 mt-2 list-outside list-disc pl-5 text-foreground marker:text-label-2/50 [&>li>p]:my-0">
        {children}
    </ul>
);

const CustomOL: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <ol className="mb-3 mt-2 list-outside list-decimal pl-5 text-foreground marker:font-mono marker:text-[11px] marker:text-label-2 [&>li>p]:my-0">
        {children}
    </ol>
);

const CustomLI: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <li className="mb-1.5 pl-1 leading-[1.7] text-foreground">{children}</li>
);

// Custom link component. Sky is the provenance hue in the mark colour contract
// (see marks/SemanticMarks.tsx) — an outbound link and an inline citation point
// at the same kind of thing, so they share it.
const CustomLink: React.FC<{ children: React.ReactNode; href: string }> = ({ children, href }) => (
    <a
        href={href}
        className="text-brand underline decoration-brand/30 underline-offset-2 transition-colors hover:decoration-brand"
        target="_blank"
        rel="noopener noreferrer"
    >
        {children}
    </a>
);

// Custom strong/bold component
const CustomStrong: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <strong className="font-semibold text-label-1">{children}</strong>
);

// Custom emphasis/italic component
const CustomEm: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <em className="italic text-foreground">{children}</em>
);

// Custom code components
const CustomCode: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <code className="bg-muted px-1 py-0.5 rounded text-sm font-mono text-foreground">
        {children}
    </code>
);

const CustomPre: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <pre className="bg-muted p-3 rounded mb-4 mt-4 overflow-x-auto">
        <code className="text-sm font-mono text-foreground">{children}</code>
    </pre>
);

// Custom blockquote component.
//
// No `italic`: the orchestrator prompt sends risk notes here, and those are
// usually Chinese. CJK has no true italic, so the browser synthesises an oblique
// by shearing the glyphs — it looks broken rather than emphatic. Weight and the
// rule carry the emphasis instead.
const CustomBlockquote: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <blockquote className="mb-4 mt-4 border-l-2 border-border pl-4 text-label-2">
        {children}
    </blockquote>
);

// Custom horizontal rule
const CustomHR: React.FC = () => (
    <hr className="border-border my-4" />
);

// Custom table components
const CustomTable: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <div className="my-4 overflow-x-auto rounded-lg border border-sep bg-raised">
        {/*
          Round-6 polish: tables in chat bubbles compressed columns
          tight enough that"Original Quantity" and"Executed Quantity"
          headers ran into each other and the Status badge sat flush
          against the numbers. Strategy: bump per-cell horizontal
          breathing room (handled in CustomTD / CustomTH below) AND
          give numeric columns right-alignment so the decimal points
          line up. `border-separate + border-spacing` would have
          worked too but breaks the row hover background; sticking
          with `border-collapse` and per-cell padding instead.
        */}
        {/*
          `min-w-full w-max`, never `w-full`. With `w-full` the table is pinned to the container
          width while `whitespace-nowrap` forbids cells from shrinking to fit — so the browser
          squeezes the columns and the text spills across cell boundaries, which is how a valuation
          table rendered "Perpetuity growth (2.5%)" on top of its own enterprise value. The wrapper's
          `overflow-x-auto` never engaged, because the table never asked for more room than it had.
          `w-max` lets it size to its content and hands the overflow to the scroller.
        */}
        <table className="min-w-full w-max text-left text-sm border-collapse whitespace-nowrap">
            {children}
        </table>
    </div>
);

const CustomTHead: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <thead className="bg-fill-1 dark:bg-white/[0.03]">
        {children}
    </thead>
);

const CustomTBody: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <tbody className="text-foreground">
        {children}
    </tbody>
);

const CustomTR: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    return (
        <tr className="border-b border-sep last:border-0 transition-colors hover:bg-fill-1">
            {children}
        </tr>
    );
};

const CustomTH: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    // Round-6: headers needed the same `px-5` breathing room as body
    // cells (was `px-4`) — without it labels like"Original Quantity"
    // and"Executed Quantity" sat too close on narrow chat-bubble
    // tables. Tracking-tighter + slight uppercase styling makes the
    // header row visually distinct from data without taking extra
    // vertical space.
    const text = extractText(children);
    const looksNumericHeader =
        /\b(price|quantity|qty|size|amount|value|notional|leverage|fee)\b/i.test(text);
    const align = looksNumericHeader ? "text-right" : "text-left";
    return (
        <th
            className={`px-5 py-3 text-[11px] font-semibold tracking-wide uppercase text-label-2 border-b border-sep whitespace-nowrap ${align}`}
        >
            {children}
        </th>
    );
};

// Cell value classifiers for financial tables. Each function inspects
// the cell's plain text and decides whether to apply pattern formatting.
// These run on every table cell across the app; the patterns are tight
// enough to avoid false-positives in non-trading content.
function classifyCellValue(text: string): {
    kind: "side" |"status" |"long_id" |"uuid" |"none";
    normalized?: string;
} {
    const trimmed = text.trim();
    if (!trimmed) return { kind: "none" };

    // Side: exactly"BUY" or"SELL" (case-insensitive).
    if (/^(buy|sell)$/i.test(trimmed)) {
        return { kind: "side", normalized: trimmed.toUpperCase() };
    }
    // Exact status tokens only.
    if (/^(new|partially_filled|partial|filled|cancell?ed|rejected|expired|open|closed|done|active|pending)$/i.test(trimmed)) {
        return { kind: "status", normalized: trimmed.toUpperCase() };
    }
    // UUID v4-ish identifiers.
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) {
        return { kind: "uuid", normalized: trimmed };
    }
    // Long numeric identifiers. Exchange order ids are 15+ digits; 9–14 digits
    // is the range share volume and market cap live in, and rendering a
    // 412000000 volume as a click-to-copy"id" chip was plain wrong.
    if (/^[0-9]{15,}$/.test(trimmed)) {
        return { kind: "long_id", normalized: trimmed };
    }
    // Long alphanumeric (client_order_ids etc.).
    if (/^[A-Za-z0-9_-]{16,}$/.test(trimmed)) {
        return { kind: "long_id", normalized: trimmed };
    }
    return { kind: "none" };
}

const SIDE_CLASS: Record<string, string> = {
    BUY: "inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300 ring-1 ring-emerald-300/40",
    SELL: "inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300 ring-1 ring-rose-300/40",
};

const STATUS_CLASS: Record<string, string> = {
    NEW: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300 ring-blue-300/40",
    OPEN: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300 ring-blue-300/40",
    PENDING: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300 ring-blue-300/40",
    ACTIVE: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300 ring-blue-300/40",
    PARTIAL: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 ring-amber-300/40",
    PARTIALLY_FILLED: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 ring-amber-300/40",
    FILLED: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300 ring-emerald-300/40",
    DONE: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300 ring-emerald-300/40",
    // Terminal states carry no hue — they are the absence of activity.
    CLOSED: "bg-fill-1 text-label-2 ring-transparent",
    CANCELLED: "bg-fill-1 text-label-2 ring-transparent",
    CANCELED: "bg-fill-1 text-label-2 ring-transparent",
    EXPIRED: "bg-fill-1 text-label-3 ring-transparent",
    REJECTED: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300 ring-red-300/40",
};

const TruncatedId: React.FC<{ value: string }> = ({ value }) => {
    const [copied, setCopied] = React.useState(false);
    const handleCopy = React.useCallback(
        (e: React.MouseEvent) => {
            e.preventDefault();
            void navigator.clipboard?.writeText(value);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
        },
        [value],
    );
    const head = value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
    return (
        <button
            type="button"
            onClick={handleCopy}
            title={copied ? "Copied!" : `${value} — click to copy`}
            className="font-mono text-xs px-1.5 py-0.5 rounded border border-sep bg-fill-1 hover:bg-muted/70 transition-colors"
        >
            {copied ? "Copied" : head}
        </button>
    );
};

const SideBadge: React.FC<{ value: string }> = ({ value }) => (
    <span className={SIDE_CLASS[value] ?? ""}>{value}</span>
);

const StatusBadge: React.FC<{ value: string }> = ({ value }) => {
    const cls = STATUS_CLASS[value] ?? "bg-muted text-label-2";
    return (
        <span
            className={cn(
                "inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold ring-1",
                cls,
            )}
        >
            {value}
        </span>
    );
};

/**
 * Format a raw numeric string for display in trading tables. Venues
 * return prices and quantities with up to 8 trailing decimals
 * ("50000.00000000", "0.00116000") which adds noise without precision.
 * Rules:
 *   - n >= 1 OR n === 0: thousands-comma + max 2 decimals, trailing
 *     zeros trimmed past the decimal point. ("50000.00000000" →"50,000")
 *   - 0 < n < 1: trim trailing zeros, max 8 significant decimals
 *     ("0.00116000" →"0.00116", "0.000000010" →"0.00000001")
 *   - non-finite / non-numeric: return the input untouched.
 */
function formatTradingNumber(raw: string): string | null {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    // Reject anything with non-numeric tokens (currency suffix, dashes, etc.)
    if (!/^[+-]?\d+(?:\.\d+)?$/.test(trimmed)) return null;
    const n = Number.parseFloat(trimmed);
    if (!Number.isFinite(n)) return null;
    const abs = Math.abs(n);
    if (abs >= 1 || n === 0) {
        return n.toLocaleString("en-US", {
            minimumFractionDigits: 0,
            maximumFractionDigits: 2,
        });
    }
    // Tiny fractional: keep enough precision to be useful but drop trailing zeros.
    return Number.parseFloat(n.toFixed(8)).toString();
}

const CustomTD: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const text = extractText(children);
    const cls = classifyCellValue(text);
    let inner: React.ReactNode = children;

    const isNumeric = /^[0-9.,]+$/.test(text.trim());

    if (cls.kind === "side" && cls.normalized) {
        inner = <SideBadge value={cls.normalized} />;
    } else if (cls.kind === "status" && cls.normalized) {
        inner = <StatusBadge value={cls.normalized} />;
    } else if ((cls.kind === "uuid" || cls.kind === "long_id") && cls.normalized) {
        inner = <TruncatedId value={cls.normalized} />;
    } else if (isNumeric) {
        const pretty = formatTradingNumber(text);
        inner = <span className="fin-figure text-[13px]">{pretty ?? children}</span>;
    }
    // Round-6: numeric cells right-align so columns of decimals line
    // up at the decimal point; status/side badges stay left-aligned so
    // the badge sits at the natural column start. Per-cell horizontal
    // padding bumped from `px-4` to `px-5` so adjacent columns don't
    // run into each other inside the in-chat bubble width.
    const isBadgeCell = cls.kind === "side" || cls.kind === "status";
    const align = isNumeric && !isBadgeCell ? "text-right" : "text-left";
    return (
        <td
            className={`px-5 py-3 text-[13px] text-foreground/90 whitespace-nowrap ${align}`}
        >
            {inner}
        </td>
    );
};

// markdown-to-jsx ships images as plain <img>; without overrides they're eager-
// loaded. Demo PNGs in onboarding markdown range 60–130 KB each, so lazy-loading
// below-fold images saves real bytes on mobile first paint.
const CustomImg: React.FC<React.ImgHTMLAttributes<HTMLImageElement>> = (props) => (
    // eslint-disable-next-line jsx-a11y/alt-text
    <img loading="lazy" decoding="async" {...props} />
);

// Thesis / risk cards. The body arrives URI-encoded in an attribute (see
// rewriteSemanticMarks) and is rendered back through this same pipeline, so a
// card may hold lists, tables, and inline marks of its own.
function MarkBlockCard({ k, body }: { k?: string; body?: string }) {
    const markdown = decodeMarkPayload(body ?? "");
    if (!markdown) return null;
    const inner = <Markdown options={markdownOptions()}>{markdown}</Markdown>;
    return k === "thesis" || k === "risk" ? <MarkCard kind={k}>{inner}</MarkCard> : inner;
}

// Reusable overrides that do not depend on anchor prefixes
const baseMarkdownOverrides = {
    p: CustomParagraph,
    br: CustomBreak,
    h4: CustomH4,
    h5: CustomH5,
    h6: CustomH6,
    ul: CustomUL,
    ol: CustomOL,
    li: CustomLI,
    a: CustomLink,
    strong: CustomStrong,
    em: CustomEm,
    code: CustomCode,
    pre: CustomPre,
    blockquote: CustomBlockquote,
    hr: CustomHR,
    table: CustomTable,
    thead: CustomTHead,
    tbody: CustomTBody,
    tr: CustomTR,
    th: CustomTH,
    td: CustomTD,
    img: CustomImg,
    // markdown-to-jsx's overrides natively support custom tags in the body, so the main agent
    // only needs to write <StockChart symbol="AAPL" range="1Y" /> to embed a live chart. No new
    // syntax to invent, no parser to write, no touching SSE.
    StockChart: StockChartBlock,
    // Semantic marks: the main agent writes [[metric:…]] / :::risk, and preprocessing lowers them into these two tags.
    [INLINE_TAG]: InlineMark,
    [BLOCK_TAG]: MarkBlockCard,
    [SOURCE_LIST_TAG]: SourceListBlock,
};

// Markdown component overrides generator for minimal spacing with optional anchor prefixes
export const markdownOptions = (anchorPrefix ="") => ({
    overrides: {
        ...baseMarkdownOverrides,
        // Section hierarchy. Previously h2 and a bold lead-in like"**Revenue:**"
        // carried nearly the same weight, so a long answer read as one flat
        // slab. h2 now gets a hairline rule and real air above it — the section
        // break on a printed note — and h3 sits clearly under it without one.
        h1: createHeadingComponent(
            "h1",
            "scroll-mt-4 mb-4 mt-5 text-[22px] font-bold tracking-[-0.022em] text-label-1",
            anchorPrefix
        ),
        h2: createHeadingComponent(
            "h2",
            "scroll-mt-4 mb-3 mt-7 border-b border-sep pb-1.5 text-[17px] font-semibold tracking-[-0.016em] text-label-1 first:mt-0",
            anchorPrefix
        ),
        h3: createHeadingComponent(
            "h3",
            "scroll-mt-4 mb-2 mt-5 text-[15px] font-semibold tracking-[-0.008em] text-label-1",
            anchorPrefix
        ),
    },
});

// Main MarkdownRenderer component
interface MarkdownRendererProps {
    children: string;
    className?: string;
    anchorPrefix?: string;
    /**
     * True while the body is still growing via SSE streaming. While true, a trailing unclosed
     * `<...` gets cut off (otherwise markdown-to-jsx would briefly flash the half-formed tag as
     * escaped literal text), and `<StockChart />` renders only a placeholder skeleton without
     * sending a request.
     */
    streaming?: boolean;
    /** Search hits the backend attached to this message, matched to citations by URL. */
    sources?: MessageSource[];
}

export const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({
    children,
    className ="",
    anchorPrefix ="",
    streaming = false,
    sources = [],
}) => {
    const options = useMemo(() => markdownOptions(anchorPrefix), [anchorPrefix]);
    // [[cite:…|n]] points at the answer's own numbered Sources list.
    const answerSources = useMemo(
        () => ({ links: parseAnswerSources(children), retrieved: sources }),
        [children, sources],
    );
    const normalized = useMemo(() => {
        const source = streaming ? stripIncompleteTrailingTag(children) : children;
        return rewriteSourceList(
            rewriteSemanticMarks(
                normalizeOrderedListItemBreak(normalizeMarkdownAtxHeadingIndent(source)),
                { streaming },
            ),
            { streaming },
        );
    }, [children, streaming]);

    return (
        <div
            className={cn(
                "w-full max-w-full break-words whitespace-pre-wrap [overflow-wrap:anywhere] min-w-0 overflow-hidden",
                className
            )}
        >
            <StreamingContext.Provider value={streaming}>
                <AnswerSourcesContext.Provider value={answerSources}>
                    <Markdown options={options}>
                        {normalized}
                    </Markdown>
                    {/* Only answers that actually carry figures get a staleness
                        footer — a chat reply about nothing numeric does not. */}
                    {normalized.includes(`<${INLINE_TAG}`) && <FreshnessNote />}
                </AnswerSourcesContext.Provider>
            </StreamingContext.Provider>
        </div>
    );
};

export default MarkdownRenderer;
