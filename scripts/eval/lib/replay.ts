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

    const trigger: PriceTrigger = anchor !== undefined ? { ...fixture.trigger, reference_price: anchor } : fixture.trigger;
    const result = evaluatePriceTrigger(trigger, buffer, candle.close);
    if (result.nextReferencePrice !== undefined) anchor = result.nextReferencePrice;
    if (result.conditionMet) return { fired: true, fireIndex: i, filtered };
  }
  return { fired: false, fireIndex: null, filtered };
}
