/**
 * Semantic marks — the orchestrator marks *meaning* in its final answer and the
 * client owns every pixel of the appearance.
 *
 * Inline:  [[kind:text|extra]]  for metric / level / catalyst / unverified
 * Block:   :::kind … :::        for thesis / risk
 *
 * `rewriteSemanticMarks` lowers that syntax onto the custom tags that
 * markdown-to-jsx already resolves through `overrides` (the same mechanism
 * `<StockChart />` rides on). Payloads travel URI-encoded inside attributes so
 * no user or model text can smuggle markup into the parse.
 *
 * Everything here is deliberately defensive: marks are progressive
 * enhancement. An unmarked answer must read correctly, and a malformed,
 * over-used, or half-streamed mark must degrade to plain text rather than leak
 * syntax to the reader.
 */

export const INLINE_MARK_KINDS = ["metric", "level", "catalyst", "unverified", "cite"] as const;
export const BLOCK_MARK_KINDS = ["thesis", "risk"] as const;

export type InlineMarkKind = (typeof INLINE_MARK_KINDS)[number];
export type BlockMarkKind = (typeof BLOCK_MARK_KINDS)[number];

/** Density budget. Beyond these counts marks degrade to plain text: an answer
 *  that highlights everything highlights nothing. */
export const MARK_LIMITS = {
    thesis: 1,
    risk: 3,
    /** metric marks per paragraph */
    metric: 6,
} as const;

export const INLINE_TAG = "Mark";
export const BLOCK_TAG = "MarkBlock";

const INLINE_PATTERN = /\[\[([a-z]+):([^\]\n|]+?)(?:\|([^\]\n]*))?\]\]/g;
const BLOCK_OPEN_PATTERN = /^:::([a-z]+)[ \t]*$/;
const BLOCK_CLOSE_PATTERN = /^:::[ \t]*$/;

function isInlineKind(value: string): value is InlineMarkKind {
    return (INLINE_MARK_KINDS as readonly string[]).includes(value);
}

function isBlockKind(value: string): value is BlockMarkKind {
    return (BLOCK_MARK_KINDS as readonly string[]).includes(value);
}

/** Attribute payloads are URI-encoded so text may contain quotes, <, & or |. */
export function encodeMarkPayload(value: string): string {
    return encodeURIComponent(value);
}

