import { evaluatePriceTrigger, type OhlcSample, type PriceTrigger } from "../../../mcp_tools/trading/strategy/priceTrigger.ts";
import { createQuoteFilter } from "../../../src/data/stock/realtime/quoteFilter.ts";

export type Candle = { ts: number; high: number; low: number; close: number };

export type ReplayFixture = {
  id: string;
  symbol: string;
  trigger: PriceTrigger;
  candles: Candle[];
  expectedFire: boolean;
  label: string;
};

/** A tight synthetic spread: the fixtures record prices, not order books. */
const SPREAD = 0.0001;

/**
 * Replays a labelled price sequence through the production pipeline.
 *
 * The entry filter is part of that pipeline, not decoration. It is what now separates an
 * unrepresentative print from a real move — the job the N-sample confirmation gate used to do —
 * so a replay that skipped it would report false triggers the running system would never make.
 */
export function replay(fixture: ReplayFixture): {
  fired: boolean;
  fireIndex: number | null;
  filtered: number;
} {
  const filter = createQuoteFilter();
  const buffer: OhlcSample[] = [];
  let anchor = fixture.trigger.reference_price;
  let filtered = 0;
  const windowMs = fixture.trigger.type === "rolling_change" ? fixture.trigger.window_minutes * 60_000 : 0;

  for (let i = 0; i < fixture.candles.length; i++) {
    const candle = fixture.candles[i]!;
    const accepted = filter.accept({
      bid: candle.close * (1 - SPREAD),
      ask: candle.close * (1 + SPREAD),
      ts: candle.ts,
    });
    if (!accepted.ok) {
      filtered += 1;
      continue;
    }
    buffer.push(candle);

    // `evaluatePriceTrigger` takes the extreme of whatever buffer it is handed and never reads a
    // timestamp, so the window is the caller's job. strategyMonitor does it in two parts, and both
    // matter on US equities: it will not evaluate a rolling_change until the buffer spans the whole
    // window (`feed.isArmed`), and it then passes only the samples inside it (`feed.window`).
    // Without the first, a strategy fires on its first three prints of the day; without the second,
    // a 5% move measured across an overnight close satisfies a 30-minute window.
    if (windowMs > 0) {
      const oldest = buffer[0]!.ts;
      if (candle.ts - oldest < windowMs) continue;
    }
    const samples = windowMs > 0 ? buffer.filter((sample) => candle.ts - sample.ts <= windowMs) : buffer;

    const trigger: PriceTrigger = anchor !== undefined ? { ...fixture.trigger, reference_price: anchor } : fixture.trigger;
    const result = evaluatePriceTrigger(trigger, samples, candle.close);
    if (result.nextReferencePrice !== undefined) anchor = result.nextReferencePrice;
    if (result.conditionMet) return { fired: true, fireIndex: i, filtered };
  }
  return { fired: false, fireIndex: null, filtered };
}
