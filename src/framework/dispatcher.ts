import type { McpToolRegistry } from "../../mcp_tools/toolRegistry.ts";
import type { SessionState } from "./sessionState.ts";
import { SubagentRegistry, SubagentRuntime } from "./subagent.ts";
import type { AgentKind, TaskRequest, TaskResult, ToolDefinition } from "./types.ts";
import { createLogger } from "../infra/logger/logger.ts";
import { assertToolAllowedForAgent } from "./toolAccess.ts";

const log = createLogger("dispatcher");
const DEFAULT_TASK_TIMEOUT_MS = 60_000;
const DEFAULT_TRADE_TASK_TIMEOUT_MS = 16 * 60_000;

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

  private async runExistingTask(taskId: string, request: TaskRequest): Promise<void> {
    log.info(`dispatch → ${request.agent}`, { task: request.task, taskId });
    try {
      const definition = this.subagents.get(request.agent);
      const allowedTools = this.resolveAllowedTools(request.agent, definition.defaultTools, request.tools);
      // The subagent writes its own task_result to state on success.
      await withTimeout(
        this.subagentRuntime.run(definition, {
          sessionId: this.sessionId,
          taskId,
          request,
          allowedTools,
          state: this.state,
          parentEventId: taskId,
        }),
        request.timeout_ms ?? (request.agent === "trading_operations" ? DEFAULT_TRADE_TASK_TIMEOUT_MS : DEFAULT_TASK_TIMEOUT_MS),
      );
      log.info(`done ← ${request.agent}`, { taskId });
    } catch (error) {
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
  }

  private resolveAllowedTools(agent: AgentKind, defaultTools: string[], requestedTools?: string[]): ToolDefinition[] {
    const defaultSet = new Set(defaultTools);
    const names = requestedTools ?? defaultTools;

    return names.map((name) => {
      if (!defaultSet.has(name)) {
        throw new Error(`tool ${name} is not in default tool pool for ${agent}`);
      }
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
