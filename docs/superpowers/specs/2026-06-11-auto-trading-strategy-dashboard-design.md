---
title: 自动交易策略可视化面板(Strategy Dashboard) — 设计 spec
date: 2026-06-11
status: spec
---

**Status:** Design (pending implementation)
**Date:** 2026-06-11
**Author:** victor530914@gmail.com (with Claude)
**Scope:** 为 [自动交易策略引擎](./2026-06-10-auto-trading-strategy-design.md)(commit `6cbe31b`)新增前端可视化面板 —— 策略列表页 + 详情页,以及支撑它的少量后端 REST 接口。仅覆盖"监控为主 + 基本操作(approve/reject/pause/resume/cancel)",创建/编辑策略仍通过聊天(`cex_create_strategy` / `cex_start_strategy`)完成。

---

## 1. 背景与目标

策略引擎(DSL、触发器、风控、执行器、监控循环)已在后端跑通,但用户只能通过聊天调用 `cex_list_strategies` / `cex_manage_strategy` 来查看状态,没有可视化界面。

目标:仿照参考成熟 quant 软件(3Commas 的 bot 详情页有独立 URL、FreqUI 的 Trade 列表 + 详情视图)的常见模式,新增一个"策略仪表盘":

- 列表页:所有策略的状态、symbol、触发条件、模式一览,可按状态筛选。
- 详情页:单个策略的完整配置、执行历史、累计 PnL 曲线,以及状态操作按钮。

### 非目标

- 不在页面上创建/编辑策略 DSL(仍走聊天 + `cex_create_strategy`)。
- 不做跨策略的汇总统计条(今日总 PnL、今日交易计数等)—— 这些数据目前没有按需暴露的接口,留作后续增强(对应 brainstorm 阶段的 mockup B)。
- 不修改策略引擎本身的逻辑(触发器评估、执行器、监控循环不变)。

---

## 2. 路由 & 导航

| 路由 | 文件 | 说明 |
|---|---|---|
| `strategies/:agentId` | `client/src/routes/strategies.tsx` | 列表页(新建,lazy-loaded,模式同 `routes/orders.tsx`) |
| `strategies/:agentId/:strategyId` | `client/src/routes/strategy-detail.tsx` | 详情页(新建,独立 URL,可刷新/分享/浏览器前进后退) |

`client/src/App.tsx` 新增两条 `<Route>`,均 `lazy(() => import(...))`,放在现有 `orders/:agentId` 路由旁边。

### 导航入口

- `client/src/components/room-selector.tsx` 的 agent header 操作区("create room" 按钮旁,约 L409-426)新增一个图标按钮(`TrendingUp` from lucide-react),点击跳转到 `/strategies/${agentId}`。
- `orders.tsx` 与 `strategies.tsx` 顶部各加一个轻量的 "Orders / Strategies" 切换标签(两个 `NavLink`,基于 `useParams<{agentId:string}>()` 保留 `:agentId`),两页互相可达。

---

## 3. 列表页(`strategies.tsx`)

整体沿用 `orders.tsx`(`client/src/routes/orders.tsx`)的结构:

- Header:标题 "Strategies" + `ModeBadge`(复用 `client/src/components/cex/ModeBadge.tsx`)。
- 状态筛选 chips,对应 `StrategyLifecycle`:`draft / pending_approval / active / running / paused / completed / cancelled / failed`,加一个 "All"。新增 `STRATEGY_STATE_BADGE: Record<StrategyLifecycle, string>` 颜色映射(参照 `orders.tsx` L18-28 的 `STATE_BADGE` 写法,如:`active`/`running` → emerald,`pending_approval` → amber,`paused` → slate,`failed`/`cancelled` → rose/zinc)。
- 数据获取:
  ```ts
  useQuery({
    queryKey: ["user", "strategies", { statusFilter }],
    queryFn: () => apiClient.listStrategies(),
    refetchInterval: 15_000,
  })
  ```
  按 `statusFilter` 客户端过滤(策略数量级小,不需要服务端过滤)。
