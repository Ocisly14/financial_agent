# Web3 交易 Agent:策略生成增强 + 回测 + 反馈闭环(顶层架构方案)

日期:2026-07-03
状态:方案(待评审)
范围:顶层架构。本文只对齐三块子系统的**接口、数据流、安全边界与拆分**,不写实现细节。三个子系统各自另出子 spec。

---

## 1. 目标与非目标

### 目标
1. **增强策略生成能力**:让 agent 生成的策略不再局限于 3 种纯价格触发,而能组合**技术指标(TA)+ 链上 + 情绪**信号 —— 真正 web3-native 的策略。
2. **加入回测**:对任意 draft 策略跑真正的历史 P&L 回测,产出标准化指标(总收益 / Sharpe / 最大回撤 / 胜率 / 交易数 / 敞口)。
3. **加入反馈闭环(部署前"生成→回测→优化"内环)**:agent 生成策略后**自动跑回测**,依据回测报告优化该策略(参数扫描 + LLM 结构性修改),迭代到指标达标或不再提升,再拿去部署。这是本轮闭环的**核心**;实盘后的记忆反思为次要补充。paper/shadow 可自动部署候选,升 live 必过人工审批门。

### 非目标(本轮明确不做)
- 不重训/微调模型;闭环走 **回测评判 + 语言反馈 + 记忆检索**(QuantAgent writer/judge + Reflexion / FinMem 路线),不改权重。
- 不做全自动进化上线(QuantEvolve 式的 live 自主进化)—— live 永远人工审批。
- 不做组合级(多标的)回测/优化;本轮单标的单策略,组合级列为远期扩展。
- 不改动现有 15 条风控规则的语义,不动 approval 安全不变量。

---

## 2. 设计决策(已与用户敲定)

| 决策点 | 结论 |
|---|---|
| 推进方式 | 先出本顶层架构 spec,再拆 3 个子 spec 各自 设计→计划→实现 |
| 信号范围 | 价格 + 技术指标 + 链上/情绪(全量,web3-native) |
| 闭环形态 | **部署前内环**:生成 → 自动回测 → 优化 → 再回测。核心是回测驱动的迭代优化,不是实盘后周期反思 |
| 优化驱动 | 双驱动:**参数扫描**(网格找数值最优,确定性)+ **LLM 结构性修改**(读回测报告换信号/加止损/改逻辑) |
| 停止条件 | 指标达标(如 Sharpe > 阈值 / 回撤 < 阈值)**或**连续 K 轮无明显提升 → 停;并设**封顶轮数**防死循环 |
| 闭环自治 | paper/shadow 可自动部署候选;升 live **必须**人工审批。live 安全不变量完全保留 |
| 回测真实度 | 成交扣**手续费(maker/taker)+ 滑点模型**,与 paper venue 对齐,回测数字才可信 |
| 标的粒度 | **单标的单策略**;组合级为远期非目标 |
| 缺数据处理 | 信号在回测区间缺历史 → **降级回测 + 报告明确标注**为"不可回测",不静默造假 |
| 回测原则 | **单一代码源** —— 回测、实盘 monitor、eval-replay 共用同一套信号+触发+执行评估核心。"回测通过" ≡ "实盘会这么跑" |
| 信息保真 | 回测只用「当时真实可得」的信息,不用未来值;历史以「当时观察到什么」构建,非事后回填终值(见 §7、C §4) |
| 验证方法学 | **walk-forward 滚动验证** + 参数平台(robust-max)+ embargo + 按试验次数打折(Deflated-Sharpe);粗到细网格调参,维度硬封顶(见 C §4) |
| 部署对象 | 本轮部署**冻结**策略(参数一次定死、零自动变动);重优化=人工重跑 loop,新版本 live 晋级受审批。衰减度量 + 回测分布推出的失效线做 kill-switch(见 C §7) |

---

## 3. 现状与缺口(实读代码结论)

**已运行的策略引擎**(`mcp_tools/trading/strategy/priceStrategy.ts`):只支持 `rolling_change` / `absolute_threshold` / `trailing_stop` 三种纯价格触发。`strategyMonitor.ts` 后台轮询驱动。

**写了但未接入 runtime**(`strategyDSL.ts`):定义了 `price.rsi` / `sma_cross` / `ema_cross` / `atr_band` / `volume.zscore` / `sentiment.score` 等信号 + entries/exits/risk —— monitor **从不执行**。这是"增强策略生成"最大的现成缺口。

