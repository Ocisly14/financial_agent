# 私有 DCF subagent 改为 skill 驱动：把写死的阶段换成 agent 自己的判断

日期：2026-08-11
前置：`docs/superpowers/specs/2026-08-11-per-agent-skill-pool-design.md`（agent 层 skill、归属在注册表、invoke_skill）
      `docs/superpowers/specs/2026-08-07-unified-statements-two-stage-design.md`
      `docs/superpowers/specs/2026-08-07-dcf-spine-mapping-design.md`
范围：`statement_unification` 与 `spine_mapping` 两个私有 subagent 的执行形态；
      交付工具（submit / patch）；两份 agent 层 skill；私有循环
不在范围：把这两个 subagent 提升为 AgentKind（它们仍是 FM 的私有委派，orchestrator 看不到）；
      unification / spine 的算法本身；`run_dcf_subagent` 的对外契约

---

## 1. 结论

这两个 subagent 的工作流程是 **TypeScript 写死的阶段**，不是它们自己的判断：

```ts
// statementUnificationAgent.ts:106-126
await loadWorkingSet(...)                       // 阶段 1，最多 2 次尝试
const digest = ... await exploreDimensions(...) // 阶段 2，最多 8 步
const inventory = buildConceptInventory(...)    // 宿主自建，用于核对
for (let run = 1; run <= maxRuns; run += 1) {   // 阶段 3-4，最多 3 轮
  decision = decision === undefined ? await requestDecision(...) : applyUnificationPatch(decision, await requestPatch(...))
```

`spineMappingAgent.ts:68,77-82` 是同一形状。四个写死的 LLM 入口，各带一套提示、解析和重试。

这套结构在 2026-08-11 的一次生产运行里暴露了代价。探索阶段第 6 步重新载入了概念清单（AAPL 实测 80 条 / 71K ≈ 2.3 万 token），输入从 14129 涨到 37562；模型手上于是同时有了「全部候选科目」「探索抓到的拆分」和「产出 unified rows 的系统提示」——**它把决策直接吐了出来**，23,656 个输出 token，205 秒。

而探索循环只认两种回复（`dimensionExploration.ts:37-47`）：

```ts
if (parsed.done === true) break;
const tool = parsed.tool !== undefined ? input.tools.get(parsed.tool) : undefined;
if (!tool) throw new Error(`unknown tool: ${String(parsed.tool)}`);
```

于是那份决策变成一行 `[EXPLORATION ERROR] unknown tool: undefined`。输出上限是 20 万 token（`anthropicProvider.ts:41`），23,656 远未触顶，所以它是自然结束的完整 JSON。随后 `requestDecision` 从头重做同一份工作。

**模型没有做错事。它在自己的第 2 阶段把第 4 阶段的活干了，因为那一刻它手上的输入和第 4 阶段拿到的是同一套。**阶段边界是我们画的线，模型看不见。

本设计把这两个 subagent 改成与 financial_modeling 同构的形态：**一个工具调用循环 + 一份它自己 invoke 的 agent 层 skill**，由它判断什么时候侦察、什么时候交付、什么时候打补丁。

## 2. 目标形态

```
run_dcf_subagent { subagent, modelId, task }
  └─ runPrivateSubagentLoop(definition, tools, task)
       每步：模型选一个工具调用；结果进对话；直到 finish 或步数用尽

       工具：invoke_skill / read_skill_reference          ← 取自己的方法论
             load_concept_inventory                        ← 工作集
             list_dimension_axes / get_axis_breakdown      ← 维度侦察（unification）
             submit_unification_decision                   ← 交付，宿主当场校验
             patch_unification_decision                    ← 增量修正
             finish
```

阶段消失，顺序由 skill 描述、由 agent 决定。宿主保留的是**校验**，不是**编排**。

## 3. 交付工具：把校验变成工具结果

这是整个改动的结构支点。现在完整性检查是宿主在循环里做、findings 通过下一次 `requestPatch` 的提示喂回去；改成工具之后，检查结果就是工具返回值：

