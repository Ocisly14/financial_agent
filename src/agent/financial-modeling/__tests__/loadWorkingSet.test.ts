import assert from "node:assert/strict";
import test from "node:test";
import { ModelRouter, type LlmProvider } from "../../../infra/llm/provider.ts";
import type { LoopTool } from "../../../../mcp_tools/financial-model/mappingSubagentTools.ts";
import { loadWorkingSet } from "../loadWorkingSet.ts";

function scripted(responses: string[]): { router: ModelRouter; prompts: () => string[] } {
  let call = 0;
  const seen: string[] = [];
  const provider: LlmProvider = { name: "scripted", generate: async (messages) => {
    seen.push(messages.map((m) => m.content).join("\n---\n"));
    return { text: responses[Math.min(call++, responses.length - 1)]!,
      metrics: { tokens_in: 1, tokens_out: 1, ms: 0, model_class: "MEDIUM", provider: "scripted" } };
  } };
  return { router: new ModelRouter(provider), prompts: () => seen };
}

function tools(onCall: (input: unknown) => unknown): Map<string, LoopTool> {
  const tool: LoopTool = { name: "load_concept_inventory", category: "non_trading", description: "stub",
    inputSchema: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] },
    execute: (input) => onCall(input) as never };
  return new Map([[tool.name, tool]]);
}

const base = { subagent: "statement_unification", systemPrompt: "You unify statements.",
  task: "Unify TSLA's extracted filings." };

test("the subagent's first turn is a load call carrying the ticker from the instruction", async () => {
  const seen: unknown[] = [];
  const { router, prompts } = scripted([JSON.stringify({ tool: "load_concept_inventory", input: { symbol: "TSLA" } })]);
  const loaded = await loadWorkingSet({ ...base, modelRouter: router, tools: tools((input) => { seen.push(input); return { rows: 3 }; }) });

  assert.deepEqual(seen, [{ symbol: "TSLA" }]);
  assert.deepEqual(loaded, { rows: 3 });
  // The instruction is all it gets — the working set is never pasted into the prompt.
  assert.ok(prompts()[0]!.includes("Unify TSLA's extracted filings."), prompts()[0]);
  assert.ok(prompts()[0]!.includes("load_concept_inventory"), prompts()[0]);
});

test("a failed load is stated back once, and the corrected call is honoured", async () => {
  let attempt = 0;
  const { router, prompts } = scripted([
    JSON.stringify({ tool: "load_concept_inventory", input: { symbol: "TSLAA" } }),
    JSON.stringify({ tool: "load_concept_inventory", input: { symbol: "TSLA" } }),
  ]);
  const loaded = await loadWorkingSet({ ...base, modelRouter: router, tools: tools((input) => {
    attempt += 1;
    if ((input as { symbol: string }).symbol !== "TSLA") throw new Error("no model holds extracted data for TSLAA");
    return { rows: 3 };
  }) });

  assert.equal(attempt, 2);
  assert.deepEqual(loaded, { rows: 3 });
  assert.ok(prompts()[1]!.includes("no model holds extracted data for TSLAA"), prompts()[1]);
});

test("a subagent that cannot produce a usable load call fails loudly rather than proceeding blind", async () => {
  const { router } = scripted(["I will now load the inventory."]);
  await assert.rejects(
    loadWorkingSet({ ...base, modelRouter: router, tools: tools(() => ({})) }),
    /could not load its working set/,
  );
});

test("a call naming a tool the subagent does not have is rejected by the schema", async () => {
  const { router } = scripted([JSON.stringify({ tool: "load_everything", input: { symbol: "TSLA" } })]);
  await assert.rejects(
    loadWorkingSet({ ...base, modelRouter: router, tools: tools(() => ({})) }),
    /could not load its working set/,
  );
});
