import assert from "node:assert/strict";
import test from "node:test";
import { exploreDimensions } from "../dimensionExploration.ts";
import type { LoopTool } from "../../../../mcp_tools/financial-model/mappingSubagentTools.ts";
import type { JsonObject } from "../../../framework/types.ts";

const scripted = (responses: string[]) => ({
  async generate() { return { text: responses.shift() ?? '{"done":true}', metrics: { tokens_in: 0, tokens_out: 0 } }; },
}) as never; // 与 loadWorkingSet.test.ts 的 stub 同款；以那边的实际写法为准

const tool = (name: string, result: unknown, calls: unknown[]): LoopTool => ({
  name, category: "non_trading", description: name,
  inputSchema: { type: "object", additionalProperties: true, properties: {} },
  execute(input: JsonObject) { calls.push(input); return result as never; } });

test("explores axes then breakdowns and returns their digest", async () => {
  const calls: unknown[] = [];
  const tools = new Map([
    ["list_dimension_axes", tool("list_dimension_axes", { axes: [{ axisQName: "seg" }] }, calls)],
    ["get_axis_breakdown", tool("get_axis_breakdown", { members: [{ memberQName: "x:A" }] }, calls)],
  ]);
  const { digest } = await exploreDimensions({ modelRouter: scripted([
    '{"tool":"list_dimension_axes","input":{"symbol":"TST"}}',
    '{"tool":"get_axis_breakdown","input":{"symbol":"TST","axisQName":"seg","conceptQName":"rev"}}',
    '{"done":true}',
  ]), subagent: "statement_unification", systemPrompt: "sys", task: "unify TST", tools });
  assert.equal(calls.length, 2);
  assert.match(digest, /x:A/);
  assert.doesNotMatch(digest, /"axes"/); // 目录不进 digest
});

test("a provider that fails twice abandons exploration instead of failing the run", async () => {
  const failing = {
    async generate() { throw new Error("Anthropic returned no text block"); },
  } as never;
  const calls: unknown[] = [];
  const tools = new Map<string, LoopTool>([["list_dimension_axes", {
    name: "list_dimension_axes", category: "non_trading", description: "stub",
    inputSchema: { type: "object", additionalProperties: true, properties: {} },
    execute(input: JsonObject) { calls.push(input); return {} as never; },
  }]]);
  const { digest } = await exploreDimensions({ modelRouter: failing, subagent: "statement_unification",
    systemPrompt: "sys", task: "unify TST", tools });
  assert.equal(digest, "");
  assert.equal(calls.length, 0);
});

test("stops at maxSteps and survives tool errors", async () => {
  const calls: unknown[] = [];
  const throwing: LoopTool = { ...tool("list_dimension_axes", {}, calls),
    execute() { throw new Error("boom"); } };
  const { digest } = await exploreDimensions({ modelRouter: scripted([
    '{"tool":"list_dimension_axes","input":{"symbol":"TST"}}',
    '{"tool":"list_dimension_axes","input":{"symbol":"TST"}}',
  ]), subagent: "statement_unification", systemPrompt: "sys", task: "unify TST",
    tools: new Map([["list_dimension_axes", throwing]]), maxSteps: 2 });
  assert.equal(digest, "");
});
