---
name: stock-analysis
description: Deep single-ticker analysis — quote, multi-timeframe technicals, recent news, and a structured conclusion. Use when the user asks what is going on with one stock, or asks for an analysis, read, or view on a ticker.
agents: [market_data, market_research]
---

分析顺序固定：行情 → 多周期技术面 → 新闻面 → 结构化结论。前一步的结果决定后一步问什么。

三条硬约束：

1. 每个判断必须挂一个来自工具返回的具体数值或新闻条目。`get_stock_price` 已经返回
   精确的最高/最低价及其日期、区间回报、最大回撤和均线，**直接引用，禁止自行重算**。
2. 冲突信号必须显式写出来。日线超买而周线仍在上升趋势，就两个都说，不要挑一边。
3. 输出是描述性分析，不是买卖指令。不给目标价，不说该买该卖。

技术面工具只接受两类 timeframe：`1Day`，或 1-390 之间的分钟/小时间隔（如
`15Min`、`60Min`、`1h`）；没有周线/月线这类聚合周期，不要向工具请求这类参数。

需要某个指标的解读细则时，用 `read_skill_reference` 读 `indicator-playbook.md`；
输出前读 `report-template.md` 取结构。不要一上来就把两个都读进来。

拿到 RSI、MACD 柱状图、均线和 ATR 之后，可以用
`run_skill_script("stock-analysis", "score.ts", { ... })` 把它们汇总成趋势 / 动量 /
波动三个维度的评分与依据。它是描述性的汇总，输出仍要按上面第三条约束表述。

## for: market_data

先 `get_stock_price` 拿默认的 250 日 condensed history 建立基线。
要看某个具体的历史时段，用 `window` 参数；不要靠放大 `historyDays` 去够——
那样既贵又不准，且工具会把 historyDays 截断。
技术面至少两个周期：1Day 定方向，15Min 或 60Min 定当下结构。
参数默认 RSI 14 / MACD 12-26-9 / 布林带 20-2，除非用户另有指定。
背离必须在两个周期上交叉验证之后才能报告。
每个指标结果回传时带上 bar_count 和 timeframe，让上层知道样本量。
`stock_vwap` 不加参数调用默认是 `timeframe: 1Day`、`history_bars: 20`，
算出来的是跨 20 天的累计 VWAP，不能拿来当日内位置——要当日 VWAP，必须
显式传分钟级 `timeframe`（如 `5Min`）并把 `history_bars` 限制在当日已
过的 bar 数以内。

## for: market_research

只取 30 天内的新闻；每条必须带日期和来源域名。
区分「已发生的事实」与「分析师预期」，后者标注给出预期的机构名。
找不到相关新闻就明说找不到，不要用宏观叙事填充。
