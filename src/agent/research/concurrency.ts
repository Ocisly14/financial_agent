// Concurrency / timeout primitives for the Research layer.
//
// These live HERE and only here: the guards of
// docs/superpowers/specs/2026-07-30-research-layer-design.md §4.4 (recursion
// depth 1, at most 3 concurrent drives, 6-minute per-call timeout) are a
// property of the Research controller, not of the Topic agent it drives. The
// existing framework must stay unaware that anything but a human is on the
// other end, so nothing in here is ever pushed down into it.

/** Raised by `withTimeout` when the wrapped promise misses its deadline. */
export class TimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number, label: string) {
    super(`${label} timed out after ${timeoutMs}ms`);
    this.name = "TimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Resolves with `promise`, or rejects with a TimeoutError after `timeoutMs`.
 *
 * The underlying work is NOT cancelled — there is no cancellation channel into
 * an orchestrator run, and inventing one would mean changing the framework.
 * A late finisher simply keeps writing to its own Topic session, which is the
 * correct outcome: the Topic's timeline stays truthful even though this
 * Research turn stopped waiting. The straggler's rejection is swallowed here
 * so it cannot surface as an unhandled rejection.
 */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(timeoutMs, label)), timeoutMs);
  });
  promise.catch(() => {}); // a straggler that fails after the deadline is not an unhandled rejection
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

/** A counting semaphore. `acquire()` resolves with the release function. */
export class Semaphore {
  private readonly limit: number;
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(limit: number) {
    if (limit < 1) throw new Error(`semaphore limit must be >= 1, got ${limit}`);
    this.limit = limit;
  }

  get inFlight(): number {
    return this.active;
  }

  async acquire(): Promise<() => void> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.waiting.shift()?.();
    };
  }
}

/**
 * Maps `items` through `fn` with at most `limit` in flight, preserving the
 * order of results. A rejection propagates; callers that must not abort the
 * batch should catch inside `fn`.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!, index);
    }
  };
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}
