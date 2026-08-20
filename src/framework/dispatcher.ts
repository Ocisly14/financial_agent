import type { McpToolRegistry } from "../../mcp_tools/toolRegistry.ts";
import type { SessionState } from "./sessionState.ts";
import { SubagentRegistry, SubagentRuntime } from "./subagent.ts";
import type { AgentKind, TaskRequest, TaskResult, ToolDefinition } from "./types.ts";
import { createLogger } from "../infra/logger/logger.ts";

const log = createLogger("dispatcher");
/** A research task routinely takes three or four LLM rounds with advanced web
 *  search; at 60s those were being killed a few seconds before they finished,
 *  and the completed work was discarded because there is no cancellation — the
 *  subagent ran on, answered, and nobody was listening. */
const DEFAULT_TASK_TIMEOUT_MS = 5 * 60_000;

/**
 * Ceiling on what one dispatch may hand forward. Not a view on how many results a
 * task should build on — the caller passes ids precisely because it cannot see
 * how large any of them is — but the point past which the receiving prompt stops
 * being a prompt. Over it the dispatch fails and says so, rather than arriving
 * truncated: a subagent reads what it is handed as complete.
 */
const MAX_HANDED_DATA_CHARS = 40_000;

/** Per-agent, because the right ceiling is a property of the work: a quote is seconds, a DCF round
 *  is many minutes. The agent's own ceiling comes from its topology node; a caller's explicit
 *  `timeout_ms` still wins, and the timeout does not cancel — a late finisher still writes its own
 *  task_result, which the first-writer-wins guard then ignores. */
export function taskTimeoutMs(request: TaskRequest, definition?: { taskTimeoutMs?: number }): number {
  return request.timeout_ms ?? definition?.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
}

/**
 * Thrown when a caller names something this dispatch cannot resolve: a thread
 * this session never opened or one belonging to another agent, or a result id
 * whose data is not there to hand forward.
 *
 * Every one of these fails the task instead of quietly proceeding without the
 * thing that was named. Running anyway is the failure you cannot see: the run
 * succeeds, the caller believes the work continued from where it said, and what
 * was actually missing — the earlier rounds, the data the task was written
 * around — is simply gone from it.
 */
