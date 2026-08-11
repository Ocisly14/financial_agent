import { SKILL_FRAMEWORK_TOOLS } from "./skillTools.ts";
import type { AgentKind, ToolCategory } from "./types.ts";

/** The trading operations subagent may use trading tools; all data/research agents use non-trading tools. */
export function categoryForAgent(agent: AgentKind): ToolCategory {
  return agent === "trading_operations" ? "trading" : "non_trading";
}

/**
 * Tools that belong to no domain. The category gate is a domain isolation (a
 * research agent must not reach trading tools), so applying it to these would
 * mean no subagent could ever use them, whatever its pool says. The grant lives
 * in the pool instead: only the agents whose `defaultTools` carry them get them.
 *
 * `ask_user` is category `main` because it ends a turn rather than doing domain
 * work; only financial_modeling's pool carries it, and the dispatcher strips it
 * when no human is watching the stream. The skill framework tools are the same
 * shape of thing — reading your own methodology is not a domain capability, and
 * gating it by domain would mean no subagent could ever read one.
 */
const CATEGORY_EXEMPT_TOOLS = new Set(["ask_user", ...SKILL_FRAMEWORK_TOOLS]);

export function assertToolAllowedForAgent(agent: AgentKind, toolName: string, toolCategory: ToolCategory): void {
  if (CATEGORY_EXEMPT_TOOLS.has(toolName)) return;
  const required = categoryForAgent(agent);
  if (toolCategory !== required) {
    throw new Error(`tool ${toolName} has category ${toolCategory}, not allowed for ${agent}`);
  }
}