- 表格列:
  1. 状态徽章(`StatusBadge`,复用 `STRATEGY_STATE_BADGE`)
  2. Symbol(`strategy.symbol`)
  3. Mode(`strategy.dsl.mode`,复用 `ModeBadge` 的颜色逻辑,显式传 `mode` prop)
  4. 触发条件摘要 —— 新增客户端 helper `summarizeTrigger(dsl: PriceStrategyDSL): string`,移植自
     `mcp_tools/trading/strategy/priceStrategy.ts` 中的 `summarizePriceStrategy`(纯字符串拼接,无依赖,可以直接复制到
     `client/src/lib/strategySummary.ts`)。
  5. Recurrence(`one_shot` 或 `recurring (n/max)`,来自 `dsl.recurrence`)
  6. 创建时间(`strategy.created_at`,`toLocaleString()`)
- 整行可点击(`onClick` → `navigate(`/strategies/${agentId}/${strategy.id}`)`),空状态/加载状态文案同 `orders.tsx`("Loading…" / "No strategies yet.")。

---

## 4. 详情页(`strategy-detail.tsx`)

- 顶部:`← Back to strategies`(`NavLink` 回列表页)+ symbol + 状态徽章 + `ModeBadge`。
- 数据获取:
  ```ts
  useQuery({
    queryKey: ["user", "strategy", strategyId],
    queryFn: () => apiClient.getStrategy(strategyId),
    refetchInterval: 15_000,
  })
  ```
  返回 `{ strategy: StoredStrategy, executions: ExecutionLogEntry[] }`。
- **配置详情卡片**(参照 `client/src/components/cex/OrderConfigSummaryCard.tsx` 的卡片样式):
  - Trigger:类型(`rolling_change` / `absolute_threshold` / `trailing_stop`)+ 对应参数(pct/window_minutes/price/direction/confirm_samples)
  - Action:side、size(type + value)、order_type、max_slippage_bps
  - Guardrails:`max_notional_usd`(若有)
  - Recurrence:mode、cooldown_minutes、max_triggers、当前 trigger_count
- **操作按钮**(根据 `strategy.status` 条件渲染,`useMutation` + 成功后 `queryClient.invalidateQueries(["user","strategies"])` 和 `["user","strategy",strategyId]`):
  - `pending_approval` → "Approve" / "Reject" → `apiClient.activateStrategy(id, "approve"|"reject")`
  - `active` → "Pause" / "Cancel" → `apiClient.setStrategyStatus(id, "pause"|"cancel")`
  - `paused` → "Resume" / "Cancel" → `apiClient.setStrategyStatus(id, "resume"|"cancel")`
  - `draft` / `running` / 终态(`completed`/`cancelled`/`failed`)→ 不显示操作按钮
  - 操作失败(如 409 invalid transition)用现有 toast(`sonner`)展示错误信息
- **执行历史表格**:列 = 时间(`ts`)、side(策略级常量,取 `strategy.dsl.action.side`,因 v1 每个策略只有一个 action)、成交价(`execution.order_result?.fillPrice ?? execution.trigger_snapshot?.price`)、realized PnL(`realized_pnl`)、order id(`order_id`,用 `orders.tsx` 里的 `TruncatedId` 组件)。空状态文案 "No executions yet."。
- **累计 PnL 折线图**:复用 `client/src/components/admin/line-chart.tsx` 的 `LineChart`。数据 = 按时间排序的 `executions`,对 `realized_pnl ?? 0` 做 cumulative sum,x 轴为 `ts`(格式化为短日期/时间)。少于 2 个数据点时不渲染图表,显示占位文案。

---

## 5. 后端新增(`src/server/server.ts` + `src/trading/persistence/strategyStore.ts`)

### 5.1 共享状态转换 helper

`mcp_tools/trading/strategyTools.ts` 的 `createCexManageStrategyTool`(L236-263)中 pause/resume/cancel 的状态转换逻辑抽取到
`src/trading/persistence/strategyStore.ts`:

```ts
export type ManageOp = "pause" | "resume" | "cancel";

export function applyStrategyOp(
  strategy: StoredStrategy,
  op: ManageOp,
): { ok: true; strategy: StoredStrategy } | { ok: false; error: string } {
  // cancel: 禁止从 completed/cancelled 转换
  // pause: 仅允许 active -> paused
  // resume: 仅允许 paused -> active
  // 与现有 cex_manage_strategy 中的错误信息文案保持一致
}
```

