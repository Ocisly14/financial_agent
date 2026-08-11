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

class KeyManager {
  private readonly keys: string[];
  private exhausted = new Set<string>();
  private index = 0;

  constructor(keys: string[]) {
    this.keys = keys;
  }

  getActive(): string | undefined {
    const available = this.keys.filter((key) => !this.exhausted.has(key));
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
    const key = process.env[`TAVILY_API_KEY_${i}`];
    if (!key) break;
    if (!keys.includes(key)) keys.push(key);
  }
  return new KeyManager(keys);
}

let keyManager: KeyManager | undefined;

function getKeyManager(): KeyManager {
  return (keyManager ??= buildKeyManager());
}

export async function tavilySearch(options: SearchOptions): Promise<SearchResult[]> {
  const maxAttempts = 5;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const key = getKeyManager().getActive();
    if (!key) throw new Error("All Tavily API keys exhausted or rate-limited");
    try {
      const client = tavily({ apiKey: key });
      const searchOptions: Parameters<ReturnType<typeof tavily>["search"]>[1] = {
        maxResults: options.limit ?? 5,
        topic: options.topic ?? "general",
        searchDepth: options.searchDepth ?? "basic",
        includeAnswer: false,
        includeImages: true,
      };
      const response = await client.search(options.query, searchOptions);
      const images: string[] = (response.images ?? [])
        .map((image) => (typeof image === "string" ? image : (image as { url?: string }).url ?? ""))
        .filter(Boolean);

      return (response.results ?? []).map((result, index) => {
        const normalized: SearchResult = {
          title: result.title,
          url: result.url,
          content: result.content,
          publishedDate: result.publishedDate,
          score: result.score ?? 0,
        };
        if (index === 0 && images.length > 0) normalized.images = images;
        return normalized;
      });
    } catch (error: unknown) {
      const status = (error as { status?: number }).status;
      if (status === 432 || status === 429) {
        getKeyManager().markExhausted(key);
        continue;
      }
      throw error;
    }
  }
  throw new Error("Tavily search failed after retries");
}
