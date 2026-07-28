import type { AgentKind, ToolCategory } from "./types.ts";

/** A trade subagent may use trading tools; every other agent may use only non-trading tools. */
export function categoryForAgent(agent: AgentKind): ToolCategory {
  return agent === "trade" ? "trading" : "non_trading";
}

export function assertToolAllowedForAgent(agent: AgentKind, toolName: string, toolCategory: ToolCategory): void {
  const required = categoryForAgent(agent);
  if (toolCategory !== required) {
    throw new Error(`tool ${toolName} has category ${toolCategory}, not allowed for ${agent}`);
  }
}
