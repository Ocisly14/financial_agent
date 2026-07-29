import * as alpaca from "./alpacaClient.ts";
import { createBarRepository, type BarRepository } from "./barRepository.ts";
import { SqliteBarStore } from "./barStore.ts";

let sharedRepository: BarRepository | undefined;
let repositoryFailed = false;

/**
 * 进程内共享的股票 K 线仓库（日线、5 分钟线和 1 分钟线）。
 *
 * `get_stock_price` 工具与 `GET /market/stocks/:symbol` 端点都要读同一个
 * SQLite 文件。各自 open 一次会在同一进程里开出两个 WAL 连接指向同一文件，
 * 所以句柄在这里集中持有。
 *
 * 惰性打开；失败时返回 undefined，由各调用方按自己的能力降级。
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

/** 仅供测试：清掉缓存的句柄与失败标记。 */
export function resetSharedBarRepository(): void {
  sharedRepository = undefined;
  repositoryFailed = false;
}
