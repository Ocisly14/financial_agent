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
/** A DCF round is not one lookup: 30 tool steps at several seconds of model time each, and
 *  `run_dcf_subagent` nests a whole agent (unification, spine mapping) inside a single step.
 *  Five minutes could not cover that, and the timeout does not cancel — the agent finished,
 *  wrote its own task_result, and the task already carried a timeout nobody could reconcile. */
const DCF_TASK_TIMEOUT_MS = 15 * 60_000;

/**
 * Ceiling on what one dispatch may hand forward. Not a view on how many results a
 * task should build on — the caller passes ids precisely because it cannot see
 * how large any of them is — but the point past which the receiving prompt stops
 * being a prompt. Over it the dispatch fails and says so, rather than arriving
 * truncated: a subagent reads what it is handed as complete.
 */
const MAX_HANDED_DATA_CHARS = 40_000;

/** Per-agent, because the right ceiling is a property of the work: a quote is seconds, a DCF round
 *  is many minutes. A caller's explicit `timeout_ms` still wins. */
export function taskTimeoutMs(request: TaskRequest): number {
  if (request.timeout_ms !== undefined) return request.timeout_ms;
  if (request.agent === "trading_operations") return DEFAULT_TRADE_TASK_TIMEOUT_MS;
  if (request.agent === "financial_modeling") return DCF_TASK_TIMEOUT_MS;
  return DEFAULT_TASK_TIMEOUT_MS;
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
  private readonly agentId: string;
  private skillSections: Partial<Record<AgentKind, string>> = {};
  private skillTools: string[] | undefined;
  private userInputAllowed = true;

  constructor(
    sessionId: string,
    subagents: SubagentRegistry,
    subagentRuntime: SubagentRuntime,
    tools: McpToolRegistry,
    state: SessionState,
    agentId: string,
  ) {
    this.sessionId = sessionId;
    this.subagents = subagents;
    this.subagentRuntime = subagentRuntime;
    this.tools = tools;
    this.state = state;
    this.agentId = agentId;
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
   * 激活的 skill 额外授予的工具。它只放宽 agent 自己的池，从不收窄——收窄那套
   * 已经删掉了：skill 是指导不是沙箱。真正的隔离仍在 toolAccess 的 category 门，
   * 并集里每个名字照样要过那道门。
   */
  setSkillTools(tools: string[] | undefined): void {
    this.skillTools = tools;
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
    const taskId = this.state.recordDispatch(request.agent, request.task, threadId).event_id;
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

  /** The event log should show the user's intent; only the subagent's input carries skill text. */
  private withSkillSection(request: TaskRequest): TaskRequest {
    const section = this.skillSections[request.agent];
    if (!section) return request;
    return { ...request, task: `${request.task}\n\n[SKILL GUIDANCE]\n${section}` };
  }

  private async runExistingTask(taskId: string, request: TaskRequest, threadId: string, handedData: string): Promise<void> {
    log.info(`dispatch → ${request.agent}`, { task: request.task, taskId, threadId });
    const definition = this.subagents.get(request.agent);
    let allowedTools: ToolDefinition[];
    try {
      allowedTools = this.resolveAllowedTools(request.agent, definition.defaultTools, request.tools);
    } catch (error) {
      // Unknown tool name, category mismatch, and anything else resolution can
      // throw share the generic task_failed path, so their handling stays
      // identical to a subagent-run failure.
      this.recordGenericFailure(request, taskId, error);
      return;
    }
    try {
      // The subagent writes its own task_result to state on success.
      await withTimeout(
        this.subagentRuntime.run(definition, {
          sessionId: this.sessionId,
          agentId: this.agentId,
          taskId,
          threadId,
          request: this.withSkillSection(request),
          handedData,
          allowedTools,
          state: this.state,
        }),
        taskTimeoutMs(request),
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
      log.warn(`timeout ← ${request.agent}`, { taskId, timeout_ms: taskTimeoutMs(request) });
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
    // The agent's own pool plus whatever the active skill grants. The union is
    // the upper bound for this dispatch — an explicit request may pick from it,
    // never past it.
    const granted = this.skillTools ? [...new Set([...pool, ...this.skillTools])] : pool;
    // The strip runs on the union, not on the pool: a skill that happens to
    // declare ask_user must not smuggle it past `userInputAllowed`, or a stream
    // with nobody watching would end its turn on a question against an empty seat.
    const available = this.userInputAllowed ? granted : granted.filter((name) => name !== "ask_user");
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
