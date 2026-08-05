import type { McpToolRegistry } from "../../mcp_tools/toolRegistry.ts";
import type { SessionState } from "./sessionState.ts";
import { SubagentRegistry, SubagentRuntime } from "./subagent.ts";
import type { AgentKind, TaskRequest, TaskResult, ToolDefinition } from "./types.ts";
import { createLogger } from "../infra/logger/logger.ts";
import { assertToolAllowedForAgent } from "./toolAccess.ts";

const log = createLogger("dispatcher");
/** A research task routinely takes three or four LLM rounds with advanced web
 *  search; at 60s those were being killed a few seconds before they finished,
 *  and the completed work was discarded because there is no cancellation — the
 *  subagent ran on, answered, and nobody was listening. */
const DEFAULT_TASK_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_TRADE_TASK_TIMEOUT_MS = 16 * 60_000;

/**
 * Thrown when a caller explicitly requested (via `request.tools`) a tool the
 * active skill's `tools:` frontmatter does not declare. Kept as a distinct
 * type — rather than a plain Error — so runExistingTask's catch can surface
 * the `tool_not_allowed` code from spec §8 instead of the generic
 * `task_failed` it uses for every other thrown error.
 */
class ToolNotAllowedError extends Error {}

/**
 * Thrown when a skill's `tools:` list and the agent's own pool have nothing in
 * common. Distinct from ToolNotAllowedError because the cause is different — a
 * malformed skill declaration rather than an over-reaching request — and the
 * orchestrator should be able to tell them apart.
 */
class NoToolsAvailableError extends Error {}

/**
 * Spawns subagent runs. The subagent writes its own `task_result` to the session
 * log on success; the dispatcher writes a failure/timeout `task_result` only when
 * the subagent throws or times out. Nothing is returned — callers read results
 * from the session state (e.g. state.turnResults / state.task).
 */
export class Dispatcher {
  private readonly sessionId: string;
  private readonly subagents: SubagentRegistry;
  private readonly subagentRuntime: SubagentRuntime;
  private readonly tools: McpToolRegistry;
  private readonly state: SessionState;
  private skillSections: Partial<Record<AgentKind, string>> = {};
  private skillAllowance: { agents?: AgentKind[]; tools?: string[] } = {};

  constructor(
    sessionId: string,
    subagents: SubagentRegistry,
    subagentRuntime: SubagentRuntime,
    tools: McpToolRegistry,
    state: SessionState,
  ) {
    this.sessionId = sessionId;
    this.subagents = subagents;
    this.subagentRuntime = subagentRuntime;
    this.tools = tools;
    this.state = state;
  }

  /**
   * 当前 turn 激活的 skill 的定向指导。orchestrator 每轮新建一个 Dispatcher，
   * 所以这份状态活不过这个 turn——skill 的单 turn 生命周期由此而来，不需要
   * 额外的清理逻辑。
   */
  setSkillSections(sections: Partial<Record<AgentKind, string>>): void {
    this.skillSections = sections;
  }

  /**
   * 激活的 skill 的工作范围（agents / tools 白名单）。叠加在 toolAccess 的
   * category 隔离之上，不取代它——两者都必须成立才放行。
   */
  setSkillAllowance(allowance: { agents?: AgentKind[]; tools?: string[] }): void {
    this.skillAllowance = allowance;
  }

  async dispatch(tasks: TaskRequest[]): Promise<void> {
    await Promise.all(tasks.map((task) => this.runTask(task)));
  }

  dispatchAsync(tasks: TaskRequest[]): { task_id: string }[] {
    return tasks.map((request) => {
      const taskId = this.recordDispatch(request);
      void this.runExistingTask(taskId, request);
      return { task_id: taskId };
    });
  }

