import { newId } from "../../framework/ids.ts";
import type { SkillDefinition, WorkflowContext } from "../../framework/skill.ts";
import type { ArtifactRef, SkillResult, TaskRequest } from "../../framework/types.ts";

const STEPS: { step_id: string; title: string; tasks: TaskRequest[] }[] = [
  {
    step_id: "market",
    title: "Market, research, news, and Fear & Greed context",
    tasks: [
      { agent: "onchain_data", task: "Prepare current market price context for the requested crypto asset.", tools: ["get_crypto_price"] },
      { agent: "news_research", task: "Prepare recent news context for the requested crypto asset.", tools: ["getnews"] },
      { agent: "news_research", task: "Search current web context for the requested crypto asset.", tools: ["web_search"] },
      { agent: "news_research", task: "Search crypto research context for the requested crypto asset.", tools: ["crypto_research_search"] },
      { agent: "news_research", task: "Search institutional adoption context for the requested crypto asset.", tools: ["institutional_adoption_search"] },
      { agent: "onchain_data", task: "Prepare broad crypto Fear & Greed Index market sentiment context.", tools: ["fear_greed_index_analysis"] },
    ],
  },
  {
    step_id: "technical",
    title: "Technical, SentiScore, and on-chain context",
    tasks: [
      { agent: "onchain_data", task: "Compute technical analysis indicators for the requested crypto asset.", tools: ["technical_analysis"] },
      { agent: "news_research", task: "Fetch multi-source sentiment analysis for the requested crypto asset.", tools: ["sentiscore_analysis"] },
      { agent: "onchain_data", task: "Fetch on-chain whale positions and large holder activity.", tools: ["whale_alert"] },
    ],
  },
];

export async function runComprehensiveAnalysisWorkflow(
  skill: SkillDefinition,
  context: WorkflowContext,
): Promise<SkillResult> {
  const workflowId = newId("workflow");
  const workflowName = skill.workflow ?? "comprehensive-analysis";

  // Workflow progress is recorded as workflow_* events; the SSE projector turns
  // them into frames. The workflow reads task results back from the event log.
  context.state.record("skill", "workflow_started", {
    workflow_id: workflowId,
    skill: skill.name,
    workflow: workflowName,
    title: "Comprehensive Analysis",
  });

  for (let index = 0; index < STEPS.length; index++) {
    const step = STEPS[index]!;
    context.state.record("skill", "workflow_step", {
      workflow_id: workflowId, step_id: step.step_id, title: step.title, status: "running",
      pct: Math.round((index / STEPS.length) * 100),
    });

    const tasks = step.tasks.map((task) => ({
      ...task,
      task: `${task.task}\nOriginal user request: ${context.userMessage}`,
    }));
    await context.dispatcher.dispatch(tasks); // subagents write their own task_result events

    context.state.record("skill", "workflow_step", {
      workflow_id: workflowId, step_id: step.step_id, title: step.title, status: "done",
      pct: Math.round(((index + 1) / STEPS.length) * 100),
    });
  }

  // Read all task results for this turn from the event log.
  const allResults = context.state.turnResults(context.state.currentTurn);
  const artifacts: ArtifactRef[] = allResults.flatMap((result) => result.artifacts ?? []);
  const failed = allResults.filter((result) => result.status !== "ok");
  const status = failed.length === 0 ? "ok" : "failed";
  const summary = `Comprehensive analysis workflow completed ${allResults.length} subagent tasks with ${failed.length} failures.`;

  context.state.record("skill", "workflow_done", { workflow_id: workflowId, status, summary });

  const result: SkillResult = {
    skill: skill.name,
    status,
    summary,
    task_results: allResults,
    artifacts,
  };
  if (skill.workflow !== undefined) result.workflow = skill.workflow;
  return result;
}
