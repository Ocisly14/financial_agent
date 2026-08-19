import type { RegisteredTool } from "../../mcp_tools/toolRegistry.ts";
import type { Dispatcher } from "./dispatcher.ts";
import type { SessionState } from "./sessionState.ts";
import type { AgentKind, DelegationPolicy, JsonObject, JsonSchema, TaskRequest } from "./types.ts";
import { isAgentKind } from "./types.ts";

export const DELEGATE_TO_AGENT = "delegate_to_agent";

/**
 * Builds the Dispatcher one delegated call runs through. `parentPath` is the chain above the
 * callee, so the callee's own runs know who is above them.
 */
export type DispatcherFactory = (
  sessionId: string,
  tenantId: string,
  state?: SessionState,
  parentPath?: readonly AgentKind[],
  parentTaskId?: string,
) => Dispatcher;

/**
 * The shape assertAgentTopology reads. Structural rather than `SubagentDefinition` so this module
 * never imports subagent.ts — which imports this one for the roster gate.
 */
export type TopologyNode = {
  name: AgentKind;
  defaultTools: string[];
  delegatesTo?: AgentKind[];
  delegable?: DelegationPolicy;
};

/**
 * Fail-fast on a topology that cannot work, at startup, before any agent runs.
 *
 * Collects every fault and throws once, unlike `assertSubagentSkills`. A startup fault is read by
 * a human, once: first-fault reporting turns one bad edit to the topology into one restart per
 * fault, and the second fault is usually the same typo as the first.
 */
export function assertAgentTopology(
  nodes: readonly TopologyNode[],
  delegationTool: string,
  /** When given, every declared tool name must resolve through it. This is what makes the topology's
   *  tool lists REAL: a name nothing registered is a capability that silently is not there, and an
   *  agent whose declared pool cannot be granted re-derives the missing work by hand until its step
   *  budget runs out. Callers that register tools after construction pass this once registration is
   *  done. */
  toolExists?: (name: string) => boolean,
): void {
  const byName = new Map(nodes.map((node) => [node.name, node]));
  const faults: string[] = [];

  for (const node of nodes) {
    const roster = node.delegatesTo ?? [];
    const carriesTool = node.defaultTools.includes(delegationTool);

    if (toolExists) {
      for (const name of node.defaultTools) {
        if (!toolExists(name)) faults.push(`${node.name} declares tool '${name}', which is not registered`);
      }
    }

    // The roster and the tool are two halves of one capability, and either half alone fails
    // silently: a roster with no tool is an agent told it may delegate and given no way to,
    // and a tool with no roster is an agent that can only ever be refused.
    if (roster.length > 0 && !carriesTool) {
      faults.push(`${node.name} declares delegatesTo but its defaultTools lack ${delegationTool}`);
    }
    if (roster.length === 0 && carriesTool) {
      faults.push(`${node.name} carries ${delegationTool} but declares no delegatesTo`);
    }

    const seen = new Set<AgentKind>();
    for (const target of roster) {
      if (seen.has(target)) faults.push(`${node.name} lists ${target} twice in delegatesTo`);
      seen.add(target);

      if (target === node.name) {
        faults.push(`${node.name} delegates to itself`);
        continue;
      }
      const targetNode = byName.get(target);
      if (!targetNode) {
        faults.push(`${node.name} delegates to unknown agent '${target}'`);
        continue;
      }
      // `delegable` is the whole gate on being reached: an agent that never opted in cannot be
      // handed work by another agent, whatever the caller declares. That is what keeps
      // trading_operations — which raises approvals a blocked caller has no way to wait on — out
      // of everyone's roster.
      if (!targetNode.delegable) {
        faults.push(`${node.name} delegates to ${target}, which declares no delegable policy`);
      }
    }
  }

  for (const cycle of findCycles(nodes)) {
    faults.push(`delegation cycle: ${[...cycle, cycle[0]].join(" → ")}`);
  }

  if (faults.length > 0) {
    throw new Error(`agent topology is invalid:\n- ${faults.join("\n- ")}`);
  }
}

/**
 * Every cycle reachable in the delegation graph, each reported once. Three-colour DFS; on a grey
 * hit the path is sliced from the repeated node, then rotated to start at its smallest member so
 * A→B→A and B→A→B are recognised as the same cycle.
 */