`cex_manage_strategy` 的 `pause`/`resume`/`cancel` 分支改为调用 `applyStrategyOp` + `saveStrategy`(`get` 分支不变)。

### 5.2 新增 REST 端点(紧邻 `src/server/server.ts` 现有策略路由块,约 L906-929)

- `GET /user/strategies/:id`
  - 复用 `loadStrategy(id)` + `listExecutions(id)`
  - 404(`{success:false, error:"not_found"}`)若策略不存在
  - 200 → `{ success: true, strategy: StoredStrategy, executions: ExecutionLogEntry[] }`
- `PUT /user/strategies/:id/status`
  - body `{ op: "pause" | "resume" | "cancel" }`
  - 加载策略 → `applyStrategyOp(strategy, op)` → 失败时 409 `{success:false, error}`,成功时 `saveStrategy` 并返回 `{success:true, status: strategy.status}`
  - 404 若策略不存在(同 `/activate` 的处理方式)

现有 `GET /user/strategies` 与 `POST /user/strategies/:id/activate`(approve/reject,L907-929)不变。

---

## 6. 前端 API client(`client/src/lib/api.ts`)

- 新增 `getStrategy(id: string): Promise<{ success: boolean; strategy: StoredStrategy; executions: ExecutionLogEntry[] }>` → `GET /user/strategies/:id`
- 新增 `activateStrategy(id: string, decision: "approve" | "reject"): Promise<{success, status}>` → `POST /user/strategies/:id/activate`,body `{decision}`
- 修正现有 `setStrategyStatus`(目前指向不存在的端点):签名改为 `(id: string, op: "pause"|"resume"|"cancel") => PUT /user/strategies/:id/status`,body `{op}`
- `StoredStrategy` / `ExecutionLogEntry` / `PriceStrategyDSL` 的最小类型形状镜像到 `client/src/types/core.ts`(与该文件现有
  CEX 类型的处理方式一致 —— client 不直接 import `src/trading/...` 或 `mcp_tools/...` 下的服务端路径,只复制编译期需要的字段)。

---

## 7. i18n

`client/src/i18n/locales/en.ts` 与 `zh-CN.ts` 新增 `strategies` 命名空间,镜像 `rooms`/`overview` 的结构,内容包括:

- 页面标题、列名(Status/Symbol/Mode/Trigger/Recurrence/Created)
- `StrategyLifecycle` 状态文案(8 个状态)
- 操作按钮文案(Approve/Reject/Pause/Resume/Cancel)
- 空状态文案(No strategies yet. / No executions yet.)
- "Orders" / "Strategies" 切换标签文案(在 `userMenu` 或新命名空间下,与现有 `userMenu.orders`,L75 对应)

---

## 8. 验证

- `pnpm -C client build`:确认新路由、api client、i18n key 无类型错误。
- 后端:
  - `mcp_tools/trading/strategy/__tests__/*` 现有测试在抽取 `applyStrategyOp` 后仍通过(行为不变)。
  - 手动 `curl`:
    - `GET /user/strategies/:id`(用 `scripts/test-strategy.ts` 创建的策略)返回 `{strategy, executions}`。
    - `PUT /user/strategies/:id/status` 对 `active`→`paused`→`active`→`cancelled` 的合法转换返回 200;非法转换(如对 `cancelled` 策略再 `pause`)返回 409。
- 前端(dev server):
  - `/strategies/:agentId` 列表渲染正确的状态徽章与触发摘要(用聊天创建的策略)。
  - `pending_approval` 策略点 Approve/Reject 后状态更新,列表刷新。
  - `active`/`paused` 策略的 Pause/Resume/Cancel 按钮端到端可用。
  - 有执行记录的策略详情页显示执行表格 + PnL 曲线;无执行记录显示空状态而非报错。
  - Orders ↔ Strategies 标签切换保留 `:agentId`;详情页 `← Back` 返回列表页。