```
submit_unification_decision { decision }
  → schema 校验失败：{ error: invalid_decision, message }         agent 下一步自己改
  → 校验通过：宿主跑 checkUnificationCompleteness(inventory, decision, requestedPeriods)
     findings 为空 → { status: "accepted", rows: N, breakdownRows: M }
     findings 非空 → { status: "incomplete", findings: [...] }     agent 决定补还是收工

patch_unification_decision { patch }
  → applyUnificationPatch(已提交的决策, patch)，再跑同一套校验，返回同样的形状
```

`checkUnificationCompleteness`（`unifiedStatements.ts:178`）与 `applyUnificationPatch`（`:65`）原样复用，一行不改。宿主仍然拿**自己建的** inventory 去核对——`statementUnificationAgent.ts:103-105` 的注释说明了为什么这份 copy 必须独立于 subagent 提供的东西，这条不变。

于是「最多 3 轮」从 `for` 循环变成 agent 看着 findings 自己判断，「补丁比重生成便宜」从代码结构变成 skill 里写明的纪律。

spine_mapping 同构：`submit_spine_decision` / `patch_spine_decision`。

## 4. skill 与归属

`DcfSubagentDefinition`（`subagents.ts:16-22`）加一个字段，与上一份 spec 给 `SubagentDefinition` 加 `skills` 同形：

```ts
export type DcfSubagentDefinition = {
  name: DcfSubagentKind;
  modelClass: ModelClass;
  authority: "read_only_proposal";
  prompt: string;        // 身份与授权：你是谁、你只提议不提交
  skills?: string[];     // 新增：方法论
};
```

`prompt` 保留为身份声明（`authority: "read_only_proposal"` 这类不可协商的东西），方法论迁进两份 agent 层 skill：

- `skills/statement-unification/` —— 概念清单怎么读、re-tag 与 restatement 怎么判、维度侦察什么时候值得做、决策怎么组织、findings 怎么修
- `skills/spine-mapping/` —— 同理

启动期校验复用 `assertSubagentSkills`（`skill.ts`），把 `DcfSubagentRegistry.list()` 一并传进去。

## 5. 四条结构保证怎么接住

写死的阶段虽然笨，但每一条都在守着东西。换成 agent 判断后，这些从**保证**降级为**倾向**——必须逐条给出接替方案，否则这次改动是拿正确性换优雅。

| 现在由什么保证 | 改后由什么接住 | 强度 |
| --- | --- | --- |
| 侦察上下文不含概念清单（起步 `in=2341`） | 清单只在 agent 调 `load_concept_inventory` 时才进上下文——这本来就是工具，不是预置 | 同等 |
| 侦察可失败而不拖垮 unification | skill 明写「侦察是增强不是前置」；侦察工具报错不终止循环 | 减弱，可接受 |
| 补丁比重生成便宜（决策 2.4 万 token） | skill 明写；成本由步数预算兜底 | 减弱，见下 |
| 8 步 / 3 轮硬上限 | **步数预算 15 轮**，一个数管住全部 | 同等 |

成本上界只有这一条：**私有 subagent 一次最多 15 轮**。不为「重复整份提交」单设机制——多一个计数器就是多一处要维护、要解释、会和步数预算打架的状态。重吐一次决策会吃掉预算的一大块，这个反馈本身就够直接。

按实测形态算，典型一轮 unification 用掉 8-10 步：

```
invoke_skill              1
load_concept_inventory    1
list_dimension_axes       1
get_axis_breakdown      2-3
submit_*                  1
patch_*                 1-2
finish                    1
──────────────────────────
合计                    8-10
```

15 轮留下 5-7 步余量，够吸收一次 schema 返工、一轮额外补丁，或一家维度比 AAPL 复杂的发行人。

余量存在不等于该花掉。两条纪律写进 skill，理由是职责而非预算：这两个 subagent 的活比 financial_modeling 窄得多（一个对齐概念、一个映射脊柱），所以 **skill 正文自足、不配 references**——需要翻 playbook 才说得清的方法论，说明它承担了不该承担的判断；**侦察至多取两三条轴**，沿用现有 `exploreInstruction` 里那条「Fetch at most 3 axes per statement line」。

## 6. 上下文与成本

一次 unification 的上下文峰值估算：

