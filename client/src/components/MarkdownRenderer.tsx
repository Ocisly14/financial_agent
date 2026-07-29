import Markdown from "markdown-to-jsx";
import React, { useMemo } from "react";
import { cn } from "@/lib/utils";
import { stripIncompleteTrailingTag } from "@/lib/stockChart";
import StockChartBlock from "./StockChart";
import { StreamingContext } from "./stockChartContext";

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
 * so legitimate "1. text…" lines pass through untouched. Code blocks are
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

// Custom paragraph component with moderate line spacing
const CustomParagraph: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    return (
        <p className="mb-2 leading-relaxed text-foreground">
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
    Tag: "h1" | "h2" | "h3",
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
// before its content, producing the visible "1." alone followed by the
// item text on the next line. With `list-outside`, the marker sits in the
// padded gutter and the block content flows beside it.
const CustomUL: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <ul className="list-disc list-outside pl-6 mb-2 mt-2 text-foreground [&>li>p]:my-0">{children}</ul>
);

const CustomOL: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <ol className="list-decimal list-outside pl-6 mb-2 mt-2 text-foreground [&>li>p]:my-0">{children}</ol>
);

const CustomLI: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <li className="mb-1 text-foreground">{children}</li>
);

// Custom link component
const CustomLink: React.FC<{ children: React.ReactNode; href: string }> = ({ children, href }) => (
    <a 
        href={href} 
        className="text-blue-600 dark:text-blue-400 hover:underline"
        target="_blank" 
        rel="noopener noreferrer"
    >
        {children}
    </a>
);

// Custom strong/bold component
const CustomStrong: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <strong className="font-semibold text-gray-900 dark:text-gray-100">{children}</strong>
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

// Custom blockquote component
const CustomBlockquote: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <blockquote className="border-l-4 border-muted pl-4 mb-4 mt-4 italic text-muted-foreground">
        {children}
    </blockquote>
);

// Custom horizontal rule
const CustomHR: React.FC = () => (
    <hr className="border-border my-4" />
);

// Custom table components
const CustomTable: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <div className="overflow-x-auto my-4 rounded-lg border border-border/40 dark:border-white/10 bg-background shadow-sm">
        {/*
          Round-6 polish: tables in chat bubbles compressed columns
          tight enough that "Original Quantity" and "Executed Quantity"
          headers ran into each other and the Status badge sat flush
          against the numbers. Strategy: bump per-cell horizontal
          breathing room (handled in CustomTD / CustomTH below) AND
          give numeric columns right-alignment so the decimal points
          line up. `border-separate + border-spacing` would have
          worked too but breaks the row hover background; sticking
          with `border-collapse` and per-cell padding instead.
        */}
        <table className="w-full text-left text-sm border-collapse whitespace-nowrap">
            {children}
        </table>
    </div>
);

const CustomTHead: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <thead className="bg-muted/40 dark:bg-white/[0.03]">
        {children}
    </thead>
);

const CustomTBody: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <tbody className="text-foreground">
        {children}
    </tbody>
);

// Open-order detection per row: a likely-order-ID cell plus a status cell
// in the OPEN family. When both are present, the renderer surfaces an
// inline Cancel chip that dispatches `financial-agent:chat-send` with a
// pre-filled cancel-order message. chat.tsx listens for that event.
const OPEN_STATUS_TOKENS = new Set([
    "NEW",
    "OPEN",
    "PENDING",
    "ACTIVE",
    "PARTIAL",
    "PARTIALLY_FILLED",
]);

function scanRowForCancelable(children: React.ReactNode): {
    orderId: string | null;
    isOpen: boolean;
    venue: string | null;
} {
    let orderId: string | null = null;
    let isOpen = false;
    let venue: string | null = null;
    const walk = (node: React.ReactNode) => {
        if (typeof node === "string") {
            const trimmed = node.trim();
            if (!trimmed) return;
            const c = classifyCellValue(trimmed);
            if (!orderId && (c.kind === "uuid" || c.kind === "long_id")) {
                // Skip client_order_ids (heuristic: prefixed with bn- / cb-)
                if (!/^(bn|cb)-/i.test(trimmed)) {
                    orderId = c.normalized ?? null;
                }
            }
            if (c.kind === "status" && c.normalized && OPEN_STATUS_TOKENS.has(c.normalized)) {
                isOpen = true;
            }
            if (!venue && /^(binance|coinbase)$/i.test(trimmed)) {
                venue = trimmed.toLowerCase();
            }
            return;
        }
        if (Array.isArray(node)) {
            node.forEach(walk);
            return;
        }
        if (React.isValidElement(node)) {
            const props = node.props as { children?: React.ReactNode };
            if (props.children) walk(props.children);
        }
    };
    walk(children);
    return { orderId, isOpen, venue };
}

