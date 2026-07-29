/**
 * `<StockChart />` 的纯逻辑。
 *
 * 这个文件刻意不 import React、不用 JSX、不走 `@/` 路径别名——仓库的客户端
 * 没有测试运行器，把纯函数留在这里，根目录的 `node --test` 才能直接覆盖它们
 * （见 client/src/lib/__tests__/stockChart.test.ts）。
 */

/** 与后端 marketHours.ts 的 MarketSession 同构，刻意重复声明而非跨 client/server 边界 import。 */
export type MarketSession = "pre-market" | "regular" | "after-hours" | "closed";

/** 与后端 stockMarketRoutes.ts 的 SYMBOL_RE 同规则，各自实现。 */
const SYMBOL_RE = /^[A-Z][A-Z.-]{0,5}$/;

export const STOCK_RANGES = ["1D", "5D", "1M", "3M", "1Y"] as const;
export type StockRange = (typeof STOCK_RANGES)[number];
export const DEFAULT_STOCK_RANGE: StockRange = "1D";

export type StockChartProps = { symbol: string; range: StockRange };
export type StockChartPropsError = { error: string };

/**
 * symbol 会被拼进请求 URL，而它来自模型生成的文本——这是本组件唯一的新风险面。
 * 不合法就不发请求。
 */
export function parseStockChartProps(input: {
  symbol?: unknown;
  range?: unknown;
}): StockChartProps | StockChartPropsError {
  const raw = typeof input.symbol === "string" ? input.symbol : "";
  const symbol = raw.trim().toUpperCase();
  if (!SYMBOL_RE.test(symbol)) return { error: raw };

  return { symbol, range: parseRange(input.range) };
}

function parseRange(raw: unknown): StockRange {
  return typeof raw === "string" && (STOCK_RANGES as readonly string[]).includes(raw)
    ? (raw as StockRange)
    : DEFAULT_STOCK_RANGE;
}

export function shouldPollCandles(range: StockRange): boolean {
  return range === "1D" || range === "5D";
}

/**
 * 轮询间隔。判定逻辑只存在于后端 marketHours.ts 一处，这里只做映射。
 *
 * 5 秒与 alpacaClient.ts 的 snapshot 缓存 TTL 相等——轮询快过缓存拿不到更新的数据。
 */
export function pollIntervalForSession(session: MarketSession): number | false {
  switch (session) {
    case "regular":
      return 5_000;
    case "pre-market":
    case "after-hours":
      return 30_000;
    case "closed":
      return false;
  }
}

/**
 * 砍掉末尾未闭合的 `<...` 片段。
 *
 * 流式渲染时正文逐 token 增长，`<StockChart symb` 这类中间态会被 markdown-to-jsx
 * 转义成字面文本渲染出来（实测：它不会吞掉后续正文，只是把 `<` 转义为 `&lt;`）。
 * 用户因此会看到半截原始标记一闪而过，这里把它藏掉。
 *
 * 已知取舍：正文里的 `a < b` 若恰好在末尾也会被砍掉。可接受——下一个 token
 * 就会把它补回来，且只影响流式预览态，定稿的消息不走这个函数。
 */
export function stripIncompleteTrailingTag(text: string): string {
  return text.replace(/<[^>]*$/, "");
}
