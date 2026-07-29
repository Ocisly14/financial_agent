# 前端从 Crypto 专属定位改为泛金融的内容审计

日期：2026-07-29

范围：`client/` 前端页面、路由、双语文案、演示内容与静态资源
目标：去掉“只服务加密货币”的产品印象，把 Financial Agent 定位为覆盖股票、ETF、外汇、商品、指数和加密资产的金融研究与交易助手。

## 1. 结论

建议采用“泛金融优先、Crypto 作为可选资产类别”的方向，而不是从代码中彻底移除所有加密资产能力。

- 应删除：Crypto Week Report / Weekly Crypto Research、加密项目发现、链上专属展示卡、BTC 专属 onboarding demo，以及已失效的 `/hub` 和日报跳转残留。
- 应改写：首页 Hero、产品介绍、推荐/订阅文案、分析免责声明、综合分析说明，以及交易 dashboard 的信息架构和命名。
- 应保留并泛化：聊天、技术分析、新闻与情绪、图表、订单、策略、风险控制、paper/live 模式等通用金融能力。
- 应整体移除：`components/cex/` 及前端的 CEX 专属类型、hooks、API 命名和交互分支。后续交易功能基于统一的 `trading` 组件体系重写，不延续 CEX 组件作为兼容层。

完成后，首页首屏和核心导航不应默认出现 Crypto、BTC、链上、巨鲸、Binance 或 Coinbase；只有用户选择“加密资产”或配置对应交易场所后才显示相关内容。

## 2. 当前前端结构与发现

### 2.1 当前有效路由

`client/src/App.tsx` 当前注册了：

- `/`：首页
- `/chat/:agentId/:roomId`、`/chat/:agentId`：聊天与分析
- `/settings/:agentId`：Agent 信息页
- `/orders/:agentId`：订单
- `/floor/:agentId`：实时策略行情面板
- `/strategies/:agentId`、`/strategies/:agentId/:strategyId`：策略列表与详情

`app-sidebar.tsx` 仍展示 `/hub` 入口，但 `App.tsx` 没有注册 `/hub`。该入口既带有旧 Crypto 产品结构，又属于当前失效入口，建议优先清理。

### 2.2 Crypto 专属内容主要集中位置

| 区域 | 文件 | 当前问题 | 建议 |
| --- | --- | --- | --- |
| 首页 Hero | `components/landing/LandingPageHero.tsx`、`i18n/locales/*.ts` | 标题和 placeholder 明确写 Crypto，且英文 placeholder 在组件内硬编码 | 改写并全部收口到 i18n |
| 首页工具展示 | `components/landing/AgentToolsShowcase.tsx`、`i18n/locales/*.ts` | 链上分析、巨鲸、区块链、Crypto 新闻占据核心能力位 | 删除链上卡，替换成基本面/宏观/组合风险 |
| 发现中心/周报 | `components/app-sidebar.tsx`、`i18n/locales/*.ts` 的 `hub.*` | Crypto projects、Weekly Crypto Reports、coins；同时 `/hub` 路由已不存在 | 删除入口和整组遗留文案 |
| 订阅与推荐 | `i18n/locales/*.ts` | 套餐权益、邀请文案仍以 crypto analysis 为卖点 | 改为金融研究、跨资产覆盖、风险与组合分析 |
| 聊天/报告 | `i18n/locales/*.ts` | “12 actions 的加密货币综合分析”、仅针对加密货币的免责声明 | 改为按资产类别动态描述和通用金融免责声明 |
| Onboarding demo | `src/content/onboarding-demo/*`、`public/onboarding-demo/*` 及 public 根目录部分图片 | 完整示例全部围绕 BTC、巨鲸、链上交易、Fear & Greed、Binance | 整组删除；需要 demo 时另做股票/ETF/宏观示例 |
| 报告图表 | `components/NativeReportChart.tsx` | 对 `GET_ADDRESS_AND_TRANSACTION_DATA` 有链上图表专属视觉分支 | 若删除链上工具则一并删除；若保留 crypto 类别则条件保留 |
| 交易订单页 | `routes/orders.tsx` | Venue 筛选硬编码 Binance、Coinbase、Paper | 改为 API 驱动的交易场所筛选 |
| 策略行情页 | `routes/strategy-floor.tsx` | Binance Kline 文案与数据源硬编码；交易对解析默认 USDT/BTC/ETH | 改为泛金融 Market Monitor，并由 instrument metadata 驱动 |
| 交易 UI | `components/cex/*`、`Dialog/HumanInputDialog.tsx`、相关 hooks | 文件名、类型名、接口和交互模型与 Binance/CEX 强绑定 | 删除 CEX 组件；基于统一 instrument、account、order、venue 模型重写 |

