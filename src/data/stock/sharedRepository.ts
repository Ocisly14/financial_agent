import * as alpaca from "./alpacaClient.ts";
import { createBarRepository, type BarRepository } from "./barRepository.ts";
import { SqliteBarStore } from "./barStore.ts";

let sharedRepository: BarRepository | undefined;
let repositoryFailed = false;

/**
 * Process-wide shared stock bar repository (daily, 5-minute, and 1-minute bars).
 *
 * The `get_stock_price` tool and the `GET /market/stocks/:symbol` endpoint both need to read the
 * same SQLite file. Each opening it separately would open two WAL connections to the same file
 * within the same process, so the handle is held centrally here instead.
 *
 * Opens lazily; returns undefined on failure, leaving each caller to degrade as it sees fit.
 */
export async function getSharedBarRepository(): Promise<BarRepository | undefined> {
  if (sharedRepository) return sharedRepository;
  if (repositoryFailed) return undefined;
  try {
    const path = process.env["STOCK_DB_PATH"] ?? "data/stock.db";
    const store = SqliteBarStore.open(path);
    sharedRepository = createBarRepository({ store, client: { fetchBars: alpaca.fetchBars } });
    return sharedRepository;
  } catch {
    repositoryFailed = true;
    return undefined;
  }
}

/** Test-only: clears the cached handle and the failure flag. */
export function resetSharedBarRepository(): void {
  sharedRepository = undefined;
  repositoryFailed = false;
}
