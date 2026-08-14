import test from "node:test";
import assert from "node:assert/strict";
import { progressRegion, projectFinancialModelProgress, splitForPromptCache, SubagentRuntime } from "../subagent.ts";
import { SessionState } from "../sessionState.ts";
import { ModelRouter } from "../../infra/llm/provider.ts";
import type { GenerateResult, LlmMessage, LlmProvider } from "../../infra/llm/provider.ts";
import { McpToolRegistry } from "../../../mcp_tools/toolRegistry.ts";

/**
 * A provider caches a request by byte prefix, so what a step pays for is whatever changed since the
 * step before — plus everything that happens to sit after it. Two things follow, and both are here:
 * the request has to be cut where the bytes actually stopped matching, and the progress projection
 * has to be ordered so that point comes as late as possible.
 */

const PROMPT = (progress: string) => `TASK\nvalue AAPL\n\n[PROGRESS SO FAR]\n${progress}`;
/** The shape dispatch keeps between steps: last step's region plus the cuts it made in it. */
const previousOf = (prompt: string, cuts: readonly number[]) => ({ progress: progressRegion(prompt)!, cuts });
const cached = (messages: Array<{ cache?: boolean }>) => messages.filter((message) => message.cache === true).length;

test("without a previous step, only the static prefix is marked", () => {
  const { messages } = splitForPromptCache("system", PROMPT("x".repeat(50_000)));

  assert.equal(messages.length, 3);
  assert.equal(cached(messages), 2, "the system prompt and the unchanging task prefix");
  assert.equal(messages[2]!.cache, undefined, "the progress region is new, so it is paid for");
});

test("the part of the progress the last step already sent is marked too", () => {
  const shared = "S".repeat(30_000);
  const previous = PROMPT(shared);
  const current = PROMPT(`${shared}NEW STEP OUTPUT`);

  const { messages } = splitForPromptCache("system", current, previousOf(previous, []));

  assert.equal(messages.length, 4);
  assert.equal(cached(messages), 3);
  assert.match(messages[3]!.content, /NEW STEP OUTPUT/);
  assert.equal(messages[3]!.cache, undefined, "only the new tail is at full price");
  assert.equal(messages.map((message) => message.content).slice(1).join(""), current,
    "cutting the request must not change what the model reads");
});

test("a prefix too short to be worth a cache write is left alone", () => {
  // A provider bills a cache write above the read it saves, so a few hundred shared bytes lose money.
  const shortProgress = (revision: number) => PROMPT(`{"active_model_context":{"revision":${revision}}}`);

  const { messages } = splitForPromptCache("system", shortProgress(8), previousOf(shortProgress(7), []));

  assert.equal(messages.length, 3, "no third breakpoint for a handful of shared bytes");
  assert.equal(cached(messages), 2);
});

test("identical progress caches whole rather than emitting an empty tail block", () => {
  const progress = "S".repeat(30_000);

  const { messages } = splitForPromptCache("system", PROMPT(progress), previousOf(PROMPT(progress), []));

  assert.equal(messages.length, 3);
  assert.equal(messages[2]!.cache, true);
  assert.ok(messages.every((message) => message.content.length > 0), "a provider rejects an empty text block");
});

test("never more than four markers, so the provider's breakpoint budget holds", () => {
  const first = "S".repeat(30_000);
  const second = `${first}${"T".repeat(30_000)}`;
  const third = `${second}${"U".repeat(30_000)}`;

  const step1 = splitForPromptCache("system", PROMPT(first));
  const step2 = splitForPromptCache("system", PROMPT(second), previousOf(PROMPT(first), step1.cuts));
  const step3 = splitForPromptCache("system", PROMPT(third), previousOf(PROMPT(second), step2.cuts));

  assert.ok(cached(step3.messages) <= 4, "Anthropic allows four; system + prefix leaves two for the region");
});

/**
 * The fix above only pays if the entry a step WRITES is the entry the next step can READ, and that
 * turns on block boundaries, not just on bytes. Re-cutting the region at a moving offset shipped
 * once: every step wrote a fresh full-region entry and read none of them back, so 39k tokens moved
 * from full price to the 1.25x write price — worse than not caching at all. Boundaries are therefore
 * append-only: a cut, once made, stays a cut, and later steps only add new ones after it.
 */