## 3. 应该删除的内容

### P0：直接删除旧 Crypto 内容与失效入口

1. 删除侧边栏的 Discovery Hub 入口：
   - `client/src/components/app-sidebar.tsx` 中 `/hub` 导航和 `isHubActive`。
   - `client/src/i18n/locales/en.ts`、`zh-CN.ts` 中完整 `hub.*` 文案。
   - 原因：路由不存在；其中 Crypto Projects、Weekly Research Reports、coins 等都是旧 Crypto 信息架构。

2. 删除 Crypto onboarding demo 与专属静态资源：
   - `client/src/content/onboarding-demo/comprehensive.json`
   - `client/src/content/onboarding-demo/regular.json`
   - `client/src/content/onboarding-demo/task-chain.json`
   - `client/public/onboarding-demo/` 下的 BTC、Fear & Greed、Bitcoin risk、链上图表等资源
   - public 根目录中与上述 demo 重复的 Bitcoin / comprehensive chart 图片，在确认无外部链接后删除。
   - 当前 `client/src` 内没有发现这些 demo JSON 的直接引用，删除前仍应确认部署环境或服务端是否按静态路径读取。

4. 删除首页工具展示中的 On-Chain Data Analysis 卡：
   - 删除 `onchain` 工具项、链条 emoji 和专属 icon 映射。
   - 用“Fundamental Analysis / 基本面分析”或“Portfolio & Risk / 组合与风险”替换，而不是保留一个 Crypto 专属能力占据一级展示位。

5. 删除订阅方案里的 Crypto 周报权益：
   - `Weekly research report brief on cryptos`
   - `Full weekly research report on cryptos`
   - 对应中文“每周加密研究简报”“完整的每周加密研究报告”。

### P1：删除 CEX 前端体系

删除 `client/src/components/cex/` 整个目录，包括：

- `CandleScope.tsx`
- `InferredTraitsTab.tsx`
- `KillSwitchBanner.tsx`
- `KillSwitchToggle.tsx`
- `LiveTradingConsentModal.tsx`
- `ManualComposeDialog.tsx`
- `MarketSnapshotPanel.tsx`
- `ModeBadge.tsx`
- `OrderConfigSummaryCard.tsx`
- `TradingOrderEditor.tsx`
- `TradingRiskLimitsTab.tsx`
- `candleTheme.ts`

同时删除或改写所有引用方：

- `App.tsx`：移除 CEX Kill Switch 与 Live Trading Consent 的全局挂载，之后由统一交易 shell 挂载对应组件。
- `ChatComposer.tsx`：删除 `ManualComposeDialog` 依赖，改接统一的 `OrderTicketDialog`。
- `Dialog/HumanInputDialog.tsx`：删除 CEX 专属订单编辑器、订单摘要和行情快照分支；通用输入弹窗只负责流程审批，交易订单交给统一交易组件。
- `Dialog/StrategyApprovalDialog.tsx`：将 CEX `ModeBadge` 替换成统一 `TradingModeBadge`。
- `StockChart.tsx`、`strategy-floor.tsx`：不能继续从 CEX 目录复用 K 线组件，应迁移到独立的 `components/charts/`。
- `useMarketSnapshot.ts`：删除 `/cex/market-snapshot` 语义，改写为通用 instrument quote hook。
- `lib/api.ts`：删除前端 `/cex/account-snapshot`、`/cex/market-snapshot`、`/cex/klines`、`/cex/products` 客户端方法，改接统一 trading API。
- `lib/__tests__/candleTheme.test.ts`：随新 chart theme 位置重写导入和测试。

Coinbase Access Token、Binance/Coinbase 专属 venue 配置和 OCO、Iceberg、trailing delta 等 CEX 字段也从通用前端删除。未来如继续支持数字资产，应通过统一 venue capability schema 按需提供，不能重新引入一套 CEX 专属组件树。

`NativeReportChart.tsx` 的链上专属图表分支仍属于条件删除：若研究产品继续支持 Digital Assets，可以作为报告图表类型保留；它不应依赖交易 CEX 组件。

