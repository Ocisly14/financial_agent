/** Shared in-memory stores — singleton per process. Server and MCP tools both import from here. */

export const killSwitchStore = new Map<string, boolean>();

export const consentStore = new Map<string, { version: string; acceptedAt: number }>();

export const tradingPrefsStore = new Map<string, Record<string, unknown>>(
  process.env["DEFAULT_TRADING_MODE"]
    ? [["default", { default_mode: process.env["DEFAULT_TRADING_MODE"] }]]
    : []
);

/** userId → timestamp of last order failure (for cooldown rule). */
export const failureTimestamps = new Map<string, number>();

/** Active workflow state per session (agentId → status). */
export interface ActiveWorkflow {
  kind: "cex_human_input" | "task_chain";
  startedAt: number;
  sessionId?: string;
}
export const activeWorkflows = new Map<string, ActiveWorkflow>();
