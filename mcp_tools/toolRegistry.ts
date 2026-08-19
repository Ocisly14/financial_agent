// Canonical registry shared by the framework and all mcp_tools/* handlers.
import type { JsonObject, ToolDefinition, ToolExecutionResult } from "../src/framework/types.ts";

export type ToolExecutionContext = {
  sessionId: string;
  /** Authenticated owner propagated by the HTTP/runtime boundary. */
  tenantId: string;
  taskId?: string;
  /**
   * Which agents are running, root first, joined by ">" — e.g. "financial_modeling>market_research".
   * Absent at the root: HTTP routes and the orchestrator have no chain above them.
   *
   * This is an execution identity, not an owner: `tenantId` says whose data this is and is the same
   * value the whole way down, while this says who is asking right now.
   */
  agentPath?: string;
};

export type ToolHandler = (input: JsonObject, context: ToolExecutionContext) => Promise<ToolExecutionResult>;

export type RegisteredTool = ToolDefinition & {
  execute: ToolHandler;
};

export class McpToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register(tool: RegisteredTool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`duplicate tool registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()].map(({ execute: _execute, ...definition }) => definition);
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  async call(name: string, input: JsonObject, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`tool not found: ${name}`);
    return tool.execute(input, context);
  }
}

/**
 * Per-task working state for tools that carry a conversation across steps — a draft decision, a
 * loaded working set. One entry per dispatched task, keyed by `runKey` from the execution context
 * every tool call carries, so ANY agent's tools get the same facility: no tool module hand-rolls
 * its own map, and no state leaks between two runs that happen to share a process.
 *
 * Bounded FIFO: a run's state is garbage the moment its task_result is written, but nothing tells
 * the tool that, so the store caps itself instead.
 */
const RUN_STATE_CAP = 16;
export function runStateStore<T>(): { get: (key: string) => T | undefined; set: (key: string, value: T) => void } {
  const states = new Map<string, T>();
  return {
    get: (key) => states.get(key),
    set: (key, value) => {
      states.delete(key);
      states.set(key, value);
      while (states.size > RUN_STATE_CAP) states.delete(states.keys().next().value!);
    },
  };
}

export const runKey = (context: ToolExecutionContext): string => context.taskId ?? context.sessionId;