const CancelOrderButton: React.FC<{ orderId: string; venue: string | null }> = ({
    orderId,
    venue,
}) => {
    const onClick = React.useCallback(() => {
        const venueClause = venue ? ` on ${venue}` : "";
        const text = `cancel order ${orderId}${venueClause}`;
        window.dispatchEvent(
            new CustomEvent("financial-agent:chat-send", {
                detail: { text, source: "orders_table_cancel_chip" },
            }),
        );
    }, [orderId, venue]);
    return (
        <button
            type="button"
            onClick={onClick}
            title={`Cancel order ${orderId}${venue ? ` on ${venue}` : ""}`}
            aria-label={`Cancel order ${orderId}`}
            // Compact icon-style chip — sits flush against the row's
            // right edge without bulking up the row height. Uses
            // padding tight enough that the chip fits beside the cell
            // value on wider viewports, and `whitespace-nowrap` on the
            // parent flex keeps it from wrapping mid-row.
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium leading-none bg-rose-50/80 text-rose-700 hover:bg-rose-100 dark:bg-rose-900/30 dark:text-rose-300 dark:hover:bg-rose-900/50 ring-1 ring-rose-300/40 transition-colors"
        >
            <svg
                viewBox="0 0 16 16"
                width="11"
                height="11"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
            >
                <path d="M3 3l10 10M13 3L3 13" />
            </svg>
            Cancel
        </button>
    );
};

const CustomTR: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const { orderId, isOpen, venue } = scanRowForCancelable(children);
    const showCancel = !!orderId && isOpen;
    
    if (!showCancel) {
        return (
            <tr className="border-b border-border/40 dark:border-white/10 last:border-0 hover:bg-muted/40 dark:hover:bg-white/[0.02] transition-colors">
                {children}
            </tr>
        );
    }

    // Round-5 polish: stop injecting the Cancel chip INSIDE the
    // last data cell (which conflated the chip with whatever column
    // happened to be last — Time-in-Force or Placed-Time in different
    // open-orders shapes). Render the chip in its OWN trailing <td>
    // so it has dedicated horizontal real-estate, lines up neatly on
    // the right edge of the row, and never collides with cell values.
    // The header row only has the original markdown columns (no
    // matching <th> for "Action") — that asymmetry is intentional:
    // CSS tables are forgiving when a row carries one more cell than
    // the header, and labelling an action column as "Actions" would
    // shift every column header right and break alignment for users
    // who already learned the layout.
    return (
        <tr className="border-b border-border/40 dark:border-white/10 last:border-0 hover:bg-muted/40 dark:hover:bg-white/[0.02] transition-colors">
            {children}
            <td className="px-2 py-3 text-right align-middle whitespace-nowrap">
                <CancelOrderButton orderId={orderId!} venue={venue} />
            </td>
        </tr>
    );
};

const CustomTH: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    // Round-6: headers needed the same `px-5` breathing room as body
    // cells (was `px-4`) — without it labels like "Original Quantity"
    // and "Executed Quantity" sat too close on narrow chat-bubble
    // tables. Tracking-tighter + slight uppercase styling makes the
    // header row visually distinct from data without taking extra
    // vertical space.
    const text = extractText(children);
    const looksNumericHeader =
        /\b(price|quantity|qty|size|amount|value|notional|leverage|fee)\b/i.test(text);
    const align = looksNumericHeader ? "text-right" : "text-left";
    return (
        <th
            className={`px-5 py-3 text-[11px] font-semibold tracking-wide uppercase text-muted-foreground border-b border-border/50 dark:border-white/10 whitespace-nowrap ${align}`}
        >
            {children}
        </th>
    );
};