function findCycles(nodes: readonly TopologyNode[]): AgentKind[][] {
  const edges = new Map(nodes.map((node) => [node.name, node.delegatesTo ?? []]));
  const state = new Map<AgentKind, "grey" | "black">();
  const found = new Map<string, AgentKind[]>();
  const path: AgentKind[] = [];

  const walk = (name: AgentKind): void => {
    const colour = state.get(name);
    if (colour === "black") return;
    if (colour === "grey") {
      const cycle = path.slice(path.indexOf(name));
      const pivot = cycle.indexOf([...cycle].sort()[0]!);
      const normalized = [...cycle.slice(pivot), ...cycle.slice(0, pivot)];
      found.set(normalized.join(">"), normalized);
      return;
    }
    state.set(name, "grey");
    path.push(name);
    for (const next of edges.get(name) ?? []) {
      // Unknown and self edges are reported as their own faults; walking them would either
      // crash or report a one-node "cycle" that says nothing the self-delegation fault does not.
      if (next !== name && edges.has(next)) walk(next);
    }
    path.pop();
    state.set(name, "black");
  };

  for (const node of nodes) walk(node.name);
  return [...found.values()];
}

/** The delegates an agent may reach, rendered for its prompt. Names from the definition, descriptions
 *  from the registry — the same split as the skill roster. */
export function renderDelegationRoster(
  roster: readonly AgentKind[] | undefined,
  describe: (name: AgentKind) => string | undefined,
): string {
  const names = roster ?? [];
  if (names.length === 0) return "(none)";
  return names.flatMap((name) => {
    const description = describe(name);
    return description ? [`- ${name}: ${description}`] : [];
  }).join("\n");
}

const DELEGATE_INPUT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["agent", "task"],
  properties: {
    agent: {
      type: "string",
      description: "Which of your delegates to hand this to, by the name in your delegate roster. A name outside it is refused.",
    },
    task: {
      type: "string",
      description:
        "What the work is for, in your own words: the issuer or market, the horizon, what this task needs settled, "
        + "and on a follow-up round the shortfall to address. Not a list of sources to check or queries to run — the "
        + "delegate picks its own tools, and a task that enumerates them reads as the whole scope of the job.",
    },
    thread: {
      type: "string",
      description:
        "Continue a conversation you already have with this delegate, by the thread id its previous result printed. "
        + "Omit to start a fresh one. A thread that does not exist, or belongs to a different agent, fails the call "
        + "rather than silently starting over.",
    },
    model_id: {
      type: "string",
      description: "Financial model handle carried into the delegate's prompt as its continuation point. Only meaningful when the delegate is financial_modeling.",
    },
    source_event_ids: {
      type: "array",
      items: { type: "string" },
      description:
        "Ids of earlier task results whose data this task needs verbatim, copied from result lines you have seen. "
        + "The data travels out of the log untyped by any model; why it matters to THIS task still belongs in `task`. "
        + "An id that names nothing fails the call rather than running without the data it was written around.",
    },
  },
};

/**
 * Hand one task to another agent and wait for its account of the work.
 *
 * Everything that makes a dispatch safe — the timeout, the failure task_result,
 * resolving the callee's own tool pool, thread continuation — lives in Dispatcher, so this runs
 * through Dispatcher rather than reaching for SubagentRuntime directly. The two DCF mapping agents
 * predate that and call the runtime by hand; the price is that a throw inside one leaves its
 * dispatch with no task_result, so the thread reads as running forever.
 *
 * Ownership is NOT checked here. `execute` is a pure (input, context) and cannot know which agent
 * called it, so the roster gate lives in SubagentRuntime.runToolCall beside the invoke_skill one.
 */