  async awaitTask(taskIds: string[], timeoutMs = 60_000): Promise<TaskResult[]> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const tasks = taskIds.map((taskId) => this.state.task(taskId));
      if (tasks.every((task) => task && task.status !== "running")) {
        return taskIds.map((taskId) => this.state.task(taskId)!.result!);
      }
      await sleep(25);
    }
    return taskIds.map((taskId) => ({
      task_id: taskId,
      agent: this.state.task(taskId)?.agent ?? "market_data",
      status: "timeout",
      summary: "Timed out waiting for async task.",
      error: { code: "await_timeout", message: "Timed out waiting for async task." },
    }));
  }

  private async runTask(request: TaskRequest): Promise<void> {
    const taskId = this.recordDispatch(request);
    await this.runExistingTask(taskId, request);
  }

  /** Record the dispatch event; its id is the task id. */
  private recordDispatch(request: TaskRequest): string {
    return this.state.recordDispatch(request.agent, request.task).event_id;
  }

  /** The event log should show the user's intent; only the subagent's input carries skill text. */
  private withSkillSection(request: TaskRequest): TaskRequest {
    const section = this.skillSections[request.agent];
    if (!section) return request;
    return { ...request, task: `${request.task}\n\n[SKILL GUIDANCE]\n${section}` };
  }

  private async runExistingTask(taskId: string, request: TaskRequest): Promise<void> {
    log.info(`dispatch → ${request.agent}`, { task: request.task, taskId });
    const allowedAgents = this.skillAllowance.agents;
    if (allowedAgents && !allowedAgents.includes(request.agent)) {
      const message = `agent ${request.agent} is outside the active skill's declared agents`;
      this.state.recordTaskResult(request.agent, taskId, {
        task_id: taskId,
        agent: request.agent,
        status: "failed",
        summary: message,
        error: { code: "agent_not_allowed", message },
      });
      return;
    }
    const definition = this.subagents.get(request.agent);
    let allowedTools: ToolDefinition[];
    try {
      allowedTools = this.resolveAllowedTools(request.agent, definition.defaultTools, request.tools);
    } catch (error) {
      if (error instanceof ToolNotAllowedError || error instanceof NoToolsAvailableError) {
        const code = error instanceof ToolNotAllowedError ? "tool_not_allowed" : "no_tools_available";
        this.state.recordTaskResult(request.agent, taskId, {
          task_id: taskId,
          agent: request.agent,
          status: "failed",
          summary: error.message,
          error: { code, message: error.message },
        });
        return;
      }
      // Any other resolution failure (unknown tool name, category mismatch, etc.)
      // is not a skill-allowance refusal — fall through to the generic task_failed
      // path below so its handling stays identical to a subagent-run failure.
      this.recordGenericFailure(request, taskId, error);
      return;
    }
    try {
      // The subagent writes its own task_result to state on success.
      await withTimeout(
        this.subagentRuntime.run(definition, {
          sessionId: this.sessionId,
          taskId,
          request: this.withSkillSection(request),
          allowedTools,
          state: this.state,
          parentEventId: taskId,
        }),
        request.timeout_ms ?? (request.agent === "trading_operations" ? DEFAULT_TRADE_TASK_TIMEOUT_MS : DEFAULT_TASK_TIMEOUT_MS),
      );
      log.info(`done ← ${request.agent}`, { taskId });
    } catch (error) {
      this.recordGenericFailure(request, taskId, error);
    }
  }

  /** Shared timeout/task_failed classification for any error not already handled by a more specific refusal path. */
  private recordGenericFailure(request: TaskRequest, taskId: string, error: unknown): void {
    const isTimeout = error instanceof Error && error.message === "timeout";
    if (isTimeout) {
      log.warn(`timeout ← ${request.agent}`, { taskId, timeout_ms: request.timeout_ms ?? (request.agent === "trading_operations" ? DEFAULT_TRADE_TASK_TIMEOUT_MS : DEFAULT_TASK_TIMEOUT_MS) });
    } else {
      log.error(`failed ← ${request.agent}`, { taskId, error: error instanceof Error ? error.message : String(error) });
    }
    const result: TaskResult = {
      task_id: taskId,
      agent: request.agent,
      status: isTimeout ? "timeout" : "failed",
      summary: isTimeout ? "Task timed out." : "Task failed.",
      error: {
        code: isTimeout ? "timeout" : "task_failed",
        message: error instanceof Error ? error.message : String(error),
      },
    };
    this.state.recordTaskResult(request.agent, taskId, result);
  }

  private resolveAllowedTools(agent: AgentKind, defaultTools: string[], requestedTools?: string[]): ToolDefinition[] {
    const defaultSet = new Set(defaultTools);
    const skillTools = this.skillAllowance.tools;
    let names: string[];

    if (requestedTools) {
      // An explicit request must stay inside both the agent's own pool and the
      // skill's declared list — the skill list narrows, it never widens.
      for (const name of requestedTools) {
        if (!defaultSet.has(name)) {
          throw new Error(`tool ${name} is not in default tool pool for ${agent}`);
        }
        if (skillTools && !skillTools.includes(name)) {
          throw new ToolNotAllowedError(`tool ${name} is outside the active skill's declared tools`);
        }
      }
      names = requestedTools;
    } else {
      // No explicit request: the skill narrows the agent's default pool down to
      // the intersection rather than throwing on the first pool member it
      // doesn't mention (that would fail the whole task for using its own
      // defaults).
      names = skillTools ? defaultTools.filter((name) => skillTools.includes(name)) : defaultTools;
      if (skillTools && names.length === 0) {
        // Running anyway would hand the agent no way to look anything up, and it
        // would still answer — from prose alone, returning `ok`. Nothing in the
        // session log would distinguish that from a grounded answer. The realistic
        // cause is a typo in the skill's `tools:` list, so say so where the
        // orchestrator can see it rather than only in the server log.
        throw new NoToolsAvailableError(
          `the active skill's declared tools do not overlap ${agent}'s pool (skill: ${skillTools.join(", ") || "none"}; pool: ${defaultTools.join(", ")})`,
        );
      }
    }

    return names.map((name) => {
      const tool = this.tools.get(name);
      if (!tool) throw new Error(`tool not registered: ${name}`);
      assertToolAllowedForAgent(agent, name, tool.category);
      const { execute: _execute, ...definition } = tool;
      return definition;
    });
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
