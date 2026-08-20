import test from "node:test";
import assert from "node:assert/strict";
import { assertAgentTopology, DELEGATE_TO_AGENT, type TopologyNode } from "../delegation.ts";
import { AGENT_TOPOLOGY } from "../../agent/subagents/topology.ts";
import type { AgentKind, DelegationPolicy } from "../types.ts";

const OPEN: DelegationPolicy = { returns: "summary", timeoutMs: 1000 };

function node(name: AgentKind, extra: Partial<TopologyNode> = {}): TopologyNode {
  return { name, defaultTools: [], ...extra };
}

/** Every declared edge needs the tool as well, so most fixtures below would trip
 *  `roster_without_tool` by accident and bury the fault under test. */
function caller(name: AgentKind, delegatesTo: AgentKind[]): TopologyNode {
  return { name, defaultTools: [DELEGATE_TO_AGENT], delegatesTo };
}

function faultsFrom(nodes: TopologyNode[], toolExists?: (name: string) => boolean): string {
  try {
    assertAgentTopology(nodes, DELEGATE_TO_AGENT, toolExists);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}

test("the real topology is valid", () => {
  assert.doesNotThrow(() => assertAgentTopology(AGENT_TOPOLOGY, DELEGATE_TO_AGENT));
});

test("every fault is collected, not just the first", () => {
  // Two faults of different kinds, in one call. First-fault reporting would turn one bad edit to
  // the topology into one restart per fault, and a startup message is read by a human exactly once.
  const message = faultsFrom([
    caller("financial_modeling", ["market_data", "financial_modeling"]),
    node("market_data"),
  ]);

  assert.match(message, /delegates to market_data, which declares no delegable policy/);
  assert.match(message, /financial_modeling delegates to itself/);
});

test("an edge to an unregistered agent is refused", () => {
  const message = faultsFrom([caller("financial_modeling", ["spine_mapping"])]);
  assert.match(message, /delegates to unknown agent 'spine_mapping'/);
});

test("an agent that never opted in cannot be delegated to", () => {
  const message = faultsFrom([caller("market_data", ["market_research"]), node("market_research")]);
  assert.match(message, /market_data delegates to market_research, which declares no delegable policy/);
});

test("a duplicated edge is reported", () => {
  const message = faultsFrom([
    caller("market_data", ["market_research", "market_research"]),
    node("market_research", { delegable: OPEN }),
  ]);
  assert.match(message, /market_data lists market_research twice/);
});

test("a roster and the delegation tool must agree", () => {
  const withoutTool = faultsFrom([
    { name: "market_data", defaultTools: [], delegatesTo: ["market_research"] },
    node("market_research", { delegable: OPEN }),
  ]);
  assert.match(withoutTool, /market_data declares delegatesTo but its defaultTools lack delegate_to_agent/);

  const withoutRoster = faultsFrom([node("market_data", { defaultTools: [DELEGATE_TO_AGENT] })]);
  assert.match(withoutRoster, /market_data carries delegate_to_agent but declares no delegatesTo/);
});

test("a cycle is reported once, with its path, however it is entered", () => {
  const message = faultsFrom([
    { ...caller("market_data", ["market_research"]), delegable: OPEN },
    { ...caller("market_research", ["financial_modeling"]), delegable: OPEN },
    { ...caller("financial_modeling", ["market_data"]), delegable: OPEN },
  ]);

  const cycles = message.split("\n").filter((line) => line.includes("delegation cycle"));
  assert.equal(cycles.length, 1, `one cycle, three entry points into it: ${message}`);
  assert.match(cycles[0]!, /financial_modeling → market_data → market_research → financial_modeling/);
});

test("a declared tool nothing registered is a startup fault, not a silent gap", () => {
  // This is the check that would have caught the mapping agents' ten dead tool names on day one:
  // a name the registry cannot resolve is a capability that silently is not there, and the agent
  // whose pool claims it re-derives the missing work by hand until its budget runs out.
  const registered = new Set(["get_stock_price"]);
  const message = faultsFrom(
    [node("market_data", { defaultTools: ["get_stock_price", "stock_sma"] })],
    (name) => registered.has(name),
  );
  assert.match(message, /market_data declares tool 'stock_sma', which is not registered/);
});

test("every agent that can search can also finish reading what it found", () => {
  // financial_search returns a truncated snippet plus a source_id; read_search_result is what
  // exchanges that id for the full page. Granting one without the other tells an agent its
  // evidence was cut off and gives it no way to see the rest — the DCF agent's pool is declared
  // in its own list, so it does not inherit market_research's grant.
  const missing = AGENT_TOPOLOGY
    .filter((agent) => agent.defaultTools?.includes("financial_search"))
    .filter((agent) => !agent.defaultTools?.includes("read_search_result"))
    .map((agent) => agent.name);

  assert.deepEqual(missing, []);
});
