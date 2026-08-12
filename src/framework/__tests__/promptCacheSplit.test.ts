import test from "node:test";
import assert from "node:assert/strict";
import { progressRegion, projectFinancialModelProgress, splitForPromptCache } from "../subagent.ts";

/**
 * A provider caches a request by byte prefix, so what a step pays for is whatever changed since the
 * step before — plus everything that happens to sit after it. Two things follow, and both are here:
 * the request has to be cut where the bytes actually stopped matching, and the progress projection
 * has to be ordered so that point comes as late as possible.
 */

const PROMPT = (progress: string) => `TASK\nvalue AAPL\n\n[PROGRESS SO FAR]\n${progress}`;
const cached = (messages: Array<{ cache?: boolean }>) => messages.filter((message) => message.cache === true).length;

test("without a previous step, only the static prefix is marked", () => {
  const messages = splitForPromptCache("system", PROMPT("x".repeat(50_000)));

  assert.equal(messages.length, 3);
  assert.equal(cached(messages), 2, "the system prompt and the unchanging task prefix");
  assert.equal(messages[2]!.cache, undefined, "the progress region is new, so it is paid for");
});

test("the part of the progress the last step already sent is marked too", () => {
  const shared = "S".repeat(30_000);
  const previous = PROMPT(shared);
  const current = PROMPT(`${shared}NEW STEP OUTPUT`);

  const messages = splitForPromptCache("system", current, progressRegion(previous));

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

  const messages = splitForPromptCache("system", shortProgress(8), progressRegion(shortProgress(7)));

  assert.equal(messages.length, 3, "no third breakpoint for a handful of shared bytes");
  assert.equal(cached(messages), 2);
});

test("identical progress caches whole rather than emitting an empty tail block", () => {
  const progress = "S".repeat(30_000);

  const messages = splitForPromptCache("system", PROMPT(progress), progressRegion(PROMPT(progress)));

  assert.equal(messages.length, 3);
  assert.equal(messages[2]!.cache, true);
  assert.ok(messages.every((message) => message.content.length > 0), "a provider rejects an empty text block");
});

test("never more than three markers, so the provider's breakpoint budget holds", () => {
  const shared = "S".repeat(30_000);

  const messages = splitForPromptCache("system", PROMPT(`${shared}tail`), progressRegion(PROMPT(shared)));

  assert.ok(cached(messages) <= 3, "Anthropic allows four; system + prefix + rolling is three");
});

test("a prompt with no progress marker is sent whole", () => {
  const messages = splitForPromptCache("system", "TASK\nvalue AAPL");

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
