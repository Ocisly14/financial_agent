import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { API_BASE_URL } from "@/lib/api";
import { applyStreamedPrice, type StreamablePriceQuote } from "@/lib/stockChart";

type QuoteFrame = { type?: string; symbol?: string; price?: number; ts?: number };

/**
 * Subscribes to the server's pushed price for one symbol and folds it into the
 * `["stock-quote", symbol]` cache entry the chart already reads.
 *
 * This does not replace the REST quote query — that one still owns `session`, the daily
 * aggregates and the staleness banner, and it stays as the backstop for when a proxy buffers
 * the stream or the connection dies without an error. What this removes is the polling floor
 * on the displayed price.
 *
 * `EventSource` is used rather than the app's fetch-based SSE reader because it reconnects on
 * its own, and this endpoint needs no headers (the app has no auth backend).
 */
export function useQuoteStream(symbol: string, enabled: boolean): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!enabled || !symbol || typeof EventSource === "undefined") return;

    const source = new EventSource(`${API_BASE_URL}/market/stocks/${encodeURIComponent(symbol)}/stream`);

    source.onmessage = (event: MessageEvent<string>) => {
      let frame: QuoteFrame;
      try {
        frame = JSON.parse(event.data) as QuoteFrame;
      } catch {
        return;
      }
      if (frame.type !== "quote" || typeof frame.price !== "number") return;
      const ts = typeof frame.ts === "number" ? frame.ts : Date.now();
      queryClient.setQueryData(
        ["stock-quote", symbol],
        (previous: StreamablePriceQuote | undefined) => applyStreamedPrice(previous, frame.price!, ts),
      );
    };

    // EventSource retries on its own; a logged error per drop would be noise.
    source.onerror = () => {};

    return () => source.close();
  }, [symbol, enabled, queryClient]);
}
