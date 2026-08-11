import type { AgentKind, ToolCategory } from "./types.ts";

/** The trading operations subagent may use trading tools; all data/research agents use non-trading tools. */
export function categoryForAgent(agent: AgentKind): ToolCategory {
  return agent === "trading_operations" ? "trading" : "non_trading";
}

/**
 * `ask_user` is category `main` — it belongs to no domain, it ends a turn. The
 * category gate is a domain isolation (a research agent must not reach trading
 * tools), and applying it here would mean no subagent could ever ask, whatever
 * its pool says. So the grant lives in the pool instead: only
 * financial_modeling's `defaultTools` carries it, and the dispatcher strips it
 * when no human is watching the stream.
 */
const CATEGORY_EXEMPT_TOOLS = new Set(["ask_user"]);

export function assertToolAllowedForAgent(agent: AgentKind, toolName: string, toolCategory: ToolCategory): void {
  if (CATEGORY_EXEMPT_TOOLS.has(toolName)) return;
  const required = categoryForAgent(agent);
  if (toolCategory !== required) {
    throw new Error(`tool ${toolName} has category ${toolCategory}, not allowed for ${agent}`);
  }
}
