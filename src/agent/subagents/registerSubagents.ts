import { SubagentRegistry } from "../../framework/subagent.ts";
import { AGENT_TOPOLOGY } from "./topology.ts";

/** The registry is a fold over the topology: `topology.ts` is the declaration, this is the lookup
 *  built from it. Validation belongs to `assertAgentTopology`, run once at startup. */
export function createSubagentRegistry(): SubagentRegistry {
  const registry = new SubagentRegistry();
  for (const node of AGENT_TOPOLOGY) registry.register(node);
  return registry;
}
