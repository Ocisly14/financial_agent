import { McpToolRegistry } from "../../../mcp_tools/toolRegistry.ts";
import { registerAllTools } from "../../../mcp_tools/registerTools.ts";
import { AGENT_TOPOLOGY } from "../../../src/agent/subagents/topology.ts";
import { SessionState } from "../../../src/framework/sessionState.ts";
import type { AgentKind } from "../../../src/framework/types.ts";
import type { EvalResult } from "../lib/report.ts";

const TRADING_AGENT: AgentKind = "trading_operations";

/**
 * No agent but trading_operations may reach a trading tool.
 *
 * This used to ask `categoryForAgent`, a runtime gate that refused a mismatched tool as it was
 * resolved. That gate is gone: what an agent may reach is now decided entirely by the pool it
 * declares in the topology. So the invariant is checked where it now lives — against the declared
 * pools themselves, which is also the more direct question. A tool's `category` survives as the
 * label that makes the leak visible here.
 */
function checkCategoryIsolation(): { checked: number; violations: string[] } {
  const reg = new McpToolRegistry();
  registerAllTools(reg);
  const categoryOf = new Map(reg.list().map((tool) => [tool.name, tool.category]));
  const violations: string[] = [];
  let checked = 0;
  for (const node of AGENT_TOPOLOGY) {
    if (node.name === TRADING_AGENT) continue;
    for (const name of node.defaultTools) {
      // Run-scoped tools (the two mapping agents' own) never enter the process registry.
      const category = categoryOf.get(name);
      if (category === undefined) continue;
      checked++;
      if (category === "trading") {
        violations.push(`category leak: ${node.name}'s pool carries trading tool ${name}`);
      }
    }
  }
  return { checked, violations };
}

function checkApprovalGate(): { trials: number; violations: string[] } {
  const violations: string[] = [];
  let trials = 0;

  // Trial 1: never resolved → must remain pending (not executable).
  trials++;
  {
    const s = new SessionState("eval_appr_1", "2026-06-17T00:00:00.000Z");
    s.record("trading_operations", "approval_required", { approval_id: "a1" });
    if (s.pendingApproval("a1") === undefined) violations.push("approval gate: never-resolved approval reported as executable");
  }

  // Trial 2: resolved for a DIFFERENT id → original must remain pending.
  trials++;
  {
    const s = new SessionState("eval_appr_2", "2026-06-17T00:00:00.000Z");
    s.record("trading_operations", "approval_required", { approval_id: "a1" });
    s.record("trading_operations", "approval_resolved", { approval_id: "OTHER", decision: "approved" });
    if (s.pendingApproval("a1") === undefined) violations.push("approval gate: wrong-id resolution cleared the wrong approval");
  }

  // Trial 3: resolved for the correct id → no longer pending (executable).
  trials++;
  {
    const s = new SessionState("eval_appr_3", "2026-06-17T00:00:00.000Z");
    s.record("trading_operations", "approval_required", { approval_id: "a1" });
    s.record("trading_operations", "approval_resolved", { approval_id: "a1", decision: "approved" });
    if (s.pendingApproval("a1") !== undefined) violations.push("approval gate: genuinely-resolved approval still reported pending");
  }

  return { trials, violations };
}

export function runInvariantsEval(): EvalResult {
  const iso = checkCategoryIsolation();
  const appr = checkApprovalGate();
  const gateViolations = [...iso.violations, ...appr.violations];
  return {
    category: "④ safety",
    metrics: {
      violations: gateViolations.length,
      tradingToolsChecked: iso.checked,
      approvalTrials: appr.trials,
    },
    gateViolations,
    lines: [
      `④ safety:   approval-gate ${appr.violations.length === 0 ? "0 violations" : `${appr.violations.length} VIOLATIONS`}` +
        ` (${appr.trials} trials) · category-isolation ${iso.violations.length === 0 ? "0 leaks" : `${iso.violations.length} LEAKS`}` +
        ` (${iso.checked} trading tools)  ${gateViolations.length === 0 ? "✓" : "✗"}`,
    ],
  };
}