**可复用基建**:
- eval 套件的 candle-replay harness(`scripts/eval/lib/replay.ts`):逐根 K 线跑**真实**触发逻辑,但只验证触发对错,**不算 P&L**。
- 风控引擎(15 规则)、paper venue、成本基准记账、approval 门 —— 均就位。
- 记忆记载:staging 仓库 `financial-agent-0428@staging` 有同源的 `backtest/runner.ts` + `indicators.ts` 可移植(见 `memory/auto-trading-strategy-reuse-source.md`)。
- onchain 工具(鲸鱼/净流入流出/交易量)、情绪源(恐慌贪婪)已存在,可作历史信号数据源。

**缺口**:真正的 P&L 回测;任何形式的反馈闭环;TA/链上/情绪信号的**执行**。

---

## 4. 核心骨架:SignalContext + StrategyEngine

三块子系统共用两个新抽象。这是整个方案的地基。

### 4.1 `SignalContext` —— 统一信号视图

一个按时间戳取值的接口,把"策略要判断的所有信号"归一到一处:

```
SignalContext.at(t) → {
  price, ohlc,                                  // 价格(已有源)
  ta:       { rsi, sma, ema, atr, vol_zscore }, // 从 K 线现算(移植 indicators)
  onchain:  { whale_netflow, exchange_inflow, exchange_outflow, tx_volume },
  sentiment:{ fear_greed }
}
```

两个实现,**同一接口**:
- `LiveSignalContext`:实时拉价格/链上/情绪源 —— 供 monitor 用。
- `HistoricalSignalContext`:回填并按时间轴对齐历史序列 —— 供 backtest 用。

### 4.2 `StrategyEngine.evaluate(dsl, ctx, state) → decision`

纯函数核心:给定策略 DSL、某时刻的 SignalContext、运行态(确认计数/触发历史/持仓),返回"是否触发、下什么单"。被三方共同驱动:

```
                ┌──────────────────────────────┐
                │   StrategyEngine.evaluate     │  ← 唯一信号+触发+执行判定源
                └──────────────────────────────┘
                  ▲            ▲            ▲
        LiveSignalContext  HistoricalCtx  ReplayCtx
                  │            │            │
             monitor(实盘)   backtest      eval-replay
```

**收益**:信号评估只写一份;回测=实盘=评测跑同一份代码;`strategyDSL.ts` 里沉睡的 TA 信号被真正激活。

---

## 5. 三个子系统

### 子系统 A —— 策略生成增强

- 把 TA / 链上 / 情绪信号作为**一等触发条件**接入 runtime(统一 `priceStrategy` 触发路径与 `strategyDSL` 信号定义,消除两套 DSL 的分裂)。
- 扩展 `cex_create_strategy` 工具 schema + trade 子 agent prompt,让模型能表达"RSI<30 且 交易所净流出 > X 时买入"这类复合条件。
- 扩展 NL→DSL eval 数据集(现有 ① 评测)覆盖新信号类型,守住生成保真度不回退。

**接口契约**:输出仍是一份合法 `StrategyDSL`,能被 StrategyEngine 直接评估。

### 子系统 B —— 回测引擎

- 移植/改写 staging 的 `backtest/runner.ts` + `indicators.ts`,驱动 `StrategyEngine.evaluate` 遍历 `HistoricalSignalContext`。
- 成交模拟复用现有 **paperVenue + riskEngine**(回测里风控同样生效),并加**手续费(maker/taker)+ 滑点模型**(固定 bps,或基于波动/深度),口径与 paper venue 对齐。
- 产出标准化指标(FinRL 风格):总收益、Sharpe、最大回撤、胜率、交易数、平均持仓时长、敞口。**缺数据的信号在报告中标为"不可回测"**(见 §6)。
- 新增 MCP 工具 `cex_backtest_strategy`:agent 可在 start 之前先回测一个 draft。
- **参数扫描模式**(网格遍历触发参数)—— 为子系统 C 的优化内环提供搜索能力。

**接口契约**:输入 `StrategyDSL` + 时间区间 + 数据源 → 输出 `BacktestReport{metrics, trades[], equity_curve, unbacktestable_signals[]}`。单标的。

### 子系统 C —— 反馈闭环(部署前"生成→回测→优化"内环)

**核心是一个部署前的迭代内环**(QuantAgent writer/judge 形态):

```
LLM 生成候选策略 v1
      │
      ▼
  自动回测(子系统 B) ──► BacktestReport(Sharpe/回撤/胜率/…)
      │
      ▼
  优化(双驱动):
    · 参数扫描 —— 固定结构下网格搜更优阈值/窗口/仓位(确定性)
    · LLM 结构性修改 —— 读回测报告换信号/加止损/改逻辑,产出 vN+1
      │
      ▼
  停止判定:指标达标 或 连续 K 轮无提升 或 到封顶轮数
      │
      ▼
  产出最优版本 → 部署(paper/shadow 自动;live 发 approval 走审批门)
```

