const SEC_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";
const SEC_DATA_BASE = "https://data.sec.gov";
const DEFAULT_MIN_REQUEST_INTERVAL_MS = 125;
const TICKER_CACHE_MS = 24 * 60 * 60 * 1_000;
const SUBMISSIONS_CACHE_MS = 5 * 60 * 1_000;
const FACTS_CACHE_MS = 15 * 60 * 1_000;

export type SecCompanyIdentifier = {
  cik: number;
  ticker: string;
  title: string;
};

export type SecDataProvider = {
  resolveCompany: (symbol: string) => Promise<SecCompanyIdentifier | undefined>;
  getSubmissions: (cik: number) => Promise<Record<string, unknown>>;
  getCompanyFacts: (cik: number) => Promise<Record<string, unknown>>;
};

export class SecApiError extends Error {
  readonly code: "sec_configuration_error" | "sec_request_failed";
  readonly status?: number;

  constructor(
    code: "sec_configuration_error" | "sec_request_failed",
    message: string,
    status?: number,
  ) {
    super(message);
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type CacheEntry = {
  expiresAt: number;
  value: unknown;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function normalizeTicker(symbol: string): string {
  return symbol.trim().toUpperCase().replaceAll(".", "-");
}

export function paddedCik(cik: number): string {
  return String(cik).padStart(10, "0");
}

export function createSecClient(options: {
  fetch?: FetchLike;
  userAgent?: string;
  minRequestIntervalMs?: number;
  now?: () => number;
} = {}): SecDataProvider {
  const fetchImpl = options.fetch ?? fetch;
  const userAgent = options.userAgent ?? process.env["SEC_USER_AGENT"] ?? "";
  const minRequestIntervalMs = options.minRequestIntervalMs ?? DEFAULT_MIN_REQUEST_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const cache = new Map<string, CacheEntry>();
  let requestQueue: Promise<void> = Promise.resolve();
  let nextRequestAt = 0;

  function validateUserAgent(): void {
    if (!userAgent.trim() || !userAgent.includes("@")) {
      throw new SecApiError(
        "sec_configuration_error",
        "SEC_USER_AGENT must identify the application and include a contact email, for example 'FinancialAgent admin@example.com'.",
      );
    }
  }

  async function waitForRequestSlot(): Promise<void> {
    const scheduled = requestQueue.then(async () => {
      const delay = Math.max(0, nextRequestAt - now());
      if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));
      nextRequestAt = now() + minRequestIntervalMs;
    });
    requestQueue = scheduled.catch(() => undefined);
    await scheduled;
  }

  async function getJson(url: string, ttlMs: number): Promise<unknown> {
    validateUserAgent();
    const cached = cache.get(url);
    if (cached && cached.expiresAt > now()) return cached.value;

    await waitForRequestSlot();
    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers: {
          Accept: "application/json",
          "Accept-Encoding": "gzip, deflate",
          "User-Agent": userAgent,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new SecApiError("sec_request_failed", `SEC request failed: ${message}`);
    }

    if (!response.ok) {
      const retryAfter = response.headers.get("retry-after");
      const suffix = retryAfter ? ` Retry after ${retryAfter}.` : "";
      throw new SecApiError(
        "sec_request_failed",
        `SEC request returned HTTP ${response.status}.${suffix}`,
        response.status,
      );
    }

    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new SecApiError("sec_request_failed", "SEC returned a response that was not valid JSON.");
    }
    cache.set(url, { expiresAt: now() + ttlMs, value });
    return value;
  }

  async function tickerMap(): Promise<Map<string, SecCompanyIdentifier>> {
    const payload = asRecord(await getJson(SEC_TICKERS_URL, TICKER_CACHE_MS));
    if (!payload) throw new SecApiError("sec_request_failed", "SEC ticker mapping had an unexpected shape.");

    const companies = new Map<string, SecCompanyIdentifier>();
    for (const raw of Object.values(payload)) {
      const row = asRecord(raw);
      if (!row) continue;
      const cik = typeof row["cik_str"] === "number" ? row["cik_str"] : Number(row["cik_str"]);
      const ticker = typeof row["ticker"] === "string" ? row["ticker"].trim().toUpperCase() : "";
      const title = typeof row["title"] === "string" ? row["title"].trim() : "";
      if (!Number.isInteger(cik) || cik <= 0 || !ticker || !title) continue;
      companies.set(normalizeTicker(ticker), { cik, ticker, title });
    }
    return companies;
  }

  return {
    async resolveCompany(symbol) {
      return (await tickerMap()).get(normalizeTicker(symbol));
    },
    async getSubmissions(cik) {
      const value = asRecord(await getJson(
        `${SEC_DATA_BASE}/submissions/CIK${paddedCik(cik)}.json`,
        SUBMISSIONS_CACHE_MS,
      ));
      if (!value) throw new SecApiError("sec_request_failed", "SEC submissions response had an unexpected shape.");
      return value;
    },
    async getCompanyFacts(cik) {
      const value = asRecord(await getJson(
        `${SEC_DATA_BASE}/api/xbrl/companyfacts/CIK${paddedCik(cik)}.json`,
        FACTS_CACHE_MS,
      ));
      if (!value) throw new SecApiError("sec_request_failed", "SEC company-facts response had an unexpected shape.");
      return value;
    },
  };
}
