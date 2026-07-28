import type { RegisteredTool } from "../toolRegistry.ts";
import type { JsonObject } from "../../src/framework/types.ts";
import { fetchNews } from "./newsClient.ts";
import { buildNewsPrompt } from "./prompts.ts";
import { cacheRawData } from "../shared/rawDataCache.ts";

const SYMBOL_PATTERN = /\b(BTC|ETH|SOL|XRP|DOGE|BNB|ADA)\b/i;

function detectSymbol(task: string): string {
  const m = task.match(SYMBOL_PATTERN);
  return m ? m[1]!.toUpperCase() : "BTC";
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function createGetNewsTool(): RegisteredTool {
  return {
    name: "getnews",
    description:
      "Fetch recent crypto news articles from S3-backed SentiScore dataset and return structured sentiment context for report generation.",
    category: "non_trading",
    inputSchema: {
      type: "object",
      required: ["task"],
      properties: {
        task: {
          type: "string",
          description: "Natural-language request describing what news to fetch.",
        },
        symbol: {
          type: "string",
          description: "Crypto ticker, e.g. BTC, ETH, SOL. Detected from task if omitted.",
        },
        date: {
          type: "string",
          description: "Date in YYYY-MM-DD format. Defaults to today.",
        },
        limit: {
          type: "number",
          description: "Maximum articles to return (1–20). Defaults to 5.",
        },
      },
    },
    execute: async (input: JsonObject) => {
      const task = typeof input["task"] === "string" ? input["task"] : "";
      const symbol =
        typeof input["symbol"] === "string" && input["symbol"].trim()
          ? input["symbol"].trim().toUpperCase()
          : detectSymbol(task);
      const date =
        typeof input["date"] === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input["date"].trim())
          ? input["date"].trim()
          : todayIso();
      const rawLimit = typeof input["limit"] === "number" ? input["limit"] : 5;
      const limit = Math.min(Math.max(1, Math.floor(rawLimit)), 20);

      try {
        const articles = await fetchNews(symbol, date, limit);

        const sentiments = articles
          .map((a) => a.sentiment_normalized)
          .filter((s) => isFinite(s));
        const avgSentiment =
          sentiments.length > 0
            ? parseFloat(
                (sentiments.reduce((acc, s) => acc + s, 0) / sentiments.length).toFixed(4),
              )
            : 0;

        const formattedList = articles
          .map(
            (a, i) =>
              `${i + 1}. [${a.title}](${a.url}) — ${a.published} — sentiment: ${a.sentiment_normalized.toFixed(4)}\n   ${a.summary}`,
          )
          .join("\n");

        const prompt = buildNewsPrompt(symbol, date, avgSentiment, formattedList);

        // The article list is already rendered into the prompt (formattedList),
        // so data carries only aggregates — no duplicated article array. Full
        // articles are persisted to the local cache.
        await cacheRawData("news", `${symbol}_${date}`, articles);

        const data: JsonObject = {
          symbol,
          date,
          article_count: articles.length,
          avg_sentiment: avgSentiment,
        };

        return {
          summary: `Fetched ${articles.length} news items for ${symbol} on ${date}. Avg sentiment: ${avgSentiment.toFixed(4)}.`,
          generation_context: { prompt, data },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          summary: `News fetch failed: ${message}`,
          generation_context: {
            prompt: "No news data available.",
            data: { symbol, date, error: message },
          },
        };
      }
    },
  };
}
