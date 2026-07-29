# Data layer

`src/data/` owns external data access, caching, persistence, and domain-level data assembly.
Adapters such as MCP tools and HTTP routes should import the public API exposed by each
domain's `index.ts` instead of talking to providers or databases directly.

## Stock data

`src/data/stock/` contains the full Alpaca stock-data path:

- `alpacaClient.ts`: authenticated Alpaca HTTP requests and snapshot TTL cache.
- `barStore.ts`: SQLite persistence.
- `barRepository.ts`: backfill, incremental refresh, and corporate-action detection.
- `sharedRepository.ts`: process-wide repository lifecycle.
- `stockPriceData.ts`: quote/history/intraday orchestration for `get_stock_price`.
- `stockChartData.ts`: chart-range assembly shared by the HTTP endpoint.
- `index.ts`: the only import surface intended for adapters.

Runtime SQLite files remain at the project-root `data/stock.db*` by default and are ignored by Git.