test("a cut, once made, stays a block boundary for every later step", () => {
  const first = "S".repeat(30_000);
  const second = `${first}${"T".repeat(30_000)}`;
  const third = `${second}${"U".repeat(30_000)}`;

  const step1 = splitForPromptCache("system", PROMPT(first));
  const step2 = splitForPromptCache("system", PROMPT(second), previousOf(PROMPT(first), step1.cuts));
  const step3 = splitForPromptCache("system", PROMPT(third), previousOf(PROMPT(second), step2.cuts));

  // The block that ends at step one's cut must arrive byte-identical every later step — that
  // identity is the whole of what makes its cache entry readable rather than rewritten.
  assert.equal(step3.messages[2]!.content, step2.messages[2]!.content);
  assert.equal(step3.messages[3]!.content, step2.messages[3]!.content);
  assert.deepEqual(step3.cuts.slice(0, step2.cuts.length), step2.cuts, "earlier cuts are never moved");

  // And the two newest boundaries carry the markers, so the previous step's entry is read back
  // rather than written again.
  const marked = step3.messages.filter((message) => message.cache === true);
  assert.equal(marked.length, 4, "system, static prefix, the previous cut, and the new one");
  assert.equal(marked[2]!.content, step2.messages[2]!.content, "re-sends what step two cached, byte for byte");
  assert.equal(marked[3]!.content, step2.messages[3]!.content, "and cuts where step two's full-price tail ended");
});

test("a step that adds almost nothing does not open a new cut for it", () => {
  const first = "S".repeat(30_000);
  const second = `${first}${"T".repeat(30_000)}`;

  const step1 = splitForPromptCache("system", PROMPT(first));
  const step2 = splitForPromptCache("system", PROMPT(second), previousOf(PROMPT(first), step1.cuts));
  // Step three barely adds anything, so by step four the only uncached bytes are those few — far
  // too little to be worth the write that caching them would cost.
  const step3 = splitForPromptCache("system", PROMPT(`${second}tiny`), previousOf(PROMPT(second), step2.cuts));
  const step4 = splitForPromptCache("system", PROMPT(`${second}tinyish`), previousOf(PROMPT(`${second}tiny`), step3.cuts));

  assert.deepEqual(step4.cuts, step3.cuts, "a few new bytes are not worth their own cache write");
  assert.equal(step4.messages.at(-1)!.cache, undefined, "they ride along at full price instead");
});

test("a prompt with no progress marker is sent whole", () => {
  const { messages } = splitForPromptCache("system", "TASK\nvalue AAPL");

  assert.equal(messages.length, 2);
  assert.equal(progressRegion("TASK\nvalue AAPL"), undefined);
});

/**
 * The ordering invariant, stated as the consequence that matters rather than as a list of keys:
 * a step that only re-read the model must leave nearly all of the previous step's bytes standing.
 * It did not, once — `active_model_context` is rewritten on every read and sat second in the object,
 * which left 76 shared bytes out of 38k and put the playbook text the run had gathered behind it.
 */
test("re-reading the model leaves the rest of the projection byte-identical", () => {
  const reference = (path: string, size: number) => ({ name: "read_skill_reference", summary: "s",
    generation_context: { data: { skill: "dcf-modeling", path, content: "X".repeat(size) } } });
  const readModel = (revision: number) => ({ name: "get_financial_model", summary: "s",
    generation_context: { data: { model_id: "m1", revision, lifecycle_stage: "draft",
      model_overview: { revision, required_history: { complete: false, missing: ["operating_expenses@FY2021"] } } } } });
  const playbooks = [reference("04-analysis.md", 5355), reference("formulas.md", 13_533)];

  const before = projectFinancialModelProgress([...playbooks, readModel(7)] as never, [] as never, []);
  const after = projectFinancialModelProgress([...playbooks, readModel(8)] as never, [] as never, []);

  let shared = 0;
  while (shared < Math.min(before.length, after.length) && before[shared] === after[shared]) shared += 1;

  assert.ok(shared / after.length > 0.9,
    `only ${shared} of ${after.length} bytes held still — something rewritten each step is ordered ahead of `
    + "the playbook text, and every step pays for the text again");
});

/**
 * The same ordering invariant, one level up: the split above can only work if what dispatch renders
 * INTO the progress region is itself stable. The step counter is the counterexample that shipped —
 * a step-budget line at the head of the region moved every step, so the shared prefix was the
 * twenty-odd bytes before the digit, the rolling breakpoint never cleared MIN_ROLLING_CACHE_CHARS,
 * and a 39k-token region was re-sent at full price on every step of every dispatch.
 */
/** A concept inventory is what actually dominates this agent's region: many small rows of XBRL
 *  names, injected as `generation_context.data` — the path the projection really takes, and the one
 *  a `summary`-only stub would miss. */
