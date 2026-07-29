---
title: 美股实时行情与本地历史库(get_stock_price) — 设计 spec
date: 2026-07-28
status: spec
---

**Status:** Implemented (2026-07-28)
**Date:** 2026-07-28
**Author:** victor530914@gmail.com (with Claude)
**Scope:** 新增 `mcp_tools/stock/` 目录与 `get_stock_price` 工具;新增 SQLite 表 `stock_bars` / `stock_bar_coverage`;在 `registerAllTools` 与 `ONCHAIN_DATA_TOOLS` 中注册。不改 orchestrator / dispatcher / subagent 协议,不改现有任何工具。

---

## 1. 背景与目标

现有市场数据工具只覆盖加密货币(`get_crypto_price`,数据源 CoinMarketCap)。需要一个等价的美股工具,让 agent 能回答"AAPL 现在多少钱""过去三个月走势如何"这类问题。

两个约束驱动了整个设计:

1. **历史数据不应反复通过 API 拉取。** 日 K 是不可变、有界的数据,每次调用都重新请求既慢又浪费额度。它应当落地到本地数据库,只做增量更新。
2. **实时报价无法本地化。** 它是持续变化的当前状态,本地库里的值只有在有进程持续写入时才新鲜。若为此引入常驻 updater,代价是只能覆盖预设的 symbol 白名单(美股有 5000+ 标的),且新鲜度受限于轮询间隔。

因此采用**混合方案**:历史落库 + 实时按需拉取。这精确消除了重复拉取历史的浪费,又不牺牲标的覆盖面和实时性。

### 非目标

- 不做 WebSocket 推送。MCP 工具是请求-响应的,agent 每轮只需要一个快照,常驻连接拿不到推送流的好处,反而引入冷启动无数据的问题。
- 不做常驻后台 updater / 定时任务。更新由使用自然驱动(见 §4)。
- 不覆盖 A 股、港股。这些市场需要完全不同的数据源,应另立 spec。
- 不做分钟线的历史持久化(见 §5)。

---

## 2. 数据源选型

**Alpaca Market Data API 免费档。**

| | Alpaca | Finnhub | Alpha Vantage |
|---|---|---|---|
| 免费实时 | IEX,无日调用上限 | IEX,60 次/分 | 仅 15 分钟延迟 |
| 盘前盘后 | 免费档支持 | 任何档位都不支持 | 不支持 |
| WebSocket | 免费 | 免费,限 50 symbol | 无 |
| 信用卡 | 不需要 | 不需要 | 不需要 |

选择理由:免费档无日调用上限,且是唯一在免费档提供盘前盘后报价的——用户很可能在非交易时段提问,缺少盘前盘后数据会让模型基于上一个收盘价给出过时结论。

**已知限制(需在工具输出中如实标注):** 免费档的实时数据源自 IEX 单一交易所,并非官方 SIP 合并行情。对 LLM 分析场景足够,但不构成交易决策依据。完整 SIP 行情需付费档。

**认证:** 两个环境变量 `ALPACA_API_KEY_ID`、`ALPACA_API_SECRET_KEY`,经 `mcp_tools/config.ts` 的 `env()` 读取(缺失即抛错,与现有工具一致)。请求头 `APCA-API-KEY-ID` / `APCA-API-SECRET-KEY`,base URL `https://data.alpaca.markets/v2`。

---

## 3. 分层架构

沿用 `mcp_tools/market/` 已有的 client + tool + prompts 三件套模式,新增一个 store/repository 层:

```
getStockPriceTool.ts        工具定义,组装 summary + generation_context
        │
        ├──────────────► alpacaClient.ts     纯 HTTP,不碰数据库
        │                  fetchSnapshot(symbol)
        │                  fetchDailyBars(symbol, from, to)
        │                  fetchIntradayBars(symbol)
        │
        └──────────────► barRepository.ts    编排:读库 → 判缺口 → 补拉 → 回写
                                │
                                └──► barStore.ts    纯 SQLite 读写,不碰网络
```

每层的边界是硬约束:`alpacaClient` 不知道数据库存在,`barStore` 不知道网络存在,缺口判断与补拉决策**只存在于 `barRepository`**。这让 repository 可以注入假 client 做完整单测(见 §8)。

---

## 4. 数据模型与增量更新

存储选型为 **SQLite**(Node 内置 `node:sqlite`)。日 K 是单机、只增不改、按 `(symbol, 日期)` 主键查询的表格数据,嵌入式库正好匹配:无需部署服务、无需连接管理、零依赖,库就是一个文件。

