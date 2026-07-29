import type { AgentKind, ToolCategory } from "./types.ts";

/** The trading operations subagent may use trading tools; all data/research agents use non-trading tools. */
export function categoryForAgent(agent: AgentKind): ToolCategory {
  return agent === "trading_operations" ? "trading" : "non_trading";
}

export function assertToolAllowedForAgent(agent: AgentKind, toolName: string, toolCategory: ToolCategory): void {
  const required = categoryForAgent(agent);
  if (toolCategory !== required) {
    throw new Error(`tool ${toolName} has category ${toolCategory}, not allowed for ${agent}`);
  }
}
