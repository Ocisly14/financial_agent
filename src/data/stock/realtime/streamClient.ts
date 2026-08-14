/**
 * Alpaca realtime quote stream: one connection, and everything needed to keep it up.
 *
 * The socket, the timer and the jitter source are all injected. That is what lets the reconnect
 * ladder, the connection-limit path and the auth-failure path be tested deterministically instead
 * of by waiting on a real network.
 *
 * Two failure modes get their own handling because they behave nothing like a dropped connection:
 *
 *  - **connection limit (406)** — the free plan allows a single concurrent connection, so a
 *    `npm run dev` restart reliably produces one of these while the old process is still holding
 *    the socket. Retrying on the normal 1-second ladder just races the old connection; backing
 *    off hard lets it drain.
 *  - **auth failure (401/402)** — retrying cannot fix a wrong key. The client goes `down` and
 *    stays there, leaving every caller on the REST path.
 */

const STREAM_BASE = "wss://stream.data.alpaca.markets/v2";
const CONNECTION_LIMIT_CODE = 406;
const AUTH_FAILURE_CODES = new Set([401, 402]);

export interface StreamSocket {
  send(data: string): void;
  close(): void;
  addEventListener(type: string, handler: (event: unknown) => void): void;
}

export type StreamState = "idle" | "connecting" | "connected" | "reconnecting" | "degraded" | "down";

export interface StreamQuote {
  bid: number;
  ask: number;
  ts: number;
}

export interface StreamClientOptions {
  feed: string;
  credentials: { key: string; secret: string };
  createSocket: (url: string) => StreamSocket;
  schedule: (fn: () => void, delayMs: number) => () => void;
  onQuote: (symbol: string, quote: StreamQuote) => void;
  onStateChange?: (state: StreamState) => void;
  jitter?: (() => number) | undefined;
  backoffBaseMs?: number | undefined;
  backoffMaxMs?: number | undefined;
  degradeAfterAttempts?: number | undefined;
  connectionLimitBackoffMs?: number | undefined;
}

export interface StreamClient {
  connect(): void;
  subscribe(symbols: readonly string[]): void;
  unsubscribe(symbols: readonly string[]): void;
  close(): void;
  state(): StreamState;
}

export const DEFAULT_BACKOFF_BASE_MS = 1_000;
export const DEFAULT_BACKOFF_MAX_MS = 30_000;
export const DEFAULT_DEGRADE_AFTER_ATTEMPTS = 3;
export const DEFAULT_CONNECTION_LIMIT_BACKOFF_MS = 30_000;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function createStreamClient(options: StreamClientOptions): StreamClient {
  const {
    feed,
    credentials,
    createSocket,
    schedule,
    onQuote,
    onStateChange,
    jitter = () => Math.random(),
    backoffBaseMs = DEFAULT_BACKOFF_BASE_MS,
    backoffMaxMs = DEFAULT_BACKOFF_MAX_MS,
    degradeAfterAttempts = DEFAULT_DEGRADE_AFTER_ATTEMPTS,
    connectionLimitBackoffMs = DEFAULT_CONNECTION_LIMIT_BACKOFF_MS,
  } = options;

  const desired = new Set<string>();
  let socket: StreamSocket | undefined;
  let state: StreamState = "idle";
  let authenticated = false;
  let attempts = 0;
  let stopped = false;
  let fatal = false;
  let connectionLimited = false;
  let cancelPending: (() => void) | undefined;

  const setState = (next: StreamState): void => {
    if (state === next) return;
    state = next;
    onStateChange?.(next);
  };

  const send = (frame: Record<string, unknown>): void => {
    socket?.send(JSON.stringify(frame));
  };

  const backoffDelay = (): number => {
    if (connectionLimited) return connectionLimitBackoffMs;
    const raw = backoffBaseMs * 2 ** Math.max(0, attempts - 1);
    const capped = Math.min(raw, backoffMaxMs);
    // Jitter only ever shortens, so the cap stays a real cap.
    return Math.round(capped * (1 - 0.1 * jitter()));
  };

  const handleMessage = (event: unknown): void => {
    const data = asRecord(event)?.["data"];
    if (typeof data !== "string") return;
    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      return;
    }
    for (const raw of Array.isArray(payload) ? payload : [payload]) {
      const message = asRecord(raw);
      if (!message) continue;
      const type = message["T"];

      if (type === "q") {
        const symbol = message["S"];
        const bid = message["bp"];
        const ask = message["ap"];
        const ts = message["t"];
        if (typeof symbol !== "string" || typeof bid !== "number" || typeof ask !== "number") continue;
        onQuote(symbol, { bid, ask, ts: typeof ts === "string" ? Date.parse(ts) : Date.now() });
        continue;
      }

      if (type === "success" && message["msg"] === "authenticated") {
        authenticated = true;
        attempts = 0;
        connectionLimited = false;
        setState("connected");
        if (desired.size > 0) send({ action: "subscribe", quotes: [...desired] });
        continue;
      }

      if (type === "error") {
        const code = message["code"];
        if (code === CONNECTION_LIMIT_CODE) connectionLimited = true;
        else if (typeof code === "number" && AUTH_FAILURE_CODES.has(code)) fatal = true;
        console.warn(`[realtime] stream error ${String(code)}: ${String(message["msg"])}`);
      }
    }
  };

  const openSocket = (): void => {
    if (stopped || fatal) return;
    setState(state === "idle" ? "connecting" : state);
    authenticated = false;
    const next = createSocket(`${STREAM_BASE}/${feed}`);
    socket = next;
    next.addEventListener("open", () => {
      send({ action: "auth", key: credentials.key, secret: credentials.secret });
    });
    next.addEventListener("message", handleMessage);
    next.addEventListener("close", () => {
      if (next !== socket) return;
      handleDisconnect();
    });
    next.addEventListener("error", () => {
      /* a failed socket always follows with close; nothing to do here */
    });
  };

  const handleDisconnect = (): void => {
    authenticated = false;
    socket = undefined;
    if (stopped) return;
    if (fatal) {
      setState("down");
      return;
    }
    attempts += 1;
    setState(attempts >= degradeAfterAttempts ? "degraded" : "reconnecting");
    cancelPending = schedule(openSocket, backoffDelay());
  };

  return {
    connect() {
      if (stopped || socket) return;
      openSocket();
    },

    subscribe(symbols) {
      const added = symbols.filter((symbol) => !desired.has(symbol));
      for (const symbol of symbols) desired.add(symbol);
      if (authenticated && added.length > 0) send({ action: "subscribe", quotes: added });
    },

    unsubscribe(symbols) {
      const removed = symbols.filter((symbol) => desired.delete(symbol));
      if (authenticated && removed.length > 0) send({ action: "unsubscribe", quotes: removed });
    },

    close() {
      stopped = true;
      cancelPending?.();
      cancelPending = undefined;
      socket?.close();
      socket = undefined;
      setState("down");
    },

    state() {
      return state;
    },
  };
}