export function decodeMarkPayload(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

/**
 * Split markdown into code and prose segments. Rewriting must never touch code:
 * a pasted snippet containing `[[` or `:::` has to survive verbatim.
 */
function segmentByCode(source: string): Array<{ code: boolean; text: string }> {
    const segments: Array<{ code: boolean; text: string }> = [];
    const lines = source.split("\n");
    let prose: string[] = [];
    let fence: string | null = null;
    let fenced: string[] = [];

    const flushProse = () => {
        if (prose.length > 0) {
            segments.push({ code: false, text: prose.join("\n") });
            prose = [];
        }
    };

    for (const line of lines) {
        const fenceMatch = /^\s*(```+|~~~+)/.exec(line);
        if (fence === null && fenceMatch) {
            flushProse();
            fence = fenceMatch[1]!.slice(0, 3);
            fenced = [line];
            continue;
        }
        if (fence !== null) {
            fenced.push(line);
            if (new RegExp(`^\\s*${fence}`).test(line)) {
                segments.push({ code: true, text: fenced.join("\n") });
                fence = null;
                fenced = [];
            }
            continue;
        }
        prose.push(line);
    }
    if (fence !== null) segments.push({ code: true, text: fenced.join("\n") });
    flushProse();

    // Inline code spans inside prose are code too.
    return segments.flatMap((segment) => {
        if (segment.code) return [segment];
        const parts: Array<{ code: boolean; text: string }> = [];
        const spanPattern = /`[^`\n]*`/g;
        let cursor = 0;
        let match: RegExpExecArray | null;
        while ((match = spanPattern.exec(segment.text)) !== null) {
            if (match.index > cursor) parts.push({ code: false, text: segment.text.slice(cursor, match.index) });
            parts.push({ code: true, text: match[0] });
            cursor = match.index + match[0].length;
        }
        if (cursor < segment.text.length) parts.push({ code: false, text: segment.text.slice(cursor) });
        return parts.length > 0 ? parts : [segment];
    });
}

/** Rewrite inline marks in one prose chunk, honouring the per-paragraph budget. */
function rewriteInline(prose: string): string {
    // The metric budget is per paragraph, so count within blank-line groups.
    return prose.split(/(\n[ \t]*\n)/).map((chunk) => {
        if (/^\n[ \t]*\n$/.test(chunk)) return chunk;
        const used: Record<string, number> = {};
        return chunk.replace(INLINE_PATTERN, (whole, rawKind: string, rawText: string, rawExtra?: string) => {
            const text = rawText.trim();
            const extra = rawExtra?.trim() ?? "";
            if (!isInlineKind(rawKind) || text.length === 0) return text || whole;
            const limit = rawKind === "metric" ? MARK_LIMITS.metric : Infinity;
            used[rawKind] = (used[rawKind] ?? 0) + 1;
            if (used[rawKind]! > limit) return text;
            const extraAttribute = extra ? ` x="${encodeMarkPayload(extra)}"` : "";
            return `<${INLINE_TAG} k="${rawKind}" t="${encodeMarkPayload(text)}"${extraAttribute} />`;
        });
    }).join("");
}

interface RewriteOptions {
    /** Body is still growing over SSE: hold back unterminated marks. */
    streaming?: boolean;
}

/**
 * Lower `[[kind:…]]` and `:::kind … :::` onto custom tags. Unknown kinds, marks
 * past their budget, and (while streaming) unterminated marks all degrade to
 * plain text.
 */
export function rewriteSemanticMarks(source: string, options: RewriteOptions = {}): string {
    const blockBudget: Record<string, number> = { thesis: MARK_LIMITS.thesis, risk: MARK_LIMITS.risk };

    return segmentByCode(source).map((segment) => {
        if (segment.code) return segment.text;

        const lines = segment.text.split("\n");
        const output: string[] = [];
        let openKind: BlockMarkKind | null = null;
        let openUnknown = false;
        let body: string[] = [];

        const emitBlock = (kind: BlockMarkKind, content: string) => {
            const remaining = blockBudget[kind] ?? 0;
            if (remaining <= 0 || content.trim().length === 0) {
                output.push(content);
                return;
            }
            blockBudget[kind] = remaining - 1;
            // Blank lines keep markdown-to-jsx from folding the tag into the
            // surrounding paragraph — the same rule <StockChart /> follows.
            output.push("", `<${BLOCK_TAG} k="${kind}" body="${encodeMarkPayload(content.trim())}" />`, "");
        };

        for (const line of lines) {
            if (openKind === null && !openUnknown) {
                const open = BLOCK_OPEN_PATTERN.exec(line);
                if (open) {
                    if (isBlockKind(open[1]!)) openKind = open[1];
                    else openUnknown = true;
                    body = [];
                    continue;
                }
                output.push(line);
                continue;
            }
            if (BLOCK_CLOSE_PATTERN.test(line)) {
                const content = rewriteInline(body.join("\n"));
                if (openKind) emitBlock(openKind, content);
                else output.push(content);
                openKind = null;
                openUnknown = false;
                body = [];
                continue;
            }
            body.push(line);
        }

        // Unterminated container: show the text, drop the marker. Streaming
        // bodies become cards once their closing ::: lands.
        if (openKind !== null || openUnknown) output.push(rewriteInline(body.join("\n")));

        // The blank lines around a card tag can stack with the author's own,
        // and markdown-to-jsx turns the surplus into an empty paragraph.
        const rewritten = rewriteInline(output.join("\n")).replace(/\n{3,}/g, "\n\n");
        return options.streaming ? stripUnterminatedInlineMark(rewritten) : rewritten;
    }).join("");
}

/** Drop a trailing half-written `[[kind:tex` so no raw syntax flashes mid-stream. */
export function stripUnterminatedInlineMark(source: string): string {
    const open = source.lastIndexOf("[[");
    if (open === -1) return source;
    if (source.indexOf("]]", open) !== -1) return source;
    if (source.slice(open).includes("\n")) return source;
    return source.slice(0, open);
}

/**
 * Parse a catalyst date. A bare `2026-10-28` is UTC midnight per spec, which
 * renders as the 27th anywhere west of Greenwich — a dated event must never
 * shift a day, so date-only strings are read as local calendar dates.
 */
export function parseMarkDate(value: string): Date | null {
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
    const parsed = dateOnly
        ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
        : new Date(trimmed);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export type MetricDirection = "up" | "down" | "flat";

const UP_WORDS = /(超出|高于|上调|上升|增长|回升|改善|扩大|beat|beats|above|raise[sd]?|up|higher|improv)/i;
const DOWN_WORDS = /(不及|低于|下调|下降|回落|恶化|收窄|miss(?:es|ed)?|below|cut|down|lower|deteriorat)/i;

/**
 * Direction is mechanically derivable, so the client decides it — the model
 * never picks a colour. `extra` (the comparison basis) wins over the value.
 */
export function classifyMetricDirection(text: string, extra = ""): MetricDirection {
    for (const candidate of [extra, text]) {
        if (!candidate) continue;
        const signed = /(^|[\s(（])([+-])\s*\d/.exec(candidate);
        if (signed) return signed[2] === "+" ? "up" : "down";
        if (UP_WORDS.test(candidate) && !DOWN_WORDS.test(candidate)) return "up";
        if (DOWN_WORDS.test(candidate) && !UP_WORDS.test(candidate)) return "down";
    }
    return "flat";
}

export type LevelRole = "support" | "resistance" | "stop" | "target" | "level";

// Matched anywhere in the extra, not just at its start: the model writes bases
// like "Deutsche Bank PT" or "next resistance zone", where the role word is not
// the first token.
const LEVEL_ROLES: Array<[RegExp, LevelRole]> = [
    [/(stop[-\s]?loss|\bstop\b|止损)/i, "stop"],
    [/(price target|\btarget\b|\bPT\b|目标价|目标位|止盈)/i, "target"],
    [/(support|支撑)/i, "support"],
    [/(resistance|阻力|压力位)/i, "resistance"],
];

export function classifyLevelRole(extra = ""): LevelRole {
    const trimmed = extra.trim();
    return LEVEL_ROLES.find(([pattern]) => pattern.test(trimmed))?.[1] ?? "level";
}

export interface AnswerSourceLink {
    index: number;
    title: string;
    url: string;
}

const SOURCE_LINE = /^[ \t]*(\d{1,2})[.)][ \t]*\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/gm;

/**
 * The numbered Sources list the orchestrator already writes at the end of an
 * answer. A `[[cite:…|3]]` mark binds to entry 3 here, so the citation card
 * needs no extra plumbing to know where a claim came from.
 */
export function parseAnswerSources(markdown: string): Map<number, AnswerSourceLink> {
    const byIndex = new Map<number, AnswerSourceLink>();
    for (const match of markdown.matchAll(SOURCE_LINE)) {
        const index = Number(match[1]);
        if (!Number.isFinite(index) || byIndex.has(index)) continue;
        byIndex.set(index, { index, title: match[2]!.trim(), url: match[3]! });
    }
    return byIndex;
}

/** Host without "www.", for the card's site label. */
export function sourceSiteLabel(url: string): string {
    try {
        return new URL(url).hostname.replace(/^www\./, "");
    } catch {
        return url;
    }
}

/**
 * Message-level freshness for marked figures. The chart already annotates
 * itself from the same timestamp (see MessageTimeContext); prose figures were
 * the blind spot. Below the threshold nothing is shown — churn is worse than
 * silence.
 */
export function figureFreshness(
    sentAtMs: number | null,
    nowMs: number,
): { level: "fresh" | "aging" | "stale"; minutes: number } {
    if (sentAtMs === null) return { level: "fresh", minutes: 0 };
    const minutes = Math.max(0, Math.floor((nowMs - sentAtMs) / 60_000));
    if (minutes < 10) return { level: "fresh", minutes };
    // A different calendar day means a different session: the figures describe
    // a market that has since opened and closed.
    const sameDay = new Date(sentAtMs).toDateString() === new Date(nowMs).toDateString();
    return { level: sameDay ? "aging" : "stale", minutes };
}