- **优化编排器(Optimizer)**:驱动上面内环,记录每轮 `{dsl 版本, 回测指标}`,择优。参数扫描与 LLM 修改交替进行。
- **每策略绩效日志(episodic memory,FinMem 分层记忆风格,次要补充)**:归档每轮回测结果与实盘成交,按 strategy_id 存;供 LLM 优化时检索"这类策略以前踩过什么坑"。与项目级 `memory/` 分开。
- **生成时检索**:trade 子 agent 生成/优化策略时,检索相关历史反思注入上下文。

**接口契约**:输入初始 `StrategyDSL` + 优化预算(目标指标 / 封顶轮数);消费 `BacktestReport`;产出**最优 `StrategyDSL` 版本 + 优化轨迹(每轮版本与指标)**。部署受 mode 约束(live 必审批)。

---

## 6. trade subagent 的两层记忆架构(横切)

交易 agent 是独立 subagent(`trade`,与 `onchain_data` / `news_research` 并列,category 硬隔离)。其他两个是无状态取数器,**无需记忆**;`trade` 不同——它要在"生成→回测→优化→部署"里越用越懂市场,因此**独享两层记忆**。这是让反馈闭环真正"闭上"的载体。

### 短期 / 工作记忆(单 session 内)
- 范围:同一会话内、跨多次交易 dispatch 的工作连续性(本轮做过哪些草案、用户否了哪个、说过"太激进")。
- 语义:让本 session 内后续的交易决策看得到前面发生过什么,而不是每次 dispatch 从零开始。

### 长期记忆(独立于 session,持久)
- 范围:跨会话持久沉淀,按周/按月累积价值。
- 内容(本轮三类):
  1. **策略绩效教训**——即子系统 C 的 L1(per-strategy 绩效日志)+ L2(跨策略教训,检索键=信号组合+市况,**只吸收样本外验证过的结论**)。
  2. **实盘 vs 回测 divergence(校准信号)**——策略部署后,实盘 P&L 攒够即与其当初的回测预测对账,产出 divergence(如回测 Sharpe 2、实盘 0.3)沉淀入库。轻则标记该策略过拟合,重则沉淀"某类 signal-combo 的回测系统性偏乐观"。这是让 loop 从开环(优化完撒手)补成闭环(实盘结果回流校准)的关键——否则记忆里只有"回测世界的教训",学不到"回测与现实的差距"这条最值钱的。写入定义见子系统 C。
  3. **用户长期偏好**——风险取向、禁用杠杆、偏好币种等,跨会话保留,生成时纳入约束。
- 检索:生成/优化策略时,按相关性(信号组合+市况 / 该用户)检索注入。

### 与子系统的归属
- L1/L2 的**内容与写入**在子系统 C 定义;顶层这里定的是**"trade 独享两层记忆"这条架构决策**与两层的边界。
- 短期记忆是新增的一层,与绩效无关,纯 session 内工作连续性。
- L3 市场 regime 记忆 → 远期,本轮不做。

---

## 7. 最难的缝:历史信号数据对齐

回测要在同一时间轴上对齐**价格 K 线 + 链上指标 + 情绪** —— 三者原始频率/延迟不同(K 线分钟级、链上可能小时级、情绪日级)。架构上由 `HistoricalSignalContext` 独家负责:

- **信息保真原则(硬约束)**:回测只能使用「在那个时点真实可得」的信息,不得使用未来值——历史数据以「当时观察到什么」为准来构建,而非事后回填终值。链上/情绪尤为高危(存在发布滞后、事后修正),否则 optimizer 会精准地朝"利用不存在的先知能力"优化,回测越好实盘越崩。这条与 single-code-source 精神一脉相承:把一致性从"公式一致"扩展到"信息前沿一致"。具体实现(前向记录 / lag 字段 / 版本化快照)在 B 的 plan 阶段定。
- 定义各信号的**取值语义**(前向填充 vs 插值 vs 拒绝)与**可用性窗口**;信号缺数据时 `at(t)` 明确返回"不可用",StrategyEngine 对"信号不可用"有确定性行为(默认不触发)。
- 实盘 `LiveSignalContext` 用相同的"缺数据=不可用"语义,保证回测与实盘对齐。
- 历史链上/情绪数据源、缓存与回填策略在**子系统 B 的子 spec** 里细化。

