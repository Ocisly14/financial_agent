const FALLBACK_PRICES: Record<string, number> = {
  BTC: 105_000, ETH: 3_500, SOL: 180, BNB: 600, XRP: 0.5,
  ADA: 0.4, DOGE: 0.15, AVAX: 35, LINK: 15, DOT: 7,
};

export interface PaperBalance {
  asset: string;
  free: number;
}

export interface PaperOrder {
  orderId: string;
  symbol: string;
  side: "BUY" | "SELL";
  status: "FILLED";
  executedQty: string;
  cummulativeQuoteQty: string;
  fills: Array<{ price: string; qty: string; commission: string; commissionAsset: string }>;
  transactTime: number;
}

interface UserPaperState {
  balances: Map<string, number>;
  orders: PaperOrder[];
  orderCounter: number;
}

const paperStates = new Map<string, UserPaperState>();

function getState(userId: string): UserPaperState {
  let state = paperStates.get(userId);
  if (!state) {
    state = {
      balances: new Map([["USDT", 10_000], ["USDC", 0]]),
      orders: [],
      orderCounter: 1,
    };
    paperStates.set(userId, state);
  }
  return state;
}

/** Normalize a symbol like "BTC", "BTC/USD", "BTC-USDT", or "BTCUSDT" down to its base asset, e.g. "BTC". */
function normalizeBaseSymbol(symbol: string): string {
  const head = symbol.toUpperCase().split(/[/-]/)[0] ?? "";
  return head.replace(/USDT$|USDC$|USD$/, "");
}

async function getMidPrice(symbol: string): Promise<{ price: number; fetchedAtMs: number }> {
  const base = normalizeBaseSymbol(symbol);
  try {
    const binanceSymbol = base + "USDT";
    const r = await fetch(`https://api.binance.com/api/v3/ticker/bookTicker?symbol=${binanceSymbol}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json() as { bidPrice?: string; askPrice?: string };
    const bid = parseFloat(data.bidPrice ?? "0");
    const ask = parseFloat(data.askPrice ?? "0");
    if (bid > 0 && ask > 0) return { price: (bid + ask) / 2, fetchedAtMs: Date.now() };
  } catch {
    // fall through to fallback
  }
  const fallback = FALLBACK_PRICES[base] ?? 1;
  return { price: fallback, fetchedAtMs: Date.now() };
}

export function getPaperBalances(userId: string): PaperBalance[] {
  const state = getState(userId);
  const result: PaperBalance[] = [];
  for (const [asset, free] of state.balances) {
    if (free > 0) result.push({ asset, free });
  }
  return result;
}

export function getPaperOrders(userId: string): PaperOrder[] {
  return getState(userId).orders;
}

export async function executePaperOrder(
  userId: string,
  symbol: string,
  side: "BUY" | "SELL",
  baseSize: number | undefined,
  quoteSize: number | undefined,
): Promise<PaperOrder> {
  const state = getState(userId);
  const base = normalizeBaseSymbol(symbol);
  const quote = "USDT";
  const { price, fetchedAtMs } = await getMidPrice(base);
  const SLIPPAGE = 0.0005; // 5 bps simulated slippage
  const fillPrice = side === "BUY" ? price * (1 + SLIPPAGE) : price * (1 - SLIPPAGE);

  let baseQty: number;
  let quoteQty: number;
  if (side === "BUY") {
    if (quoteSize !== undefined) {
      quoteQty = quoteSize;
      baseQty = quoteQty / fillPrice;
    } else {
      baseQty = baseSize ?? 0;
      quoteQty = baseQty * fillPrice;
    }
    const quoteBalance = state.balances.get(quote) ?? 0;
    if (quoteBalance < quoteQty) throw new Error(`Insufficient ${quote}: have ${quoteBalance.toFixed(2)}, need ${quoteQty.toFixed(2)}`);
    state.balances.set(quote, quoteBalance - quoteQty);
    state.balances.set(base, (state.balances.get(base) ?? 0) + baseQty);
  } else {
    if (baseSize !== undefined) {
      baseQty = baseSize;
      quoteQty = baseQty * fillPrice;
    } else {
      quoteQty = quoteSize ?? 0;
      baseQty = quoteQty / fillPrice;
    }
    const baseBalance = state.balances.get(base) ?? 0;
    if (baseBalance < baseQty) throw new Error(`Insufficient ${base}: have ${baseBalance.toFixed(4)}, need ${baseQty.toFixed(4)}`);
    state.balances.set(base, baseBalance - baseQty);
    state.balances.set(quote, (state.balances.get(quote) ?? 0) + quoteQty);
  }

  const orderId = String(1_000_000 + state.orderCounter++);
  const order: PaperOrder = {
    orderId,
    symbol: base + quote,
    side,
    status: "FILLED",
    executedQty: baseQty.toFixed(8),
    cummulativeQuoteQty: quoteQty.toFixed(2),
    fills: [{ price: fillPrice.toFixed(2), qty: baseQty.toFixed(8), commission: "0", commissionAsset: quote }],
    transactTime: fetchedAtMs,
  };
  state.orders.push(order);
  return order;
}

export function resetPaperAccount(userId: string): void {
  paperStates.delete(userId);
}