## 4. 应该改写的内容

### 4.1 首页定位

建议首页从“Crypto 问答入口”改为“跨资产金融研究入口”。

| 位置 | 当前 | 建议中文 | 建议英文 |
| --- | --- | --- | --- |
| Hero 标题 | 今天我们想探索哪些加密市场问题？ | 今天想研究哪个市场、公司或投资组合？ | What market, company, or portfolio are we analyzing today? |
| 输入框 | 用 Financial Agent 深入探索加密市场 | 分析股票、ETF、宏观数据、外汇、商品或加密资产 | Analyze stocks, ETFs, macro data, FX, commodities, or digital assets |
| Footer | AI 驱动的加密分析与洞察 | AI 驱动的跨资产金融研究与风险洞察 | AI-powered cross-asset research and risk insights |
| 工具区标题 | 为更聪明的加密洞察打造 | 用 AI 完成研究、比较、监控与风险分析 | Research, compare, monitor, and assess risk with AI |

同时修复 `LandingPageHero.tsx` 中硬编码的英文 placeholder，使中英文都使用 `landing.hero.placeholder`。

### 4.2 首页能力卡

建议六张卡调整为：

1. 市场与新闻情绪：新闻、公告、研究观点和事件影响。
2. 技术分析：价格、成交量、趋势、波动率和关键价位。
3. 基本面分析：财报、估值、盈利质量和同行比较。
4. 宏观与跨资产：利率、通胀、汇率、商品与指数联动。
5. 组合与风险：持仓暴露、集中度、回撤、情景分析。
6. 综合研究报告：整合行情、基本面、技术面、新闻和风险。

不建议把“价格预测”继续作为核心卖点；可改为“情景分析”，用基准/乐观/悲观情景及风险条件表达不确定性。

### 4.3 Trending Research

`TrendingResearch.tsx` 的组件本身是通用任务链列表，可以保留，但建议：

- 标题从“Hottest Task Chains / 最热门任务链”改为“Popular Research Workflows / 热门研究工作流”。
- 后端结果需要避免默认返回 BTC、链上、Crypto research 等旧任务链。
- 卡片最好增加资产类别标签，例如 Stocks、Macro、ETF、FX、Commodities、Digital Assets。

### 4.4 推荐、套餐与聊天文案

集中改写 `i18n/locales/en.ts` 和 `zh-CN.ts`：

- `referrals.description`：从“强大的加密分析工具”改成“跨资产金融研究与分析工具”。
- `settings.account.freeFeatures`：从“基础加密分析”改成“基础市场与公司分析”。
- Pricing 描述：从“所有方案包含 crypto analysis”改成“覆盖研究、图表和风险分析”。
- 套餐权益：把“更多加密资产”“主流加密技术分析/预测/综合分析”改成跨资产覆盖、更多数据源、组合分析、报告导出等。
- 审批示例中的“链上指标”改成“基本面指标”或“宏观指标”。
- 通用免责声明建议改为：

  > 本内容仅供信息与研究参考，不构成投资、交易、法律或税务建议。市场存在损失风险，历史表现不代表未来结果。请结合自身目标、风险承受能力和独立判断作出决策。

Crypto 特有风险提示只在分析数字资产时追加，不再作为所有报告的默认免责声明。

## 5. 交易 Dashboard 的泛金融改造

### 5.1 建议的新信息架构

把当前 `Orders / Floor / Strategies` 改写为一个“Trading / 交易”工作区：

| 当前页面 | 建议名称 | 泛金融职责 |
| --- | --- | --- |
| Orders | Orders / 订单 | 展示所有资产的订单与成交状态 |
| Floor | Markets / 市场 | 自选列表、价格图、市场状态、报价和交易时段 |
| Strategies | Strategies / 策略 | 跨资产策略、触发条件、风控与执行记录 |
| 无 | Portfolio / 组合 | 持仓、现金、资产配置、PnL、风险暴露 |
| 无 | Risk / 风险 | 集中度、回撤、杠杆、限额和 kill switch |

### 5.2 必须改写的硬编码

`routes/orders.tsx`：

