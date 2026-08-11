# 板块趋势分析工具实施计划

**Goal:** 新增 `get_sector_analysis` MCP 工具，复用现有股票 SQLite bar repository，分析美股 11 个 GICS 板块 ETF 相对 SPY 的趋势、强弱、加速度与风险，并向模型返回可解释、可核验的排名数据。

**Architecture:** 工具层只负责输入校验、读取本地 repository 和组织响应；所有金融计算放在无 I/O 的纯函数模块中。生产路径必须先经过 `getSharedBarRepository()`：repository 用 SQLite 中已有数据回答，并按现有 freshness/coverage 规则增量更新；不另建数据库，也不绕过 repository 直接请求 Alpaca。算法使用价格型板块代理，不把新闻、宏观判断或成分股广度混入评分。

**Tech Stack:** TypeScript、Node 23 `node:sqlite`、现有 `BarRepository`、`node:test` + `node:assert/strict`。

## 1. 已确认的产品边界

### 1.1 默认板块池

固定使用覆盖 S&P 500 十一个 GICS 板块的 Select Sector SPDR ETF：

| 板块 | 代理代码 |
|---|---|
| Communication Services | XLC |
| Consumer Discretionary | XLY |
| Consumer Staples | XLP |
| Energy | XLE |
| Financials | XLF |
| Health Care | XLV |
| Industrials | XLI |
| Materials | XLB |
| Real Estate | XLRE |
| Technology | XLK |
| Utilities | XLU |

相对强度基准固定为 `SPY`。第一版不接受任意 ticker，以免“板块分析”退化成没有一致口径的 ETF 比较器。可选输入 `sector_symbols` 只能是上述代码的子集；省略时分析全部板块，也允许只传一个板块做单板块趋势分析。

### 1.2 工具语义

- 工具名：`get_sector_analysis`。
- 分析频率：日线。
- 默认调用读取 12 个代码：`SPY + 11 个板块 ETF`。SPY 只作为基准，不进入板块排名，因此正常输出是 11 个板块。
- 单板块调用读取 2 个代码：`SPY + 指定板块 ETF`；返回完整的绝对趋势和相对 SPY 指标，但不制造横截面 rank/score。
- 默认分析 260 个交易日，并向 repository 请求 261 根 bar；最少也按这个窗口读取，保证计算 252 日收益所需的起点、SMA200 和回归窗口都有足够数据。
- 返回的是横截面强弱和趋势状态，不是预测价格，也不是买卖建议。
- 数据源沿用当前项目的 Alpaca IEX adjusted bars。价格趋势可用，但 IEX 成交量不是全市场成交量；第一版因此不把 volume 放进评分。
- ETF 是指数代理，不等于指数点位；输出必须明确这一点。

## 2. 算法选择

研究基础：

