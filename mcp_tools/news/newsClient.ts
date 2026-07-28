import { env } from "../config.ts";
import { s3GetText, s3GetNewestKey } from "../shared/s3Client.ts";

export type NewsItem = {
  title: string;
  summary: string;
  url: string;
  published: string;
  sentiment_normalized: number;
};

const SENTIMENT_COLS = ["sn", "mn", "ln", "neu", "lp", "mp", "sp"] as const;
const SENTIMENT_WEIGHTS: Record<string, number> = {
  sn: -1,
  mn: -0.667,
  ln: -0.333,
  neu: 0,
  lp: 0.333,
  mp: 0.667,
  sp: 1,
};

function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const next = text[i + 1];

    if (ch === '"' && inQuotes && next === '"') {
      cell += '"';
      i++;
    } else if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      row.push(cell);
      cell = "";
    } else if ((ch === "\n" || ch === "\r") && !inQuotes) {
      if (ch === "\r" && next === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }

  row.push(cell);
  if (row.some((c) => c.trim())) rows.push(row);
  return rows;
}

function parseCsv(csvText: string): Record<string, string>[] {
  const rows = parseCsvRows(csvText);
  if (rows.length === 0) return [];
  const headers = rows[0]!.map((h) => h.trim().toLowerCase());
  return rows.slice(1).map((row) => {
    const record: Record<string, string> = {};
    headers.forEach((h, idx) => {
      record[h] = (row[idx] ?? "").trim();
    });
    return record;
  });
}

function isArticleFormat(headers: Set<string>): boolean {
  return (headers.has("title") || headers.has("headline")) && (headers.has("canonical_link") || headers.has("url"));
}

function computeSentimentFromCategories(row: Record<string, string>): number | null {
  let weighted = 0;
  let total = 0;
  for (const col of SENTIMENT_COLS) {
    const val = parseFloat(row[col] ?? "");
    if (!isFinite(val)) return null;
    weighted += SENTIMENT_WEIGHTS[col]! * val;
    total += val;
  }
  if (total === 0) return 0;
  const raw = weighted / total;
  return Math.max(-1, Math.min(1, raw));
}

function computeScalarSentiment(row: Record<string, string>): number | null {
  for (const key of ["score", "sentiment", "sentiscore", "value", "expected_positive", "sentiment_normalized"]) {
    const raw = row[key];
    if (raw === undefined || raw === "") continue;
    const val = parseFloat(raw);
    if (!isFinite(val)) continue;
    if (Math.abs(val) <= 1) return val;
    return Math.max(-1, Math.min(1, val / 100));
  }
  return null;
}

function deriveSentiment(row: Record<string, string>): number {
  const headers = new Set(Object.keys(row));
  const hasCats = SENTIMENT_COLS.every((c) => headers.has(c));
  if (hasCats) {
    const fromCats = computeSentimentFromCategories(row);
    if (fromCats !== null) return fromCats;
  }
  const fromScalar = computeScalarSentiment(row);
  return fromScalar ?? 0;
}

function rowToArticle(row: Record<string, string>): NewsItem {
  const title = row["title"] ?? row["headline"] ?? "";
  const summary = row["summary"] ?? row["description"] ?? "";
  const url = row["canonical_link"] ?? row["url"] ?? row["link"] ?? "";
  const published = row["published"] ?? row["date_publish"] ?? row["published_at"] ?? "";
  return {
    title,
    summary,
    url,
    published,
    sentiment_normalized: deriveSentiment(row),
  };
}

function rowToHourlyItem(row: Record<string, string>): NewsItem {
  const time = row["hour"] ?? row["datetime"] ?? row["timestamp"] ?? "";
  const sentiment = deriveSentiment(row);
  return {
    title: `Hourly sentiment rollup${time ? ` — ${time}` : ""}`,
    summary: `Aggregated hourly sentiment score: ${sentiment.toFixed(4)}`,
    url: "",
    published: time,
    sentiment_normalized: sentiment,
  };
}

async function tryFetchCsv(bucket: string, prefix: string): Promise<string | null> {
  try {
    const key = await s3GetNewestKey(bucket, prefix);
    if (!key) return null;
    return await s3GetText(bucket, key);
  } catch {
    return null;
  }
}

export async function fetchNews(symbol: string, date: string, limit: number): Promise<NewsItem[]> {
  const bucket = env("SENTISCORE_S3_BUCKET", "sentiscoredata-new");
  const sym = symbol.toUpperCase();
  const clampedLimit = Math.min(Math.max(1, limit), 20);

  const originalPrefix = `crypto_news/${date}/original_score/${sym}/`;
  const hourlyPrefix = `crypto_news/${date}/hourly_score/${sym}/`;

  let csvText = await tryFetchCsv(bucket, originalPrefix);
  if (!csvText) {
    csvText = await tryFetchCsv(bucket, hourlyPrefix);
  }
  if (!csvText) return [];

  const rows = parseCsv(csvText);
  if (rows.length === 0) return [];

  const headers = new Set(Object.keys(rows[0]!));

  if (isArticleFormat(headers)) {
    return rows.slice(0, clampedLimit).map(rowToArticle);
  }

  // hourly rollup format
  return rows.slice(0, clampedLimit).map(rowToHourlyItem);
}