- Venue 下拉框不再硬编码 Binance、Coinbase、Paper。
- 使用现有 exchange/venue registry API 动态渲染已支持和已连接的 broker/venue。
- 文案中的 `Symbol` 可按资产类型显示为 `Instrument / 标的`；股票显示 `AAPL`，外汇显示 `EUR/USD`，加密显示 `BTC/USDT`。

`routes/strategy-floor.tsx`：

- 页面 `Auto-Trading · Floor / THE FLOOR` 改为 `Trading · Markets / MARKETS`。
- 删除“Real Binance klines”用户可见声明，改成动态数据源和延迟状态，例如“Market data · {{source}} · Updated {{time}}”。
- 不能再通过 `USDT|USDC|BTC|ETH` 正则拆解标的，应由 API 返回 instrument metadata：`assetClass`、`baseAsset`、`quoteAsset`、`currency`、`exchange`、`marketStatus`、`timezone`。
- 增加传统金融所需状态：盘前、开盘、盘后、休市、延迟行情；不要默认 24/7。
- `24H HIGH/LOW` 应改成按市场口径的 `Session High/Low`；Crypto 可继续使用 24h。
- Quote Volume 对股票不一定有意义，建议由资产类型决定显示成交量、成交额、点差或未平仓量。

`routes/strategies.tsx` 与 `strategy-detail.tsx`：

- UI 大部分可保留，策略、触发器、PnL、paper/live、风控限制本身是通用金融能力。
- 将 `Symbol / 交易对` 泛化为 `Instrument / 标的`。
- `fixed_quote_usd`、`pct_of_position` 等 sizing 应逐步泛化为 currency-aware sizing。
- 策略详情应补充 broker、market session、time-in-force、asset class 和交易币种。

### 5.3 统一交易组件的重写方案

不要将 `components/cex/` 原样重命名为 `components/trading/`。旧组件建立在交易对、24/7 行情、CEX 账户快照和 Binance 风格订单字段之上，直接搬迁会把旧模型继续带入新架构。

建议新建以下结构，并以通用金融领域模型重写：

```text
client/src/components/trading/
├── account/
│   ├── AccountSummary.tsx
│   └── BuyingPower.tsx
├── instrument/
│   ├── InstrumentPicker.tsx
│   ├── InstrumentQuote.tsx
│   └── MarketSessionBadge.tsx
├── order/
│   ├── OrderTicket.tsx
│   ├── OrderReview.tsx
│   ├── OrderStatusBadge.tsx
│   └── fields/
├── portfolio/
│   ├── PositionsTable.tsx
│   └── PortfolioSummary.tsx
├── risk/
│   ├── RiskLimits.tsx
│   ├── TradingKillSwitch.tsx
│   └── LiveTradingConsent.tsx
├── strategy/
│   ├── StrategyApproval.tsx
│   └── TradingModeBadge.tsx
└── venue/
    ├── VenueConnection.tsx
    └── VenueCapabilityFields.tsx

client/src/components/charts/
├── CandlestickChart.tsx
└── candleTheme.ts
```

统一组件只依赖以下领域对象：

- `Instrument`：`id`、`symbol`、`displayName`、`assetClass`、`currency`、`exchange`、`marketSession`。
- `Quote`：bid、ask、last、timestamp、delay status，不假设一定有 base/quote pair。
- `TradingAccount`：broker/venue、cash、buying power、positions、permissions。
- `OrderDraft`：instrument、side、quantity/notional、order type、limit/stop、TIF、session。
- `VenueCapabilities`：支持的资产类别、订单类型、TIF、extended hours、fractional、特殊字段。

关键原则：

- 通用订单表单由 `VenueCapabilities` 驱动，而不是根据 `exchange === "binance"` 或 `exchange === "coinbase"` 分支渲染。
- 股票、ETF、期权、外汇、商品和 Digital Assets 共享订单流程，但可由 capability schema 插入各自字段。
- Kill switch、live consent、risk limits 可以重写为统一交易组件，因为这些概念不是 CEX 专属。
- 旧 CEX 组件不作为适配层长期共存；统一组件接通后应彻底移除旧目录和旧类型。

## 6. 建议保留的内容

- 聊天、文件上传、语音入口、任务链和报告渲染。
- StockChart、通用 K 线和技术指标组件。
- 新闻与情绪分析，但数据源和描述需跨资产。
- 订单生命周期、取消订单、策略暂停/恢复、执行记录和累计 PnL。
- paper / shadow / live 模式、交易确认、风控限额和 kill switch。
- Crypto 能力可作为 Digital Assets 分类保留，但不进入默认首屏、默认 demo 或通用产品文案。

