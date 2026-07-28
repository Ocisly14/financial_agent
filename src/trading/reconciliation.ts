import { EventEmitter } from "node:events";
import { binanceFetch } from "../../mcp_tools/trading/binanceClient.ts";
import { coinbaseFetch } from "../../mcp_tools/trading/coinbaseAuth.ts";

export type OrderState =
  | "pending"
  | "new"
  | "partially_filled"
  | "filled"
  | "canceled"
  | "rejected"
  | "expired"
  | "unknown";

export interface TrackedOrder {
  clientOrderId: string;
  exchangeOrderId: string;
  userId: string;
  venue: "binance" | "coinbase";
  symbol: string;
  side: "BUY" | "SELL";
  state: OrderState;
  fillQty?: string;
  fillPrice?: string;
  createdAtMs: number;
  updatedAtMs: number;
  credentials: { apiKey?: string; apiSecret?: string; apiKeyName?: string; apiKeySecret?: string };
}

export type ReconciliationEvent =
  | { type: "order_update"; order: TrackedOrder }
  | { type: "order_filled"; order: TrackedOrder }
  | { type: "order_failed"; order: TrackedOrder; reason: string };

const TERMINAL_STATES: ReadonlySet<OrderState> = new Set(["filled", "canceled", "rejected", "expired"]);
const POLL_INTERVAL_MS = 5_000;
const MAX_TRACK_MS = 10 * 60 * 1000; // 10 minutes

class ReconciliationService extends EventEmitter {
  private orders = new Map<string, TrackedOrder>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  registerOrder(order: Omit<TrackedOrder, "state" | "createdAtMs" | "updatedAtMs">): void {
    const now = Date.now();
    this.orders.set(order.clientOrderId, {
      ...order,
      state: "pending",
      createdAtMs: now,
      updatedAtMs: now,
    });
    this.ensurePolling();
  }

  getOrder(clientOrderId: string): TrackedOrder | undefined {
    return this.orders.get(clientOrderId);
  }

  getOrdersByUser(userId: string): TrackedOrder[] {
    return Array.from(this.orders.values()).filter((o) => o.userId === userId);
  }

  getPendingCount(userId: string): number {
    return this.getOrdersByUser(userId).filter((o) => !TERMINAL_STATES.has(o.state)).length;
  }

  getStaleCount(userId: string, thresholdMs = 60_000): number {
    const now = Date.now();
    return this.getOrdersByUser(userId).filter(
      (o) => !TERMINAL_STATES.has(o.state) && now - o.createdAtMs > thresholdMs,
    ).length;
  }

  getUnknownStateCount(userId: string, symbol: string): number {
    return this.getOrdersByUser(userId).filter(
      (o) => o.state === "unknown" && o.symbol === symbol && Date.now() - o.createdAtMs > 5_000,
    ).length;
  }

  private ensurePolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => void this.pollAll(), POLL_INTERVAL_MS);
    (this.pollTimer as unknown as { unref?: () => void }).unref?.();
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async pollAll(): Promise<void> {
    const now = Date.now();
    const pending = Array.from(this.orders.values()).filter((o) => !TERMINAL_STATES.has(o.state));
    if (pending.length === 0) {
      this.stopPolling();
      return;
    }
    await Promise.allSettled(
      pending.map(async (order) => {
        if (now - order.createdAtMs > MAX_TRACK_MS) {
          this.updateOrderState(order.clientOrderId, "expired");
          return;
        }
        try {
          const newState = await this.checkOrderStatus(order);
          if (newState !== order.state) {
            this.updateOrderState(order.clientOrderId, newState);
          }
        } catch {
          // keep current state on transient error
        }
      }),
    );
  }

  private async checkOrderStatus(order: TrackedOrder): Promise<OrderState> {
    if (order.venue === "binance") {
      const creds = { apiKey: order.credentials.apiKey ?? "", apiSecret: order.credentials.apiSecret ?? "" };
      const binanceSymbol = order.symbol.toUpperCase().replace(/-/, "") + (order.symbol.includes("USDT") ? "" : "USDT");
      const r = await binanceFetch(creds, "GET", "/api/v3/order", {
        symbol: binanceSymbol,
        orderId: order.exchangeOrderId,
      }) as Record<string, unknown>;
      return mapBinanceStatus(String(r["status"] ?? "UNKNOWN"));
    } else {
      const creds = { apiKeyName: order.credentials.apiKeyName ?? "", apiKeySecret: order.credentials.apiKeySecret ?? "" };
      const r = await coinbaseFetch(creds, "GET", `/api/v3/brokerage/orders/historical/${order.exchangeOrderId}`) as Record<string, unknown>;
      const o = r["order"] as Record<string, unknown> | undefined;
      return mapCoinbaseStatus(String(o?.["status"] ?? "UNKNOWN"));
    }
  }

  private updateOrderState(clientOrderId: string, newState: OrderState, meta?: { fillQty?: string; fillPrice?: string; reason?: string }): void {
    const order = this.orders.get(clientOrderId);
    if (!order) return;
    const updated: TrackedOrder = { ...order, state: newState, updatedAtMs: Date.now(), ...meta };
    this.orders.set(clientOrderId, updated);

    const event: ReconciliationEvent = { type: "order_update", order: updated };
    this.emit("order_update", event);

    if (newState === "filled") {
      this.emit("order_filled", { type: "order_filled", order: updated } satisfies ReconciliationEvent);
    } else if (newState === "rejected" || newState === "expired") {
      this.emit("order_failed", { type: "order_failed", order: updated, reason: meta?.reason ?? newState } satisfies ReconciliationEvent);
    }
  }
}

function mapBinanceStatus(status: string): OrderState {
  switch (status.toUpperCase()) {
    case "NEW": return "new";
    case "PARTIALLY_FILLED": return "partially_filled";
    case "FILLED": return "filled";
    case "CANCELED":
    case "CANCELLED": return "canceled";
    case "REJECTED": return "rejected";
    case "EXPIRED": return "expired";
    default: return "unknown";
  }
}

function mapCoinbaseStatus(status: string): OrderState {
  switch (status.toUpperCase()) {
    case "OPEN": return "new";
    case "PENDING": return "pending";
    case "FILLED": return "filled";
    case "CANCELLED":
    case "CANCELED": return "canceled";
    case "EXPIRED": return "expired";
    case "FAILED": return "rejected";
    default: return "unknown";
  }
}

export const reconciliationService = new ReconciliationService();