class DispatchError extends Error {
  readonly code: "thread_not_found" | "thread_agent_mismatch" | "data_ref_not_found" | "data_ref_too_large";
  constructor(code: DispatchError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

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
  private readonly tenantId: string;
  private userInputAllowed = true;
  private readonly parentPath: readonly AgentKind[];
  private readonly parentTaskId: string | undefined;

  constructor(
    sessionId: string,
    subagents: SubagentRegistry,
    subagentRuntime: SubagentRuntime,
    tools: McpToolRegistry,
    state: SessionState,
    tenantId: string,
    /** The agents already running above the tasks this dispatcher will start. Empty at the top:
     *  the orchestrator is the root. A delegating agent passes its own chain. */
    parentPath: readonly AgentKind[] = [],
    /** The dispatch event id of the run this dispatcher acts for — the caller's own task. Absent at
     *  the top: an orchestrator dispatch has no caller. */
    parentTaskId?: string,
  ) {
    this.sessionId = sessionId;
    this.subagents = subagents;
    this.subagentRuntime = subagentRuntime;
    this.tools = tools;
    this.state = state;
    this.tenantId = tenantId;
    this.parentPath = parentPath;
    this.parentTaskId = parentTaskId;
  }

  /**
   * Mirrors the orchestrator's own `allowUserInput`: when a caller declares
   * that no human is watching this stream, a question would end the turn
   * against an empty seat and stall that caller until its timeout. So
   * `ask_user` is removed from every pool before the subagent ever sees it.
   * (A Research driving a member Topic deliberately leaves this on — the
   * controller relays the member's question to the user itself.)
   */
  setUserInputAllowed(allowed: boolean): void {
    this.userInputAllowed = allowed;
  }

  async dispatch(tasks: TaskRequest[]): Promise<void> {
    await Promise.all(tasks.map((task) => this.runTask(task)));
  }

  dispatchAsync(tasks: TaskRequest[]): { task_id: string }[] {
    return tasks.map((request) => {
      const opened = this.recordDispatch(request);
      if (!opened.error) void this.runExistingTask(opened.taskId, request, opened.threadId, opened.handedData);
      return { task_id: opened.taskId };
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
    const opened = this.recordDispatch(request);
    if (opened.error) return;
    await this.runExistingTask(opened.taskId, request, opened.threadId, opened.handedData);
  }

  /**
   * One task, run to completion, with its outcome returned rather than only logged.
   *
   * The other entry points report through the session log because the orchestrator reads results
   * there. An agent delegating to another agent is blocked inside a tool call and needs the outcome
   * in hand — and needs `threadId`, which no TaskResult carries, because that is the handle it must
   * quote to continue the same conversation next round.
   */
  async runOne(request: TaskRequest): Promise<{ taskId: string; threadId: string; result: TaskResult }> {
    const opened = this.recordDispatch(request);
    if (!opened.error) {
      await this.runExistingTask(opened.taskId, request, opened.threadId, opened.handedData);
    }
    // Every path above writes a task_result — recordDispatch on a bad thread name, the runtime on
    // its own, recordGenericFailure on a throw or timeout. Synthesized rather than asserted anyway:
    // compaction runs inside the callee, and a future change there that evicted the dispatch event
    // would turn a non-null assertion into a crash inside the caller's tool call.
    const result = this.state.task(opened.taskId)?.result ?? {
      task_id: opened.taskId,
      agent: request.agent,
      status: "failed" as const,
      summary: "Delegated task produced no result.",
      error: { code: "task_failed", message: "Delegated task produced no result." },
    };
    return { taskId: opened.taskId, threadId: opened.threadId, result };
  }

  /**
   * Settle which conversation this task runs in, then record the dispatch —
   * whose event id is the task id.
   *
   * A bad thread name still gets a dispatch event and a fresh (empty) thread:
   * the dispatch really happened and the caller needs to see it fail, and every
   * thread id that reaches `liveThreads()` should be one a later dispatch could
   * legitimately name.
   *
   * Runs synchronously, which is what keeps two tasks sent to the same agent in
   * one step from sharing a thread number — see SessionState.openThread.
   */
  private recordDispatch(request: TaskRequest): { taskId: string; threadId: string; handedData: string; error?: DispatchError } {
    let threadId: string | undefined;
    let handedData = "";
    let error: DispatchError | undefined;
    try {
      threadId = this.resolveThread(request);
      handedData = this.renderHandedData(request);
    } catch (thrown) {
      if (!(thrown instanceof DispatchError)) throw thrown;
      error = thrown;
    }
    threadId ??= this.state.openThread(request.agent);
    const parentAgent = this.parentPath.at(-1);
    const parent = this.parentTaskId
      ? { taskId: this.parentTaskId, ...(parentAgent ? { agent: parentAgent } : {}) }
      : undefined;
    const taskId = this.state.recordDispatch(request.agent, request.task, threadId, parent).event_id;
    if (error) {
      log.warn(`bad dispatch ← ${request.agent}`, { taskId, thread: request.thread, code: error.code });
      this.state.recordTaskResult(request.agent, taskId, {
        task_id: taskId,
        agent: request.agent,
        status: "failed",
        summary: error.message,
        error: { code: error.code, message: error.message },
      });
    }
    return { taskId, threadId, handedData, ...(error ? { error } : {}) };
  }

  /** Continue the named thread, or open a new one when none was named. */
  private resolveThread(request: TaskRequest): string {
    if (!request.thread) return this.state.openThread(request.agent);
    const owner = this.state.threadOwner(request.thread);
    if (!owner) {
      throw new DispatchError("thread_not_found",
        `no thread ${request.thread} in this topic; omit "thread" to start a new one`);
    }
    if (owner !== request.agent) {
      throw new DispatchError("thread_agent_mismatch",
        `thread ${request.thread} belongs to ${owner}, not ${request.agent}`);
    }
    return request.thread;
  }

  /**
   * Resolve `source_event_ids` into the block the subagent reads before its
   * progress. The caller names results by the id printed on their result lines
   * and the data travels out of the log verbatim — no model retypes a number to
   * move it between two agents.
   *
   * What travels is only the data. Why it matters to THIS task is not in the
   * payload and cannot be inferred from it, so it still belongs in `task`.
   */
  private renderHandedData(request: TaskRequest): string {
    const ids = request.source_event_ids ?? [];
    if (ids.length === 0) return "";
    const blocks: string[] = [];
    const missing: string[] = [];
    for (const id of ids) {
      const found = this.state.taskResultData(id);
      // The receiving agent has never seen this result: whose work it is and
      // what it concluded are as much a part of reading it as the data itself.
      if (found) blocks.push(`[from ${found.agent} — ${found.summary}]\n${JSON.stringify(found.data)}`);
      else missing.push(id);
    }
    if (missing.length > 0) {
      throw new DispatchError("data_ref_not_found",
        `no task result carrying data for ${missing.join(", ")} in this topic; use a source_event_id printed on a result line`);
    }
    const rendered = blocks.join("\n\n");
    if (rendered.length > MAX_HANDED_DATA_CHARS) {
      throw new DispatchError("data_ref_too_large",
        `those ${ids.length} results carry ${rendered.length} characters, over the ${MAX_HANDED_DATA_CHARS}-character handoff limit;`
        + ` hand over fewer of them and state what matters from the rest in the task`);
    }
    return `[DATA HANDED TO YOU]\nResults from earlier work this task builds on, verbatim. Treat them as given.\n${rendered}\n\n`;
  }

  private async runExistingTask(taskId: string, request: TaskRequest, threadId: string, handedData: string): Promise<void> {
    log.info(`dispatch → ${request.agent}`, { task: request.task, taskId, threadId });
    const definition = this.subagents.get(request.agent);
    let allowedTools: ToolDefinition[];
    try {
      allowedTools = this.resolveAllowedTools(request.agent, definition.defaultTools, request.tools);
    } catch (error) {
      // Unknown tool name and anything else resolution can throw share the generic task_failed
      // path, so their handling stays identical to a subagent-run failure.
      this.recordGenericFailure(request, taskId, error);
      return;
    }
    try {
      // The subagent writes its own task_result to state on success.
      await withTimeout(
        this.subagentRuntime.run(definition, {
          sessionId: this.sessionId,
          tenantId: this.tenantId,
          taskId,
          threadId,
          request,
          handedData,
          allowedTools,
          state: this.state,
          agentPath: this.parentPath,
        }),
        taskTimeoutMs(request, definition),
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
      log.warn(`timeout ← ${request.agent}`, { taskId, timeout_ms: taskTimeoutMs(request, this.subagents.get(request.agent)) });
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

  private resolveAllowedTools(agent: AgentKind, pool: string[], requestedTools?: string[]): ToolDefinition[] {
    // The pool IS the upper bound: what an agent may reach is declared on its topology node and
    // nowhere else. (Skills used to widen this per turn; that grant was a capability side-channel
    // around the topology and is gone — a skill guides its reader, it does not arm anyone.)
    const available = this.userInputAllowed ? pool : pool.filter((name) => name !== "ask_user");
    const availableSet = new Set(available);
    let names: string[];

    if (requestedTools) {
      for (const name of requestedTools) {
        if (!availableSet.has(name)) {
          throw new Error(`tool ${name} is not available to ${agent} for this task`);
        }
      }
      names = requestedTools;
    } else {
      names = available;
    }

    return names.map((name) => {
      const tool = this.tools.get(name);
      if (!tool) throw new Error(`tool not registered: ${name}`);
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
