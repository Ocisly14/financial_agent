import * as alpaca from "./alpacaClient.ts";
import { createBarRepository, type BarRepository } from "./barRepository.ts";
import { SqliteBarStore } from "./barStore.ts";

/**
 * How many times an open may fail before the store is written off for the life of
 * the process. Opening can fail for reasons that pass — the data directory not yet
 * mounted at boot, a lock held by a migration — and latching on the first one would
 * push every caller onto the network for hours. Three attempts is enough to ride out
 * a transient failure without hammering a genuinely broken path on every tool call.
 */
const MAX_OPEN_ATTEMPTS = 3;

let sharedRepository: BarRepository | undefined;
let failedOpens = 0;

/**
 * Process-wide shared stock bar repository (daily, 5-minute, and 1-minute bars).
 *
 * The `get_stock_price` tool and the `GET /market/stocks/:symbol` endpoint both need to read the
 * same SQLite file. Each opening it separately would open two WAL connections to the same file
 * within the same process, so the handle is held centrally here instead.
 *
 * Opens lazily and retries a failed open up to `MAX_OPEN_ATTEMPTS` times across calls;
 * returns undefined once it gives up, leaving each caller to degrade as it sees fit.
 */
export async function getSharedBarRepository(): Promise<BarRepository | undefined> {
  if (sharedRepository) return sharedRepository;
  if (failedOpens >= MAX_OPEN_ATTEMPTS) return undefined;
  try {
    const path = process.env["STOCK_DB_PATH"] ?? "data/stock.db";
    const store = SqliteBarStore.open(path);
    sharedRepository = createBarRepository({ store, client: { fetchBars: alpaca.fetchBars } });
    failedOpens = 0;
    return sharedRepository;
  } catch {
    failedOpens += 1;
    return undefined;
  }
}

/** Test-only: clears the cached handle and the failure count. */
export function resetSharedBarRepository(): void {
  sharedRepository = undefined;
  failedOpens = 0;
}
