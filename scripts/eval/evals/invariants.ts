import { McpToolRegistry } from "../../../mcp_tools/toolRegistry.ts";
import { registerAllTools } from "../../../mcp_tools/registerTools.ts";
import { categoryForAgent } from "../../../src/framework/toolAccess.ts";
import { SessionState } from "../../../src/framework/sessionState.ts";
import type { AgentKind } from "../../../src/framework/types.ts";
import type { EvalResult } from "../lib/report.ts";

const NON_TRADE_AGENTS: AgentKind[] = ["onchain_data", "news_research"];

function checkCategoryIsolation(): { checked: number; violations: string[] } {
  const reg = new McpToolRegistry();
  registerAllTools(reg);
  const tradingTools = reg.list().filter((t) => t.category === "trading");
  const violations: string[] = [];
  for (const tool of tradingTools) {
    for (const agent of NON_TRADE_AGENTS) {
      if (categoryForAgent(agent) === tool.category) {
        violations.push(`category leak: ${agent} could reach trading tool ${tool.name}`);
      }
    }
  }
  return { checked: tradingTools.length, violations };
}

function checkApprovalGate(): { trials: number; violations: string[] } {
  const violations: string[] = [];
  let trials = 0;

  // Trial 1: never resolved → must remain pending (not executable).
  trials++;
  {
    const s = new SessionState("eval_appr_1", "2026-06-17T00:00:00.000Z");
    s.record("trade", "approval_required", { approval_id: "a1" });
    if (s.pendingApproval("a1") === undefined) violations.push("approval gate: never-resolved approval reported as executable");
  }

  // Trial 2: resolved for a DIFFERENT id → original must remain pending.
  trials++;
  {
    const s = new SessionState("eval_appr_2", "2026-06-17T00:00:00.000Z");
    s.record("trade", "approval_required", { approval_id: "a1" });
    s.record("trade", "approval_resolved", { approval_id: "OTHER", decision: "approved" });
    if (s.pendingApproval("a1") === undefined) violations.push("approval gate: wrong-id resolution cleared the wrong approval");
  }

  // Trial 3: resolved for the correct id → no longer pending (executable).
  trials++;
  {
    const s = new SessionState("eval_appr_3", "2026-06-17T00:00:00.000Z");
    s.record("trade", "approval_required", { approval_id: "a1" });
    s.record("trade", "approval_resolved", { approval_id: "a1", decision: "approved" });
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
