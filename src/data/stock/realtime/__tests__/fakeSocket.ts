import type { StreamSocket } from "../streamClient.ts";

/** A StreamSocket whose lifecycle events are driven by the test rather than by a network. */
export class FakeSocket implements StreamSocket {
  readonly url: string;
  readonly sent: string[] = [];
  closed = false;
  private readonly handlers = new Map<string, ((event: unknown) => void)[]>();

  constructor(url: string) {
    this.url = url;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  addEventListener(type: string, handler: (event: unknown) => void): void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
  }

  private emit(type: string, event: unknown): void {
    for (const handler of this.handlers.get(type) ?? []) handler(event);
  }

  open(): void {
    this.emit("open", {});
  }

  /** Alpaca frames arrive as arrays of message objects. */
  message(payload: unknown[]): void {
    this.emit("message", { data: JSON.stringify(payload) });
  }

  remoteClose(): void {
    this.closed = true;
    this.emit("close", {});
  }

  /** JSON frames sent so far, oldest first. */
  frames(): Record<string, unknown>[] {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }

  lastFrame(): Record<string, unknown> | undefined {
    return this.frames().at(-1);
  }
}

/** Collects sockets as the client creates them, so a test can drive each reconnect. */
export function socketFactory(): { create: (url: string) => StreamSocket; sockets: FakeSocket[] } {
  const sockets: FakeSocket[] = [];
  return {
    create: (url: string) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    sockets,
  };
}

/** A schedule() that never fires on its own; the test decides when time passes. */
export function manualClock(): {
  schedule: (fn: () => void, delayMs: number) => () => void;
  pending: { fn: () => void; delayMs: number }[];
  runNext: () => number;
} {
  const pending: { fn: () => void; delayMs: number }[] = [];
  return {
    pending,
    schedule: (fn, delayMs) => {
      const entry = { fn, delayMs };
      pending.push(entry);
      return () => {
        const index = pending.indexOf(entry);
        if (index >= 0) pending.splice(index, 1);
      };
    },
    /** Fires the oldest pending timer and returns the delay it was scheduled with. */
    runNext: () => {
      const entry = pending.shift();
      if (!entry) throw new Error("no pending timer");
      entry.fn();
      return entry.delayMs;
    },
  };
}