const inventory = (marker: string, rows: number) => ({
  summary: `${marker} ok`,
  generation_context: { data: { symbol: "AMZN", batch: marker, concepts: Array.from({ length: rows },
    (_value, index) => ({ conceptQName: `us-gaap:${marker}Concept${index}`, label: `${marker} line ${index}`,
      periods: ["FY2021", "FY2022", "FY2023", "FY2024", "FY2025"], factCount: index })) } },
});

/** Drives a real dispatch, returning the messages the provider saw at each step. */
async function stepsOf(batches: string[]): Promise<LlmMessage[][]> {
  const sent: LlmMessage[][] = [];
  const provider: LlmProvider = {
    name: "stub",
    async generate(messages: LlmMessage[]): Promise<GenerateResult> {
      sent.push(messages);
      const batch = batches[sent.length - 1];
      const toolCalls = batch === undefined
        ? [{ name: "finish", input: { summary: "done" } }]
        : [{ name: "load_batch", input: { batch } }];
      return { text: `reading ${batch ?? "nothing"}`, toolCalls,
        metrics: { tokens_in: 1, tokens_out: 1, ms: 0, model_class: "MEDIUM", provider: "stub" } };
    },
  };
  const tools = new McpToolRegistry();
  tools.register({ name: "load_batch", description: "d", category: "non_trading",
    inputSchema: { type: "object" },
    // Each batch must add more than MIN_ROLLING_CACHE_CHARS, or there is nothing worth a breakpoint
    // and the test would pass for the wrong reason.
    execute: async (input) => inventory(String((input as { batch?: string }).batch), 120) });

  const state = new SessionState("s", new Date().toISOString());
  state.beginTurn("go");
  const thread = state.openThread("statement_unification");
  const dispatch = state.recordDispatch("statement_unification", "unify AMZN", thread);
  const { execute: _execute, ...definition } = tools.get("load_batch")!;

  await new SubagentRuntime(new ModelRouter(provider), tools).run({
    name: "statement_unification", description: "d", modelClass: "MEDIUM", defaultTools: ["load_batch"],
    systemPrompt: { system: "s", prompt: "<task>\n{{task}}\n</task>\n\n[PROGRESS SO FAR]\n{{progress}}\n\n{{stepBudget}}\nTake your next action now." },
  } as never, {
    sessionId: "s", agentId: "agent-1", taskId: dispatch.event_id,
    request: { agent: "statement_unification", task: "unify AMZN" },
    allowedTools: [definition], state, threadId: thread,
  });
  return sent;
}

/** Everything below the system block, as the model reads it. */
const promptOf = (messages: LlmMessage[]) => messages.slice(1).map((message) => message.content).join("");

test("what a step returns is injected into the next step's prompt, below the region's stable bytes", async () => {
  const sent = await stepsOf(["alpha", "beta", "gamma"]);

  const third = promptOf(sent[2]!);
  // The tool's structured data is what lands in the region — not its hand-written summary.
  assert.match(third, /\[load_batch\] \{"symbol":"AMZN","batch":"alpha"/);
  assert.match(third, /us-gaap:alphaConcept119/, "the whole payload, not a truncation of it");
  assert.match(third, /\[note step 1\] reading alpha/, "and the step note that went with it");
  // The volatile step counter must sit BELOW the region, or it moves the divergence point to the
  // top of the prompt and no rolling breakpoint can ever be reached.
  assert.ok(third.indexOf("(you are at step 3") > third.lastIndexOf("us-gaap:betaConcept119"),
    "the step budget line is rendered after the progress region, not inside it");
});

test("the injected region holds still across steps, so the rolling breakpoint fires", async () => {
  // Four batches: the first cut can only open once a step has a full earlier region to share with,
  // so the second cut — the one that proves boundaries are append-only — appears at step four.
  const sent = await stepsOf(["alpha", "beta", "gamma", "delta"]);
  const third = sent[2]!;
  const fourth = sent[3]!;

  assert.equal(fourth.length, 5, "system + static prefix + two cut blocks + the new tail");
  assert.equal(fourth.filter((message) => message.cache === true).length, 4);
  // The bytes step three cached must arrive byte-identical, or its entry is rewritten, not read.
  assert.equal(fourth[2]!.content, third[2]!.content);
  assert.match(fourth[2]!.content, /us-gaap:alphaConcept0/, "and they are the earlier batch's data");
  assert.equal(fourth.at(-1)!.cache, undefined, "only what this step added is at full price");
  assert.match(fourth.at(-1)!.content, /us-gaap:gammaConcept0/);
});