export function createDelegateToAgentTool(deps: {
  describe: (name: AgentKind) => string | undefined;
  policyFor: (name: AgentKind) => DelegationPolicy | undefined;
  delegableNames: () => AgentKind[];
  dispatchers: DispatcherFactory;
}): RegisteredTool {
  return {
    name: DELEGATE_TO_AGENT,
    description:
      "Hand one task to another agent and wait for its account of the work. It runs its own rounds with its own "
      + "tools and reports back in prose; you get what it concluded, not the evidence it read to get there.",
    // No domain of its own, like the skill framework tools: gating delegation by domain would mean
    // a trading agent could never delegate even to another trading agent. The domain invariant is
    // kept by assertAgentTopology refusing any edge that crosses the boundary.
    category: "main",
    inputSchema: DELEGATE_INPUT_SCHEMA,
    async execute(input: JsonObject, context) {
      const requested = typeof input["agent"] === "string" ? input["agent"].trim() : "";
      const task = typeof input["task"] === "string" ? input["task"].trim() : "";
      const thread = typeof input["thread"] === "string" && input["thread"].trim() ? input["thread"].trim() : undefined;

      if (!task) return refuse("invalid_tool_input", "task is required.");
      if (!isAgentKind(requested)) {
        return refuse("unknown_agent", `Unknown agent: ${requested}. Delegable agents: ${deps.delegableNames().join(", ") || "(none)"}.`);
      }
      const policy = deps.policyFor(requested);
      if (!policy) {
        return refuse("agent_not_delegable", `${requested} does not accept delegated work. Delegable agents: ${deps.delegableNames().join(", ") || "(none)"}.`);
      }
      // Runtime half of the cycle guard. assertAgentTopology proves the declared graph is acyclic,
      // which is what makes this unreachable — but the path is the only thing that would notice a
      // cycle formed some other way, and noticing costs one comparison.
      const parentPath = parseAgentPath(context.agentPath);
      if (parentPath.includes(requested)) {
        return refuse("delegation_cycle", `${requested} is already running above you (${[...parentPath, requested].join(" > ")}).`);
      }

      const dispatcher = deps.dispatchers(context.sessionId, context.tenantId, undefined, parentPath, context.taskId);
      // A nested question has nowhere to go: ask_user ends the callee's turn and is resumed by the
      // ORCHESTRATOR re-dispatching that thread, while this caller is blocked inside execute. The
      // question would reach the user, the caller would hang to its timeout, and the answer would
      // land on a thread nobody is waiting on.
      dispatcher.setUserInputAllowed(false);

      const modelId = typeof input["model_id"] === "string" && input["model_id"].trim() ? input["model_id"].trim() : undefined;
      const sourceEventIds = Array.isArray(input["source_event_ids"])
        ? input["source_event_ids"].filter((id): id is string => typeof id === "string" && id.trim() !== "").map((id) => id.trim())
        : [];
      const request: TaskRequest = {
        agent: requested,
        task,
        ...(thread ? { thread } : {}),
        ...(modelId ? { model_id: modelId } : {}),
        ...(sourceEventIds.length > 0 ? { source_event_ids: sourceEventIds } : {}),
        timeout_ms: policy.timeoutMs,
      };
      const { taskId, threadId, result } = await dispatcher.runOne(request);

      const delegation: JsonObject = {
        agent: requested,
        thread: threadId,
        task_id: taskId,
        status: result.status,
        summary: result.summary,
      };
      // The default withholds the callee's generation_context on purpose: for any agent but
      // financial_modeling that is `{ task, tool_outputs: [...] }` — every payload it collected,
      // which for a research round is the full text of every search. Delegating exists to keep
      // exactly that out of the caller's progress region.
      if (policy.returns === "summary_and_data" && result.generation_context?.data) {
        delegation["data"] = result.generation_context.data;
      }

      if (result.status !== "ok") {
        return {
          summary: `${requested} did not complete (${result.status}): ${result.summary}`,
          generation_context: { data: { delegation } },
          error: result.error ?? { code: "delegated_task_failed", message: result.summary },
        };
      }
      return {
        summary: `${requested} (thread ${threadId}): ${result.summary}`,
        generation_context: { data: { delegation } },
      };
    },
  };
}

function refuse(code: string, message: string) {
  return { summary: message, error: { code, message } };
}

const AGENT_PATH_SEPARATOR = ">";

export function formatAgentPath(path: readonly AgentKind[]): string {
  return path.join(AGENT_PATH_SEPARATOR);
}

export function parseAgentPath(path: string | undefined): AgentKind[] {
  if (!path) return [];
  return path.split(AGENT_PATH_SEPARATOR).filter((name): name is AgentKind => isAgentKind(name));
}