### 表 `stock_bars`

一根日 K 一行,`(symbol, t)` 复合主键天然去重,`ON CONFLICT DO UPDATE` 实现 upsert:

```sql
CREATE TABLE stock_bars (
  symbol TEXT NOT NULL,
  t      TEXT NOT NULL,   -- 交易日 "2026-07-27"
  o REAL NOT NULL, h REAL NOT NULL, l REAL NOT NULL, c REAL NOT NULL,
  v  REAL NOT NULL,       -- 成交量
  vw REAL NOT NULL,       -- 成交量加权均价
  updated_at TEXT NOT NULL,
  PRIMARY KEY (symbol, t)
);
```

主键即索引,`WHERE symbol = ? ORDER BY t DESC LIMIT ?` 直接走主键的有序扫描,无需额外建索引。

### 表 `stock_bar_coverage`

每个 symbol 一行,记录本地库已覆盖的区间:

```sql
CREATE TABLE stock_bar_coverage (
  symbol          TEXT PRIMARY KEY,
  first_date      TEXT NOT NULL,
  last_date       TEXT NOT NULL,
  backfilled_at   TEXT NOT NULL,
  last_checked_at TEXT NOT NULL
);
```

回补的批量写入包在单个事务里——5 年约 1260 根 bar 只产生一次 fsync,而非 1260 次。

### 读时增量(read-through),不需要调度器

工具被调用时,`barRepository.getDailyBars(symbol, days)` 的流程:

1. 读 `coverage`。**无记录** → 首次遇到该 symbol,全量回补默认 5 年日 K,写入两个集合,返回。
2. 有记录且 `lastDate` 已是最近一个交易日 → **零 API 调用**,直接返回库数据。
3. 有记录但落后 → 只请求 `lastDate` 之后的区间,upsert 后返回。

"最近一个交易日"的判定不维护交易日历:直接以 Alpaca 返回的最新 bar 日期为准。若请求区间内无新 bar(周末、假日),说明库已是最新,更新 `lastCheckedAt` 即可。这避免了自行维护美股节假日表这一长期负担。

由使用驱动更新,不需要 cron 或常驻进程;冷门标的不会被无谓地轮询。

### 复权正确性

日 K 一律以 `adjustment=all` 请求,库中**只存复权后价**。这样均线、收益率等指标可直接计算。

代价是拆股会让该标的的全部历史值失效。检测机制:**每次增量拉取时多取 5 根重叠 bar,与库中已有值比对。** 一致则正常追加;若收盘价偏差超过 0.01% 的相对阈值,即判定发生了拆股或分红,触发该 symbol 的全量重拉并覆盖历史。

这是用一次极小的额外开销(每次增量多 5 根 bar)换取"库中历史永远处于当前复权口径",避免拆股后数据静默出错。

---

## 5. 三类数据的不同落地方式

| 数据 | 落地方式 | 理由 |
|---|---|---|
| 历史日 K | 持久化到 SQLite,增量更新 | 不可变、有界,重复拉取纯属浪费 |
| 实时报价 / 盘前盘后 | 每次调 snapshot 端点,10 秒 TTL 进程内缓存 | 持续变化的当前状态,天然不可落库 |
| 日内分时 1Min | 现拉不落库 | 只在当天有意义、盘中持续变化、数据量是日 K 的 390 倍,落库收益远小于成本 |

snapshot 端点 `/v2/stocks/{symbol}/snapshot` 一次返回 latestTrade、latestQuote、minuteBar、dailyBar、prevDailyBar,盘前盘后时段的报价包含在 latestQuote 中。10 秒 TTL 缓存用一个模块级 `Map<symbol, {data, expiresAt}>` 实现,避免同一轮对话中多次调用重复打网络。

---

## 6. 工具接口

```ts
name: "get_stock_price"
category: "non_trading"
inputSchema: {
  symbol: string;            // 必填,股票代码,如 AAPL
  task?: string;             // 自然语言请求,透传给报告提示词作上下文
  historyDays?: number;      // 返回多少个交易日的日 K,默认 60
  includeIntraday?: boolean; // 是否附带当日分钟线,默认 false
}
```

**`symbol` 由调用方 agent 给出,工具内不做 ticker 推断。** agent 读得到完整对话,判断用户指的是哪支票远比工具内部的正则可靠;工具侧的启发式(大写词匹配 + 停用词表)必然会把 "US"、"CEO"、"AI" 这类词误判成股票代码。工具的 description 与 `symbol` 字段说明中明确要求调用前先确定标的。