```
skill 正文                        ~3k
概念清单（调用后常驻）            ~23k
维度侦察结果（2-4 条拆分）        ~10k
已提交的决策                      ~24k
────────────────────────────────────
峰值                              ~60k
```

对 MEDIUM 档可接受，且比现状好：现状是探索 8 步各自 37-46k（实测第 7、8 两步合计八万多输入 token，产出为零），加上 `requestDecision` 独立的一次全量输入。

循环保留完整消息历史，不做投影——决策的作者需要看见清单原文，摘要会让它编。15 轮的预算是成本上界：最坏情况约 15 × 60k 输入，比现状略高，但现状那八万多 token 是零产出，这里每一轮都落在实事上。

## 7. 错误处理

| 场景 | 行为 |
| --- | --- |
| 侦察工具报错（漏参数等） | 结果喂回去，agent 下一步改（与现状一致，`dimensionExploration.ts:44-47` 已验证有效） |
| `submit_*` schema 不过 | 返回 `invalid_decision` 与校验器原文，agent 下一步自改 |
| `submit_*` 完整性有 findings | 返回 findings，agent 决定 patch 或 finish |
| 步数用尽仍未提交 | 宿主返回失败，`run_dcf_subagent` 报 `subagent_no_decision`——不再像现在那样「用尽轮次就带着 findings 发货」 |
| 步数用尽但已提交过 | 交付最后一次通过 schema 的决策，附未解决的 findings（保留现状 `statementUnificationAgent.ts:132` 的取舍：不丢弃几分钟的工作） |
| subagent 载入了错的发行人 | `wrongIssuer` 检查不变（`dcfSubagentTool.ts:55`），`load_concept_inventory` 仍设置 `loaded` |

## 8. 测试

- 私有循环：正常交付、schema 失败后自改、findings 后 patch、步数用尽两种分支
- `submit_*` 计数器：第 2 次带提示、第 4 次拒绝
- 侦察工具报错不终止循环
- skill 归属：两个私有 subagent 的 `skills` 在启动期校验
- 回归：给定同一批 AAPL extracts，新老路径产出的 unified rows 行数与 rowId 集合一致（用 `data/e2e-test/aapl/step1-extraction.json` 作输入，`step2-unified-statements.json` 作基准）

最后一条是这次改动唯一的正确性护栏，必须先写。

## 9. 影响面

| 文件 | 改动 |
| --- | --- |
| `src/agent/financial-modeling/statementUnificationAgent.ts` | 四个 LLM 入口 → 一个循环；保留 `buildUnifiedStatements` 等物化逻辑 |
| `src/agent/financial-modeling/spineMappingAgent.ts` | 同上 |
| `src/agent/financial-modeling/dimensionExploration.ts` | 删除（侦察变成普通工具调用） |
| `src/agent/financial-modeling/loadWorkingSet.ts` | 删除（载入变成普通工具调用） |
| `src/agent/financial-modeling/privateSubagentLoop.ts` | 新建 |
| `src/agent/financial-modeling/subagents.ts` | `DcfSubagentDefinition.skills` |
| `src/agent/prompts/dcfSubagentPrompts.ts` | 方法论迁出，`exploreInstruction` 删除 |
| `mcp_tools/financial-model/mappingSubagentTools.ts` | 新增 submit / patch 四个工具 |
| `skills/statement-unification/`、`skills/spine-mapping/` | 新建 |
| `scripts/xbrl/e2e_test/step2-unify.ts`、`step3-spine.ts` | 跟随新签名（**step8 不动**） |

## 10. 风险

- **最大的风险是回归而非设计**：unification 的产出（72 行 unified rows + 11 行拆分）是后面所有阶段的地基，一次悄悄变差的映射会一路传到估值。§8 最后那条对照测试是唯一的防线，必须先于改动写好。
- agent 可能把步数花在侦察上而不交付。步数预算兜底，但一次白跑的代价是整轮 unification。
- 两份 skill 的质量直接决定产出质量。现在的方法论散在 `dcfSubagentPrompts.ts` 和阶段顺序里，迁移时**编码在顺序里的知识最容易丢**——例如「先看轴再决定要不要拆」这件事，现在是靠 `exploreDimensions` 排在 `requestDecision` 前面保证的，迁移后必须在 skill 里说出来。
