import { evaluatePriceTrigger, type OhlcSample, type PriceTrigger } from "../../../mcp_tools/trading/strategy/priceTrigger.ts";
import { stepConfirmation, type ConfirmState } from "../../../src/trading/confirmation.ts";

export type Candle = { ts: number; high: number; low: number; close: number };

export type ReplayFixture = {
  id: string;
  symbol: string;
  trigger: PriceTrigger;
  candles: Candle[];
  expectedFire: boolean;
  label: string;
};

export function replay(fixture: ReplayFixture): { fired: boolean; fireIndex: number | null } {
  let state: ConfirmState = { count: 0 };
  let anchor = fixture.trigger.reference_price;
  for (let i = 0; i < fixture.candles.length; i++) {
    const buffer: OhlcSample[] = fixture.candles.slice(0, i + 1);
    const trigger: PriceTrigger = anchor !== undefined ? { ...fixture.trigger, reference_price: anchor } : fixture.trigger;
    const result = evaluatePriceTrigger(trigger, buffer, fixture.candles[i]!.close);
    if (result.nextReferencePrice !== undefined) anchor = result.nextReferencePrice;
    const stepped = stepConfirmation(state, result.conditionMet, fixture.trigger.confirm_samples);
    state = stepped.state;
    if (stepped.fired) return { fired: true, fireIndex: i };
  }
  return { fired: false, fireIndex: null };
}