- Moskowitz 与 Grinblatt 记录了显著的行业动量效应，支持做板块横截面排序：[Do Industries Explain Momentum?](https://doi.org/10.1111/0022-1082.00146)
- Moskowitz、Ooi 与 Pedersen 的时间序列动量研究支持用标的自身过去收益判断趋势方向：[Time Series Momentum](https://pages.stern.nyu.edu/~lpederse/papers/TimeSeriesMomentum.pdf)
- Faber 的战术配置研究支持用简单长期均线作为绝对趋势过滤器：[A Quantitative Approach to Tactical Asset Allocation](https://ssrn.com/abstract=962461)
- 后续研究也指出单独依赖时间序列动量的统计证据可能较弱，因此本工具不使用单一动量指标：[Time Series Momentum: Is It There?](https://doi.org/10.1016/j.jfineco.2019.08.004)

由此采用一个可解释的组合，而不是 RSI/MACD 投票或机器学习预测。

### 2.1 日期对齐

每个板块只保留与 SPY 同日存在的收盘价，不向前填充、不插值。所有相对指标都基于：

```text
relative_price[t] = sector_close[t] / SPY_close[t]
```

个别板块缺少某交易日时，该日不参加该板块的相对计算，但不要求所有 11 个板块共享一个全局交集，避免一个缺口缩短整个板块池。

### 2.2 原始指标

每个板块计算：

1. **绝对动量**
   - 20、60、120、252 日总收益率。
   - 用于判断板块自身在上涨还是下跌。

2. **相对强度**
   - `sector / SPY` 比率的 20、60、120、252 日收益率。
   - 正值表示该期限跑赢 SPY，负值表示跑输。

3. **绝对趋势结构**
   - `close > SMA50 > SMA200` 且 60 日收益为正：`bullish`。
   - `close < SMA50 < SMA200` 且 60 日收益为负：`bearish`。
   - 其余：`mixed`。
   - 同时返回距离 SMA50、SMA200 的百分比，模型不能只看到标签。

4. **相对趋势质量**
   - 对最近 60 个交易日的 `log(sector / SPY)` 做普通最小二乘回归。
   - 返回年化斜率和 `R²`。
   - 排名因子使用 `annualized_relative_slope × R²`：相同斜率下，路径更稳定的趋势得分更高。

5. **相对加速度**
   - 最近 20 日相对收益减去此前 20 日相对收益。
   - 用于区分仍在加强与已经减速的领先板块。

6. **风险**
   - 最近 60 日收盘收益率年化波动率。
   - 最近 120 日最大回撤幅度。
   - 风险只做温和惩罚，不能压过相对强度主因子。

### 2.3 横截面评分

先在本次成功返回的板块之间，把每个因子转换为 0–100 percentile rank；并列值取平均 rank。这样不同量纲可以组合，也不会让一个极端收益值支配全体。

```text
strength_score =
  40% × multi_horizon_relative_momentum_rank
  25% × multi_horizon_absolute_momentum_rank
  20% × relative_trend_quality_rank
  10% × relative_acceleration_rank
   5% × risk_quality_rank
```

其中：

```text
multi_horizon_momentum =
  25% × return_20d +
  35% × return_60d +
  25% × return_120d +
  15% × return_252d

risk_quality_rank = average(
  inverse_volatility_rank,
  inverse_max_drawdown_rank
)
```

`strength_score` 只表示本次板块池内的相对排名。即使所有板块都在下跌，也必然有第一名；因此输出和 prompt 必须要求同时查看 `absolute_trend` 与各期限实际收益，禁止把高分直接称为“看涨”。

### 2.4 相对阶段标签

阶段标签借用“相对强度 × 相对加速度”的四象限语义，但不声称是专有 RRG/JdK 指标：

| 60 日相对收益 | 相对加速度 | 阶段 |
|---|---|---|
| > 0 | >= 0 | `leading` |
| > 0 | < 0 | `weakening` |
| <= 0 | > 0 | `improving` |
| <= 0 | <= 0 | `lagging` |

阶段标签与 `absolute_trend` 分开返回，例如一个板块可以相对 SPY 为 `improving`，但自身仍处于 `bearish`。

## 3. 工具输入与输出契约

### 3.1 输入

```ts
{
  sector_symbols?: Array<
    "XLC" | "XLY" | "XLP" | "XLE" | "XLF" | "XLV" |
    "XLI" | "XLB" | "XLRE" | "XLK" | "XLU"
  >;
  history_days?: number; // default/min 260, max 1260
}
```

规则：

- `sector_symbols` 省略时分析全部 11 个板块。
- 传一个代码时进入 `single_sector`；传 2–10 个时进入 `selected_subset`；省略时为 `full_universe`。
- 空数组、重复代码或池外代码返回 `invalid_sector_symbols`，不静默修正。
- `history_days` 非有限数字使用默认值；有限数字截断为整数并 clamp 到 260–1260。

### 3.2 `generation_context.data`

```ts
{
  benchmark: "SPY";
  as_of: string;
  comparison_scope: "full_universe" | "selected_subset" | "single_sector";
  selected_symbols: string[];
  data_source: "Alpaca adjusted daily bars via local SQLite repository (IEX feed)";
  methodology: {
    score_is_cross_sectional: true;
    score_available: boolean; // false in single-sector mode
    horizons: [20, 60, 120, 252];
    score_weights: { relative_momentum: 0.40, absolute_momentum: 0.25, trend_quality: 0.20, acceleration: 0.10, risk_quality: 0.05 };
  };
  sectors: Array<{
    rank: number | null;
    symbol: string;
    sector: string;
    strength_score: number | null;
    relative_phase: "leading" | "weakening" | "improving" | "lagging";
    absolute_trend: "bullish" | "mixed" | "bearish";
    as_of: string;
    close: number;
    returns_pct: { d20: number | null; d60: number | null; d120: number | null; d252: number | null };
    relative_returns_pct: { d20: number | null; d60: number | null; d120: number | null; d252: number | null };
    trend: {
      sma50: number;
      sma200: number;
      distance_from_sma50_pct: number;
      distance_from_sma200_pct: number;
      relative_slope_annualized_pct: number;
      relative_r_squared: number;
      relative_acceleration_pct_points: number;
    };
    risk: { volatility_60d_annualized_pct: number; max_drawdown_120d_pct: number };
    coverage: { from: string; to: string; bars: number };
  }>;
  unavailable: Array<{ symbol: string; reason: string }>;
}
```

所有小数统一在计算边界保留完整精度，在输出边界四舍五入：价格 4 位，百分比 2 位，`R²` 4 位，score 1 位。

### 3.3 摘要的生成方式

`summary` 由工具代码根据计算结果**确定性生成**，不调用 LLM，也不只截取前三名。全板块或多板块模式的生成顺序：

1. 按 `strength_score` 降序排列所有成功计算的板块，写入 `rank`。
2. 生成头部信息：数据日期、基准、成功/缺失板块数量。
3. 为**每个板块**生成一行对比数据，列为：
   - rank、板块名、ETF、strength score；
   - relative phase、absolute trend；
   - 20/60/120/252 日绝对收益；
   - 20/60/120/252 日相对 SPY 收益；
   - 60 日年化波动率、120 日最大回撤。
4. 末尾列出所有 unavailable 板块及原因。

摘要形状示意：

```text
Sector comparison as of 2026-08-03 | benchmark SPY | 11/11 available
Rank | Sector (ETF) | Score | Phase | Abs trend | Return 20/60/120/252 | vs SPY 20/60/120/252 | Vol60 | MDD120
1 | Technology (XLK) | 91.2 | leading | bullish | ... | ... | ... | ...
2 | Financials (XLF) | 78.4 | weakening | bullish | ... | ... | ... | ...
...
11 | Utilities (XLU) | 8.7 | lagging | bearish | ... | ... | ... | ...
```

完整的均线值、距均线百分比、回归斜率、`R²`、加速度和 coverage 仍全部保留在 `generation_context.data.sectors`；summary 是完整的横向比较表，不重复所有底层诊断字段。

单板块模式没有横截面对比样本，`rank` 与 `strength_score` 返回 `null`。它的 summary 改为一份完整的单板块诊断：绝对收益、相对 SPY 收益、趋势阶段、SMA50/SMA200、相对斜率与 `R²`、加速度、波动率和最大回撤。不得把唯一标的自动赋成 rank 1 或 score 100。

### 3.4 模型生成的分析

prompt 要求模型：

- 全板块或多板块模式下，最终回答必须给出包含**所有成功返回板块**的完整排名表，每个板块恰好出现一次，不能只展示前三名；
- 单板块模式下，最终回答给出该板块相对 SPY 的完整诊断，并明确“未执行横截面排名”；
- 先说明全市场内部是普遍走强、普遍走弱，还是只有少数相对赢家；
- 对比领先、改善、减弱、落后四组，说明组间最显著的收益和风险差异；
- 对每个板块至少引用 strength score、absolute trend、一个绝对收益期限和一个相对收益期限；
- 对值得解释的板块再引用均线、回归趋势质量、加速度、波动率或回撤；
- unavailable 板块必须单列，不能从排名中静默消失；
- 不从价格算法臆测新闻催化剂；
- 不把 percentile score 当作上涨概率或买入信号；
- 明确 ETF 代理与 IEX 数据限制。

## 4. 数据流与失败语义

```text
get_sector_analysis
  -> getSharedBarRepository()
  -> repository.getBars(SPY, "1Day", historyDays + 1)
  -> 并发读取所选 sector ETF
  -> 每个板块独立与 SPY 对齐
  -> pure analyzeSectorUniverse()
  -> structured generation_context
```

- repository 不可打开：返回 `stock_database_unavailable`；不走 direct-Alpaca fallback。
- SPY 不足 201 根有效 bar：整个分析失败，返回 `insufficient_benchmark_bars`。
- 单个板块读取失败或不足 201 根：放入 `unavailable`，其余板块继续。
- 请求的板块全部不可用：返回 `insufficient_sector_data`。
- 只有一个可分析板块（主动单选，或多选但其余失败）：仍返回绝对/相对指标，同时把 `comparison_scope` 降为 `single_sector`，并令 `rank`、`strength_score` 为 `null`。
- 允许 201–259 根的已上市板块参与短中期计算，但 252 日字段为 `null`，多期限权重按可用项重新归一；默认请求 261 根，正常情况下不会发生。
- 任意非有限计算结果输出为 `null`，绝不输出 `NaN` 或 `Infinity`。

## 5. 文件清单

**新建**

- `src/data/sector/sectorAnalysis.ts` —— 板块池、纯计算、指标、排名和标签。
- `src/data/sector/index.ts` —— 对外导出。
- `mcp_tools/sector/getSectorAnalysisTool.ts` —— repository 读取、输入校验、响应和 prompt。
- `src/data/sector/__tests__/sectorAnalysis.test.ts` —— 数学正确性与边界测试。
- `mcp_tools/sector/__tests__/getSectorAnalysisTool.test.ts` —— 工具契约、数据库路径和降级测试。

**修改**

- `mcp_tools/registerTools.ts` —— 注册 `get_sector_analysis`，加入 `MARKET_DATA_TOOLS`。
- `src/agent/prompts/subagentPrompts.ts` —— 明确该工具使用固定板块池，是“每个市场数据工具必须传 symbol”规则的唯一例外。

**不修改**

- `src/data/stock/barStore.ts`、`barRepository.ts`、`sharedRepository.ts` —— 直接复用现有本地库和增量更新语义。
- `src/framework/**`、`src/agent/research/**`、客户端图表代码。
- 当前工作区内与 user input / top-down research 有关的未提交改动。

## 6. 实施任务

### Task 1：纯算法测试先行

- [x] 写构造单调上涨、单调下跌、横盘和加速序列的测试 fixture。
- [x] 验证 20/60/120/252 日绝对收益和相对收益公式。
- [x] 验证日期只按板块与 SPY 的交集对齐，缺口不插值。
- [x] 验证 SMA50/SMA200 趋势标签。
- [x] 验证 log-relative-price 回归斜率、`R²` 和常数序列处理。
- [x] 验证 acceleration 使用相邻两个 20 日窗口，没有前视。
- [x] 验证波动率和最大回撤。
- [x] 验证 percentile ties 取平均、风险方向取反、score 权重合计为 1。
- [x] 验证全体都下跌时仍有第一名，但第一名的绝对趋势保持 `bearish`。
- [x] 验证任何输出都没有 `NaN` / `Infinity`。

### Task 2：实现纯计算模块

- [x] 定义不可变的板块池与输出类型。
- [x] 实现对齐、收益率、SMA、回归、波动率、回撤纯函数。
- [x] 实现横截面 percentile 与 composite score。
- [x] 实现 `absolute_trend` 和 `relative_phase`。
- [x] 在唯一输出边界执行 rounding。

### Task 3：工具适配器测试先行

- [x] 验证默认读取 SPY + 11 个板块，timeframe 为 `1Day`，count 为 `historyDays + 1`。
- [x] 验证使用注入的 repository，且不会调用 snapshot 或 direct fetch。
- [x] 验证 subset 输入只读取选定板块。
- [x] 验证单板块输入只读取 SPY 与指定 ETF，返回完整指标，而 `rank`/`strength_score` 为 null。
- [x] 验证池外代码、空数组、重复代码的错误码。
- [x] 验证 SPY 失败为整工具失败，单板块失败进入 `unavailable`。
- [x] 验证 summary 按 rank 包含每个成功板块恰好一次，并包含绝对/相对多周期收益和风险对比列。
- [x] 验证 prompt 强制最终回答覆盖所有板块，而不是只给前三名。
- [x] 验证 prompt、data source 和 methodology 元数据。
- [x] 验证 input schema 不声明框架自动注入的 `task`。

### Task 4：实现与注册工具

- [x] 实现 `createGetSectorAnalysisTool`，支持 repository 注入以便测试。
- [x] 只通过 shared repository 获取生产数据。
- [x] 在 `registerAllTools` 中注册，并加入 market data agent 默认池。
- [x] 更新 market_data subagent prompt：板块总览省略 `sector_symbols`，单板块问题传一个代码，多板块对比传明确子集；这是“每个市场数据工具必须传 symbol”规则的唯一例外。
- [x] 运行工具列表检查，确认没有重名且 `get_sector_analysis` 可见。

### Task 5：验证

- [x] 运行板块算法与工具定向测试：15/15 通过。
- [x] 运行 `pnpm build`：本次文件通过独立 strict TypeScript 检查；全项目被工作区既有 skill-layer 类型错误阻断。
- [x] 运行完整 `pnpm test`：459 个测试中 458 通过；唯一失败为既有 `linkPreview` metadata 测试，与本工具无关。
- [x] 使用已配置 Alpaca key 完成只读 XLK/SPY smoke test；凭据未输出。
- [x] 人工检查真实输出：日期、单板块无排名语义、absolute trend、relative phase 和底层读数均明确。

## 7. 验收标准

- 用户问“现在什么板块最强/哪些板块在改善”时，market_data agent 能选择 `get_sector_analysis`，无需编造 ticker。
- 用户只问一个板块时，agent 能传单个 `sector_symbols`；工具只读取该 ETF 与 SPY，并明确不做横截面排名。
- 正常调用只走现有 SQLite repository，并复用其首次回填与后续增量更新。
- summary 和结构化输出覆盖全部 11 个板块，或明确列出缺失项；不会只展示前三名，也不会因一个板块失败而丢失全部结果。
- 每个排名都有实际收益、相对收益、均线结构、趋势质量和风险数字可解释。
- 最终模型回答包含完整板块排名表，并在表后给出跨板块的领先/改善/减弱/落后对比。
- score 的含义被限定为横截面强弱，不会被 prompt 表述成概率或交易信号。
- 新增测试、完整测试和 TypeScript build 全部通过；不覆盖工作区现有未提交修改。

## 8. 明确留到后续版本

- 成分股涨跌家数、站上 SMA200 比例等真正的 breadth 指标。
- 行业/子行业 ETF 或自定义板块池。
- 原生 Alpaca index values 与 ETF 代理的对照。
- 宏观经济周期、收益率曲线和新闻催化剂融合。
- 历史 walk-forward 回测、参数稳定性、交易成本和换手率评估。
- 板块热力图、四象限图和前端可视化。