缺少 `symbol` 时返回 `error: "symbol_required"` 的错误上下文,提示 agent 补齐参数后重新调用,**不猜测默认标的**——`get_crypto_price` 默认回退 BTC 是因为加密场景下 BTC 是合理基准,美股没有等价物,猜错会让模型分析完全错误的公司。

返回结构与现有工具同构:

```ts
{
  summary: "AAPL $213.45 | 日内 +1.2% | 成交量 52.3M | 数据截至 2026-07-28 15:42 ET",
  generation_context: {
    prompt: <报告提示词>,
    data: {
      symbol, price, bidPrice, askPrice, dayOpen, dayHigh, dayLow, prevClose,
      changePercent, volume, marketStatus, quoteTimestamp,
      dailyBars: [...],        // historyDays 根
      intradayBars?: [...],    // includeIntraday 为 true 时
      dataSource: "Alpaca (IEX feed)",
      staleness?: string,      // 降级时说明数据截止时间
    }
  }
}
```

---

## 7. 错误处理与降级

| 情况 | 行为 |
|---|---|
| snapshot 请求失败,但库中有日 K | 返回库数据,`data.staleness` 标注"实时报价不可用,最新收盘数据截至 YYYY-MM-DD",summary 明示 |
| snapshot 与库都无数据 | 返回错误上下文,prompt 为"No market data available for {symbol}",与 `get_crypto_price` 的 catch 分支同构 |
| symbol 无效 / Alpaca 返回 404 | summary 说明该代码不存在,不写入 coverage(避免把无效 symbol 固化进库) |
| SQLite 打不开(磁盘只读等) | 退化为纯 API 模式:直接拉取日 K 返回,不落库。工具可用性不应被存储故障连坐 |
| 增量拉取失败但库中数据够用 | 返回库数据,标注 staleness,不抛错 |

所有失败路径都返回结构化的 `generation_context` 而非抛异常,与现有工具协议一致——subagent 需要拿到可解释的上下文,而不是一个 crash。

---

## 8. 测试

对 `barRepository` 注入假 `alpacaClient` 与内存 `barStore`,不打真实网络:

1. **首次回补** — 空库 + 请求 AAPL → 触发全量回补,写入正确的 coverage 区间。
2. **零调用路径** — 库中 `lastDate` 已是最新 → 假 client 的调用计数为 0。
3. **缺口增量** — 库落后 3 个交易日 → 只请求缺失区间,不重拉历史。
4. **周末/假日** — 请求区间内无新 bar → 不报错,仅更新 `lastCheckedAt`。
5. **拆股检测** — 假 client 在重叠区返回偏差超阈值的价格 → 触发全量重拉,库中旧值被覆盖。
6. **重叠一致** — 重叠区价格一致 → 不触发重拉。

`alpacaClient` 的 snapshot 缓存另做小单测(TTL 内命中缓存、TTL 外重新请求、不同 key 独立、loader 抛错不缓存)。

`SqliteBarStore` 用 `:memory:` 建库直接测真实实现——这是选 SQLite 相对外部数据库服务的一个附带收益:存储层不必依赖测试替身。覆盖 upsert 去重、升序返回、`clearSymbol` 不误删其他 symbol、以及 1260 根的批量写入规模。

`marketSession` 作为纯函数单测夏令时/冬令时、周末与各时段边界。

---

## 9. 注册与配置

- `registerAllTools()` 中注册 `createGetStockPriceTool()`。
- 加入 `ONCHAIN_DATA_TOOLS` 常量数组——该列表是喂给 `onchain_data` 这个市场数据 subagent 的工具集。
- `.env.example` 新增一段:

```
# --------------------------------
# Alpaca — US stock market data
# --------------------------------
ALPACA_API_KEY_ID=
ALPACA_API_SECRET_KEY=
```

- SQLite 库文件路径取 `STOCK_DB_PATH`(默认 `data/stock.db`,该目录已在 `.gitignore` 中)。使用 Node 内置的 `node:sqlite`,无需新增依赖,但要求启动参数带 `--experimental-sqlite`——`package.json` 的全部 node 脚本已加上该标志。

---

## 10. 实施顺序

1. `alpacaClient.ts` + 其单测(HTTP 形状、认证头、缓存 TTL)。
2. `barStore.ts` + 索引创建。
3. `barRepository.ts` + §8 的六个单测。这是风险最集中的一层,先测透。
4. `getStockPriceTool.ts` + `prompts.ts`。
5. 注册、`.env.example`、端到端手工验证(交易时段与非交易时段各跑一次)。