代码中的 `token` 并不都指加密代币。例如 access token、LLM token usage、design token 都不应因本次改造而删除；应按语义逐项判断。

## 7. 后端与数据依赖

虽然本文件是前端审计，但以下改造仅改文案无法真正完成：

- 首页 Daily Analysis API 当前返回按 Crypto symbol 组织的报告；若未来恢复泛金融 briefs，需要后端返回 `assetClass`、`instrumentId`、`displayName`、`reportType`。
- Trending task chains 的内容来自 API，需要清理服务端默认/历史 Crypto 模板。
- Market/Floor 当前行情说明依赖 Binance Kline；要支持股票、ETF、外汇和商品，需要统一行情接口与市场时段元数据。
- Orders 需要 venue registry 返回展示名、asset classes、连接状态和 capabilities。
- 综合分析的 prompts/tools 仍可能强制执行链上、Crypto price、Fear & Greed 等动作；前端文案改完后，服务端工作流也必须按资产类别选择工具。
- Coinbase OAuth、Binance credentials 等设置项应由已启用的 venue 动态出现，而不是成为通用账户设置。

## 8. 推荐实施顺序

### 第一阶段：去 Crypto 品牌化（低风险）

- 删除 `/hub` 入口和 `hub.*` 文案。
- 删除首页 Daily Analysis / Crypto 周报展示。
- 删除 Crypto onboarding demo 和未引用静态资源。
- 改写首页、Footer、推荐、套餐、聊天和免责声明的中英文文案。
- 用基本面、宏观、组合风险替换链上能力卡。

### 第二阶段：交易界面泛化（中风险）

- 将 Floor 改为 Markets。
- Orders 的 venue 改为 API 驱动。
- 引入 instrument metadata，移除交易对字符串正则和 USDT 默认值。
- 增加市场时段、币种和资产类别展示。

### 第三阶段：统一交易组件替换 CEX（较高风险）

- 先定义 `Instrument`、`Quote`、`TradingAccount`、`OrderDraft` 和 `VenueCapabilities` 契约。
- 新建统一 `components/trading/` 与 `components/charts/`，逐个替换 App、Chat、Dialog、Floor 和 StockChart 的依赖。
- 按 venue capabilities 渲染订单字段，并接入统一行情、账户、订单和风控 API。
- 替换完成后删除整个 `components/cex/`、CEX 类型、hooks、API 方法和相关测试残留。
- 增加证券 broker 与对应行情/下单接口后，再开放股票、ETF 等真实交易。

## 9. 验收标准

1. 未选择 Digital Assets 时，首页、导航、套餐和默认聊天不出现 Crypto、BTC、链上、巨鲸、Binance、Coinbase。
2. `/hub` 与 `/report/daily` 不再存在可点击但无法访问的入口。
3. 首页能力覆盖至少股票/ETF、宏观、技术面、基本面、新闻和组合风险。
4. 中英文文案语义一致，组件内不再硬编码英文 Crypto 文案。
5. Trading 页面可使用非 Crypto instrument metadata 渲染，不依赖 `USDT/BTC/ETH` 字符串规则。
6. Venue 列表来自 API，不在页面内写死交易所。
7. 市场页能够区分 24/7、盘前、正常交易、盘后和休市状态。
8. Crypto 相关 UI 只在对应资产类别或已连接 Crypto venue 下出现。
9. 搜索 `crypto|cryptocurrency|bitcoin|btc|on-chain|blockchain|whale|加密|比特币|链上|巨鲸` 后，剩余命中均有明确的 Digital Assets 条件上下文，不再是通用品牌文案。
10. `client/src/components/cex/` 不再存在，`client/src` 中不存在 `components/cex` 导入、`CEX*` 公共类型或 `/cex/` 前端 API 路径。
11. 下单、审批、行情、账户、风控和图表均通过统一交易组件与领域模型工作，不能通过复制旧 CEX 组件实现验收。

## 10. 本次文档不包含的改动

本次只完成审计与改造建议，没有修改前端业务代码、删除资源或调整后端接口。实施方向已经明确为删除全部 CEX 前端组件并重写统一交易组件；正式开发前仍需确定第一批要支持的资产类别、broker/data provider 和统一 trading API 契约。
