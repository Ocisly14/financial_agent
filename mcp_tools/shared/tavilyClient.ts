import { tavily } from "@tavily/core";

export type SearchResult = {
  title: string;
  url: string;
  content: string;
  publishedDate?: string;
  score: number;
  images?: string[];
};

export type SearchOptions = {
  query: string;
  topic?: "general" | "news";
  limit?: number;
  searchDepth?: "basic" | "advanced";
};

// Simple round-robin key manager
class KeyManager {
  private readonly keys: string[];
  private exhausted = new Set<string>();
  private index = 0;

  constructor(keys: string[]) {
    this.keys = keys;
  }

  getActive(): string | undefined {
    const available = this.keys.filter((k) => !this.exhausted.has(k));
    if (!available.length) return undefined;
    const key = available[this.index % available.length]!;
    this.index++;
    return key;
  }

  markExhausted(key: string): void {
    this.exhausted.add(key);
  }
}

function buildKeyManager(): KeyManager {
  const keys: string[] = [];
  const base = process.env["TAVILY_API_KEY"];
  if (base) keys.push(base);
  for (let i = 1; i <= 20; i++) {
    const k = process.env[`TAVILY_API_KEY_${i}`];
    if (!k) break;
    if (!keys.includes(k)) keys.push(k);
  }
  return new KeyManager(keys);
}

let _km: KeyManager | undefined;
function km(): KeyManager {
  return (_km ??= buildKeyManager());
}

export async function tavilySearch(opts: SearchOptions): Promise<SearchResult[]> {
  const maxAttempts = 5;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const key = km().getActive();
    if (!key) throw new Error("All Tavily API keys exhausted or rate-limited");
    try {
      const client = tavily({ apiKey: key });
      const searchOpts: Parameters<ReturnType<typeof tavily>["search"]>[1] = {
        maxResults: opts.limit ?? 5,
        topic: opts.topic ?? "general",
        searchDepth: opts.searchDepth ?? "basic",
        includeAnswer: false,
        includeImages: true,
      };
      if (opts.topic === "news") searchOpts.days = 7;
      const resp = await client.search(opts.query, searchOpts);
      const images: string[] = (resp.images ?? []).map((img) =>
        typeof img === "string" ? img : (img as { url?: string }).url ?? ""
      ).filter(Boolean);
      return (resp.results ?? []).map((r, i) => {
        const result: SearchResult = {
          title: r.title,
          url: r.url,
          content: r.content,
          publishedDate: r.publishedDate,
          score: r.score ?? 0,
        };
        if (i === 0 && images.length > 0) result.images = images;
        return result;
      });
    } catch (err: unknown) {
      const status = (err as { status?: number }).status;
      if (status === 432 || status === 429) {
        const usedKey = km().getActive();
        if (usedKey) km().markExhausted(usedKey);
        continue;
      }
      throw err;
    }
  }
  throw new Error("Tavily search failed after retries");
}
