import assert from "node:assert/strict";
import test from "node:test";
import { runDecompositionReduceLoop } from "../decompositionReduceLoop.ts";
import { InMemoryDecompositionStore } from "../../../infra/xbrl/decompositionStore.ts";
import { ModelRouter, type LlmProvider } from "../../../infra/llm/provider.ts";
import type { CandidateScheme } from "../../../infra/xbrl/decompositionTypes.ts";

function scripted(responses: string[]): ModelRouter {
  let call = 0;
  const provider: LlmProvider = { name: "scripted", generate: async () => ({ text: responses[Math.min(call++, responses.length - 1)]!,
    metrics: { tokens_in: 1, tokens_out: 1, ms: 0, model_class: "MEDIUM", provider: "scripted" } }) };
  return new ModelRouter(provider);
}
function candidate(id: string, children: Array<{ childId: string; label: string }>): CandidateScheme {
  return { candidateSchemeId: id, label: id, axisHint: "srt:ProductOrServiceAxis", targetSourceLineItemId: "row-rev",
    children: children.map((child) => ({ ...child, cells: { FY2025: { factId: `f-${child.childId}`, value: 1, accession: "a",
      filedAt: "2025-10-01", sourceAnchor: "#x" } } })),
    periodIds: ["FY2025"], coverage: Object.fromEntries(children.map((child) => [child.childId, ["FY2025"]])),
    residualRatioByPeriod: { FY2025: 0.01 }, flags: [], openQuestions: [] };
}

test("reduce loop merges children on request, records the override, and returns a ranked decision", async () => {
  const store = new InMemoryDecompositionStore();
  const result = await runDecompositionReduceLoop({
    modelRouter: scripted([
      JSON.stringify({ action: "call_tool", calls: [{ tool: "merge_children",
        input: { candidateSchemeId: "cs-1", keepChildId: "ch-a", mergeChildIds: ["ch-b"] } }] }),
      JSON.stringify({ rationale: "product split has full coverage", sourceRefs: [],
        payload: { ranked: ["cs-1", "cs-2"], driverSchemeId: "cs-1" } }),
    ]),
    runId: "run1", store, task: "pick schemes", systemPrompt: "reduce agent",
    candidates: [candidate("cs-1", [{ childId: "ch-a", label: "Wearables" }, { childId: "ch-b", label: "Wearables, Home" }]),
      candidate("cs-2", [{ childId: "ch-c", label: "Americas" }])] });
  assert.deepEqual(result.decision.ranked, ["cs-1", "cs-2"]);
  assert.equal(result.decision.driverSchemeId, "cs-1");
  assert.equal(result.candidates.find((scheme) => scheme.candidateSchemeId === "cs-1")!.children.length, 1);
  assert.equal(store.listChildMerges("run1").length, 1);
});

test("a driver outside rank one is rejected and unknown ranked ids throw", async () => {
  const store = new InMemoryDecompositionStore();
  const base = { runId: "run1", store, task: "t", systemPrompt: "p",
    candidates: [candidate("cs-1", [{ childId: "ch-a", label: "A" }])] } as const;
  await assert.rejects(runDecompositionReduceLoop({ ...base,
    modelRouter: scripted([JSON.stringify({ rationale: "", sourceRefs: [], payload: { ranked: ["cs-unknown"], driverSchemeId: null } })]) }),
  /unknown candidateSchemeId/);
  await assert.rejects(runDecompositionReduceLoop({ ...base,
    modelRouter: scripted([JSON.stringify({ rationale: "", sourceRefs: [], payload: { ranked: ["cs-1"], driverSchemeId: "cs-2" } })]) }),
  /driverSchemeId/);
});
