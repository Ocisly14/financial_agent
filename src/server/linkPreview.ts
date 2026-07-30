import type * as http from "node:http";
import dns from "node:dns/promises";
import net from "node:net";

/**
 * Link previews for inline citations.
 *
 * The citation card's text (title, snippet, date) already travels with the
 * search results, so this endpoint exists only to add the one thing Tavily does
 * not give us: the page's og:image and site name.
 *
 * Fetching a URL chosen by upstream content is a server-side request forgery
 * surface, so every hop is validated: http(s) only, no credentials, no private
 * address space, a hard redirect/byte/time budget, and HTML content types only.
 */

export interface LinkPreview {
    url: string;
    siteName?: string;
    title?: string;
    description?: string;
    image?: string;
}

const FETCH_TIMEOUT_MS = 4_000;
const MAX_REDIRECTS = 3;
const MAX_BYTES = 256 * 1024;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 500;

const cache = new Map<string, { at: number; preview: LinkPreview | null }>();

/** Addresses that must never be reachable through a user-supplied URL. */
export function isBlockedAddress(address: string): boolean {
    const version = net.isIP(address);
    if (version === 4) {
        const [a = 0, b = 0] = address.split(".").map(Number);
        if (a === 10 || a === 127 || a === 0) return true;
        if (a === 172 && b >= 16 && b <= 31) return true;
        if (a === 192 && b === 168) return true;
        if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
        if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
        return a >= 224; // multicast and reserved
    }
    if (version === 6) {
        const normalized = address.toLowerCase().replace(/^\[|\]$/g, "");
        if (normalized === "::1" || normalized === "::") return true;
        if (/^f[cd]/.test(normalized)) return true; // unique-local
        if (normalized.startsWith("fe80")) return true; // link-local
        if (normalized.startsWith("::ffff:")) return isBlockedAddress(normalized.slice(7));
        return false;
    }
    return true;
}

/** Reject a URL before any DNS work: scheme, credentials, and literal IPs. */
export function isAllowedPreviewUrl(candidate: string): boolean {
    let parsed: URL;
    try {
        parsed = new URL(candidate);
    } catch {
        return false;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    if (parsed.username || parsed.password) return false;
    const host = parsed.hostname.replace(/^\[|\]$/g, "");
    if (net.isIP(host) && isBlockedAddress(host)) return false;
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) return false;
    return true;
}

async function resolvesToPublicAddress(hostname: string): Promise<boolean> {
    const host = hostname.replace(/^\[|\]$/g, "");
    if (net.isIP(host)) return !isBlockedAddress(host);
    try {
        const records = await dns.lookup(host, { all: true });
        return records.length > 0 && records.every((record) => !isBlockedAddress(record.address));
    } catch {
        return false;
    }
}

function decodeEntities(value: string): string {
    return value
        .replace(/&(#\d+|#x[0-9a-f]+|amp|lt|gt|quot|#39|apos|nbsp);/gi, (whole, entity: string) => {
            const named: Record<string, string> = {
                amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: " ",
            };
            const key = entity.toLowerCase();
            if (named[key]) return named[key]!;
            if (key.startsWith("#x")) return String.fromCodePoint(Number.parseInt(key.slice(2), 16));
            if (key.startsWith("#")) return String.fromCodePoint(Number(key.slice(1)));
            return whole;
        })
        .trim();
}

function metaContent(html: string, property: string): string | undefined {
    const pattern = new RegExp(
        `<meta[^>]+(?:property|name)\\s*=\\s*["']${property}["'][^>]*>`,
        "i",
    );
    const tag = pattern.exec(html)?.[0];
    if (!tag) return undefined;
    const content = /content\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
    const decoded = content ? decodeEntities(content) : "";
    return decoded.length > 0 ? decoded : undefined;
}

/** Pull the Open Graph fields a citation card can use. Exported for tests. */
export function parsePreviewMetadata(html: string, finalUrl: string): LinkPreview {
    const preview: LinkPreview = { url: finalUrl };
    const siteName = metaContent(html, "og:site_name");
    const title = metaContent(html, "og:title")
        ?? (/<title[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(html)?.[1]
            ? decodeEntities(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(html)![1]!)
            : undefined);
    const description = metaContent(html, "og:description") ?? metaContent(html, "description");
    const image = metaContent(html, "og:image") ?? metaContent(html, "twitter:image");
    if (siteName) preview.siteName = siteName;
    if (title) preview.title = title.slice(0, 200);
    if (description) preview.description = description.slice(0, 400);
    if (image) {
        try {
            const absolute = new URL(image, finalUrl);
            if (absolute.protocol === "http:" || absolute.protocol === "https:") preview.image = absolute.toString();
        } catch {
            // A malformed og:image simply means no image.
        }
    }
    return preview;
}

async function readCapped(response: Response): Promise<string> {
    const reader = response.body?.getReader();
    if (!reader) return "";
    const decoder = new TextDecoder();
    let html = "";
    let size = 0;
    // The metadata lives in <head>, so a partial read is enough — and it caps
    // what a hostile response can cost us.
    while (size < MAX_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        html += decoder.decode(value, { stream: true });
        if (/<\/head>/i.test(html)) break;
    }
    await reader.cancel().catch(() => {});
    return html;
}

export async function fetchLinkPreview(
    target: string,
    fetchImpl: typeof fetch = fetch,
): Promise<LinkPreview | null> {
    if (!isAllowedPreviewUrl(target)) return null;

    let current = target;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        if (!isAllowedPreviewUrl(current)) return null;
        if (!(await resolvesToPublicAddress(new URL(current).hostname))) return null;

        let response: Response;
        try {
            response = await fetchImpl(current, {
                redirect: "manual",
                signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
                headers: {
                    // Identify honestly and ask for markup only.
                    "User-Agent": "FinancialAgent-LinkPreview/1.0",
                    Accept: "text/html,application/xhtml+xml",
                },
            });
        } catch {
            return null;
        }

        const location = response.headers.get("location");
        if (response.status >= 300 && response.status < 400 && location) {
            try {
                current = new URL(location, current).toString();
            } catch {
                return null;
            }
            continue;
        }
        if (!response.ok) return null;
        const contentType = response.headers.get("content-type") ?? "";
        if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) return null;
        return parsePreviewMetadata(await readCapped(response), current);
    }
    return null;
}

function cached(target: string): LinkPreview | null | undefined {
    const hit = cache.get(target);
    if (!hit) return undefined;
    if (Date.now() - hit.at > CACHE_TTL_MS) {
        cache.delete(target);
        return undefined;
    }
    return hit.preview;
}

function remember(target: string, preview: LinkPreview | null): void {
    if (cache.size >= CACHE_MAX_ENTRIES) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(target, { at: Date.now(), preview });
}

/** GET /link-preview?url=… — og:image and site name for a citation card. */
export async function handleLinkPreview(
    searchParams: URLSearchParams,
    res: http.ServerResponse,
): Promise<void> {
    const target = searchParams.get("url") ?? "";
    if (!isAllowedPreviewUrl(target)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unsupported url" }));
        return;
    }
    let preview = cached(target);
    if (preview === undefined) {
        preview = await fetchLinkPreview(target);
        remember(target, preview);
    }
    res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=21600",
    });
    res.end(JSON.stringify({ preview }));
}

/** Test seam. */
export function clearLinkPreviewCache(): void {
    cache.clear();
}