// Cell value classifiers for trading order tables. Each function inspects
// the cell's plain text and decides whether to apply pattern formatting.
// These run on every table cell across the app; the patterns are tight
// enough to avoid false-positives in non-trading content.
function classifyCellValue(text: string): {
    kind: "side" | "status" | "long_id" | "uuid" | "none";
    normalized?: string;
} {
    const trimmed = text.trim();
    if (!trimmed) return { kind: "none" };

    // Side: exactly "BUY" or "SELL" (case-insensitive).
    if (/^(buy|sell)$/i.test(trimmed)) {
        return { kind: "side", normalized: trimmed.toUpperCase() };
    }
    // Order status: NEW, PARTIALLY_FILLED, FILLED, CANCELLED, REJECTED,
    // EXPIRED, OPEN, CLOSED. Match exact tokens only.
    if (/^(new|partially_filled|partial|filled|cancell?ed|rejected|expired|open|closed|done|active|pending)$/i.test(trimmed)) {
        return { kind: "status", normalized: trimmed.toUpperCase() };
    }
    // UUID v4-ish (Coinbase order ID).
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) {
        return { kind: "uuid", normalized: trimmed };
    }
    // Long numeric (Binance order IDs — typically 10-12 digits).
    if (/^[0-9]{9,}$/.test(trimmed)) {
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
    CLOSED: "bg-slate-100 text-slate-700 dark:bg-slate-800/40 dark:text-slate-300 ring-slate-300/40",
    CANCELLED: "bg-slate-100 text-slate-700 dark:bg-slate-800/40 dark:text-slate-300 ring-slate-300/40",
    CANCELED: "bg-slate-100 text-slate-700 dark:bg-slate-800/40 dark:text-slate-300 ring-slate-300/40",
    EXPIRED: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800/40 dark:text-zinc-300 ring-zinc-300/40",
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
            className="font-mono text-xs px-1.5 py-0.5 rounded border border-border/60 bg-muted/40 hover:bg-muted/70 transition-colors"
        >
            {copied ? "Copied" : head}
        </button>
    );
};

const SideBadge: React.FC<{ value: string }> = ({ value }) => (
    <span className={SIDE_CLASS[value] ?? ""}>{value}</span>
);

const StatusBadge: React.FC<{ value: string }> = ({ value }) => {
    const cls = STATUS_CLASS[value] ?? "bg-muted text-muted-foreground";
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
 *     zeros trimmed past the decimal point. ("50000.00000000" → "50,000")
 *   - 0 < n < 1: trim trailing zeros, max 8 significant decimals
 *     ("0.00116000" → "0.00116", "0.000000010" → "0.00000001")
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
        inner = (
            <span className="font-mono text-[13px] tabular-nums">
                {pretty ?? children}
            </span>
        );
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
    // markdown-to-jsx 的 overrides 原生支持正文里的自定义标签，所以主 agent 只需
    // 写 <StockChart symbol="AAPL" range="1Y" /> 就能内嵌一块实时图表。不发明新
    // 语法、不写解析器、不碰 SSE。
    StockChart: StockChartBlock,
};

// Markdown component overrides generator for minimal spacing with optional anchor prefixes
export const markdownOptions = (anchorPrefix = "") => ({
    overrides: {
        ...baseMarkdownOverrides,
        h1: createHeadingComponent(
            "h1",
            "text-2xl font-semibold mb-4 mt-4 text-foreground scroll-mt-4",
            anchorPrefix
        ),
        h2: createHeadingComponent(
            "h2",
            "text-xl font-semibold mb-2 mt-4 text-foreground scroll-mt-4",
            anchorPrefix
        ),
        h3: createHeadingComponent(
            "h3",
            "text-lg font-semibold mb-2 mt-2 text-foreground scroll-mt-4",
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
     * 正文仍在 SSE 流式增长时置为 true。此时末尾未闭合的 `<...` 会被砍掉
     * （否则 markdown-to-jsx 会把半截标签转义成字面文本闪现出来），
     * 且 `<StockChart />` 只渲染占位骨架、不发请求。
     */
    streaming?: boolean;
}

export const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({
    children,
    className = "",
    anchorPrefix = "",
    streaming = false,
}) => {
    const options = useMemo(() => markdownOptions(anchorPrefix), [anchorPrefix]);
    const normalized = useMemo(() => {
        const source = streaming ? stripIncompleteTrailingTag(children) : children;
        return normalizeOrderedListItemBreak(normalizeMarkdownAtxHeadingIndent(source));
    }, [children, streaming]);

    return (
        <div
            className={cn(
                "w-full max-w-full break-words whitespace-pre-wrap [overflow-wrap:anywhere] min-w-0 overflow-hidden",
                className
            )}
        >
            <StreamingContext.Provider value={streaming}>
                <Markdown options={options}>
                    {normalized}
                </Markdown>
            </StreamingContext.Provider>
        </div>
    );
};

export default MarkdownRenderer;
