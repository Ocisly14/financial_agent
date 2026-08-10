# WACC Sheet — Design

把 WACC 从"黑盒工具 + 参数库"改造成和 DCF 主表同构的**骨架表**：建模即有固定行结构，引擎自动计算可测项，agent 用假设/公式填不可测项，`wacc` 行是骨架公式的计算结果——第一性原理，没有旁路。

## 用户已定的决策

- **周期语义**：不进财年期网格。整张表是**估值时点标量**，as-of 日期 = **模型创建日**；beta 回归窗口、市值取价都锚定该日。刷新只更新数值，锚定日不变。
- **`compute_wacc` 彻底移除**：官方 WACC 就是骨架 `wacc` 行的计算值，无第二来源。`waccStore`/`wacc_status` 机制被表本身取代。
- **beta 窗口 10 年**（现 `DEFAULT_BETA_YEARS = 5` → 10）。

## 骨架（固定行，模型创建即存在）

| rowId | 来源 | 说明 |
|---|---|---|
| `beta` | 引擎自动 | 10y 日频/周频回归均值 vs SPY（复用 `waccDerivation.computeBeta` 路径） |
| `risk_free_rate` | agent 填 | 值或公式；sourceType market/search |
| `equity_risk_premium` | agent 填 | 唯一无可测来源项；sourceType agent_estimate |
| `cost_of_equity` | 骨架公式（锁定） | `risk_free_rate + beta * equity_risk_premium` |
| `cost_of_debt` | 引擎自动，可覆盖 | trailing（利息费用/平均债务）；agent 可用 search 来源覆盖 |
| `equity_value` | 引擎自动 | 稀释股数 × 创建日收盘价（barRepository） |
| `total_debt` | 引擎自动 | committed spine 的债务行（权重用总债务，见下） |
| `net_debt` | 骨架公式（锁定） | `total_debt - cash_and_equivalents`（展示/桥用） |
| `e_over_v` | 骨架公式（锁定） | `equity_value / (equity_value + total_debt)` |
| `d_over_v` | 骨架公式（锁定） | `total_debt / (equity_value + total_debt)` |
| `effective_tax_rate` | 引擎自动 | 所得税 ÷ 税前利润（复用现有推导） |
| `wacc` | 骨架公式（锁定） | `e_over_v * cost_of_equity + d_over_v * cost_of_debt * (1 - effective_tax_rate)` |

**权重口径注记（待用户确认的唯一偏离）**：用户原始清单是 Net Debt → D/V。按第一性原理 V = E + D 的 D 是债务市值（账面代理），现金是非经营资产走估值桥；净债务做权重会让现金富余公司 D/V 为负。故骨架**权重用 `total_debt`，`net_debt` 保留为独立展示行**。若用户仍要净债务权重，改 `d_over_v` 公式一行即可。

## 机制

- 快照新增 `waccSheet`：每行 `{ rowId, value: number|null, unit, source: "computed"|"assumption"|"formula"|"locked_formula", formulaSource?, provenance{sourceType,sourceRefs,asOfDate,rationale}, diagnostics }` + 表级 `asOfDate`（创建日）。codec 兼容老快照（null）。
- **求值**：锁定公式与 agent 公式复用现有 DSL parser/units，在"单列网格"上求值（表内行 id 命名空间 `wacc.<rowId>`；公式可引用表内行与工作簿科目的**创建日无关标量**——即只允许表内引用，工作簿数值经引擎自动项进入，不开跨网格引用，保持第一性链路清晰）。输入缺失（rf/ERP 未填）→ 下游行 null + `missing_input`，缺什么一目了然。
- **自动刷新**：创建时 + 每次 `review_financial_model_history` commit 后（沿用现有 waccRefresh 挂点），重算全部 computed 行；agent 填的行不动。
- **agent 写入**：`apply_financial_model_operations` 新操作 `set_wacc_input { rowId, value? | formula?, sourceType, sourceRefs, rationale }`——只对非锁定行（rf、ERP、cost_of_debt 覆盖）放行；锁定行拒绝。rationale 必填（沿用"覆盖引擎测量值需说明"的既有纪律）。
- **估值接线**:`valuation.ts` 的 wacc 输入改读 `waccSheet.wacc.value`；旧 `wacc` line item(assumption 行)保留展示但由表驱动（历史 none/forecast calculated 或直接移除——实施时按最小改动定，写进 plan）。
- **删除**：`compute_wacc` 工具、`COMPUTE_WACC_TOOL` 注册、`waccStore` 参数解析路径、`wacc_status` 附带机制（`get_financial_model`/commit 响应改带 `wacc_sheet` 全表——行数固定 12,不烧上下文）。`waccDerivation` 保留（自动项的计算引擎）。
- **prompt**：财务编排 prompt 的 WACC 两段重写：读表 → 缺什么填什么（`set_wacc_input`）→ `wacc` 行有值即官方折现率;删除 compute_wacc 叙述。

## 测试要点

- 创建即有 12 行骨架、asOfDate=创建日;自动项在 commit 后刷新、agent 项不被覆盖。
- rf/ERP 缺失 → cost_of_equity/wacc 为 null + missing_input 点名;补齐后链式算出。
- 锁定行拒绝 set_wacc_input;非锁定行覆盖带 rationale 生效并记 provenance。
- 权重口径:现金富余 fixture 下 d_over_v ≥ 0(total_debt 口径)。
- 估值读表:wacc 行有值才允许 advance 到 valued(替代原 compute_wacc 门槛)。
- codec round-trip + 老快照(无 waccSheet)兼容。