---

## 8. 安全不变量(保留 + 新增)

- **(保留)无 approval 不成交**:闭环产出的 live 版本一律经 approval 门。
- **(保留)category 硬隔离**:回测/闭环新增工具归 `trading` category,非交易子 agent 拿不到。
- **(新增)闭环不得自动升 live**:优化内环在回测上迭代产出候选;候选**自动部署仅限 paper/shadow**,任何 live 转换必须人工审批。作为硬 gate 纳入 eval(⑥)。
- **(新增)冻结上线,零自动参数变动**:本轮部署对象为**冻结**策略(结构+参数一次定死);重优化=人工重跑 loop,产出的新版本 live 晋级照走审批(见 C §4/§7)。
- **(新增)kill-switch 只做停手、不需审批**:失效判断(C §7.3)的硬触发只**自动停止开新仓/减仓**——停手永远允许、只降风险,不属需审批的 live 动作,故与"无 approval 不成交"自洽。
- **(保留)风控全程生效**:回测与实盘的成交模拟都过 riskEngine。

---

## 9. 评测扩展(延续现有 ①–④' 套件)

- **⑤ 回测指标确定性**:同输入(含手续费/滑点参数)回测两次,指标逐位一致(纯函数保证)。
- **⑥ 闭环安全**:对抗试验断言优化内环**永不**自动产出 live 部署;paper/shadow 之外的任何 live 转换必带 approval。硬 gate=0 违规。
- **⑦ 优化内环收敛**:断言内环在封顶轮数内必停(不死循环),且择优版本的**跨 fold 汇总样本外指标**(walk-forward,见 C §4)≥ 初始版本(不倒退)。
- **① 扩展**:NL→DSL 数据集加入 TA/链上/情绪复合条件用例。
- **② 复用**:candle-replay 迁移到统一 `StrategyEngine.evaluate`,顺带验证信号评估。

---

## 10. 拆分与推进顺序

三个子 spec,依赖顺序如下(骨架先行):

```
0. 骨架(SignalContext + StrategyEngine 抽出) ── 前置,并入子系统 A 的子 spec
        │
        ▼
A. 策略生成增强 ──► B. 回测引擎 ──► C. 生成→回测→优化内环
   (激活 TA/链上/       (P&L + 手续费/滑点     (Optimizer:参数扫描 +
    情绪信号)            + 参数扫描)            LLM 结构性修改 + 绩效记忆)
```

- **A** 先行:没有信号执行,回测无从模拟新策略。骨架(SignalContext/StrategyEngine)在 A 的子 spec 里落地。
- **B** 次之:回测是 C 内环的评判信号;没有 P&L 数字,优化无从判定好坏。
- **C** 收尾:消费 B 的报告驱动优化内环。

每个子系统按 `设计 → 计划 → 实现` 独立走一轮。

---

## 11. 参考文献(web3 领域)

- 反思式记忆闭环:[CryptoTrade / Reflective Agent](https://arxiv.org/html/2407.09546v1)、[FinMem](https://arxiv.org/pdf/2311.13743)、[TradingGroup(自反思+数据合成)](https://arxiv.org/html/2508.17565v1)
- 内外双环 writer/judge:[QuantAgent(TradingAgents)](https://arxiv.org/pdf/2412.20138)、[SHARP 自演化人审 rubric](https://arxiv.org/pdf/2605.06822)
- 进化式策略搜索(远期参考):[MadEvolve](https://arxiv.org/html/2605.23007v1)
- 加密多 agent 组合管理:[LLM 多 agent 组合管理](https://arxiv.org/html/2501.00826v3)、[可解释零样本 BTC 交易(回测)](https://www.sciencedirect.com/science/article/abs/pii/S0306457325004078)
- 回测基准:[FinRL Contests](https://arxiv.org/pdf/2504.02281)
- 市况分类(regime,用于 C 的 L2 打标):[Hurst 检测趋势/均值回归(Macrosynergy)](https://macrosynergy.com/research/detecting-trends-and-mean-reversion-with-the-hurst-exponent/)、[Hurst vs ADX(FractalCycles)](https://fractalcycles.com/compare/hurst-vs-adx)、[Volatility Regime Classifier(Hurst+ADX+Choppiness)](https://www.tradingview.com/script/zagpmoKH-Volatility-Regime-Classifier-QuantRegime/)、[加密波动率 regime 对比](https://arxiv.org/html/2404.04962v1)、[非参在线 regime 检测](https://arxiv.org/pdf/2306.15835)
