import test from "node:test";
import assert from "node:assert/strict";
import {
  chunkTurns, mergeSelections, renderChunkForModel, containsDigits,
  type IndexedTurn,
} from "../retrieval.ts";

const turn = (n: number, reply = "x".repeat(40)): IndexedTurn =>
  ({ turn: n, user: `q${n}`, reply });

test("chunking loses no turn and keeps them in order", () => {
  const turns = Array.from({ length: 25 }, (_, i) => turn(i + 1));
  const chunks = chunkTurns(turns, 200);

  const flat = chunks.flatMap((c) => c.turns.map((t) => t.turn));
  assert.deepEqual(flat, turns.map((t) => t.turn), "every turn appears exactly once, in order");
});

test("a single turn larger than the budget still gets its own chunk", () => {
  const chunks = chunkTurns([turn(1, "y".repeat(10_000))], 200);
  assert.equal(chunks.length, 1, "an oversized turn must not be dropped or split mid-sentence");
  assert.equal(chunks[0]?.turns[0]?.turn, 1);
});

test("chunking an empty history yields no chunks", () => {
  assert.deepEqual(chunkTurns([], 200), []);
});

test("selections from several chunks merge, dedupe and rank by score", () => {
  const turns = [turn(1), turn(2), turn(3), turn(4)];
  const merged = mergeSelections(
    [[{ turn: 3, score: 0.9 }, { turn: 1, score: 0.2 }], [{ turn: 3, score: 0.4 }, { turn: 4, score: 0.7 }]],
    100_000,
    turns,
  );
  assert.deepEqual(merged.turns.map((t) => t.turn), [3, 4, 1], "highest score first, no duplicates");
  assert.equal(merged.coverage, "full");
});

test("a duplicate keeps its highest score, not its last", () => {
  const turns = [turn(1), turn(2)];
  const merged = mergeSelections(
    [[{ turn: 1, score: 0.9 }], [{ turn: 1, score: 0.1 }, { turn: 2, score: 0.5 }]],
    100_000,
    turns,
  );
  assert.deepEqual(merged.turns.map((t) => t.turn), [1, 2]);
});

test("merging truncates to the budget and says so", () => {
  const turns = Array.from({ length: 10 }, (_, i) => turn(i + 1, "z".repeat(400)));
  const merged = mergeSelections(
    [turns.map((t, i) => ({ turn: t.turn, score: 1 - i * 0.01 }))],
    300,
    turns,
  );
  assert.ok(merged.turns.length < 10);
  assert.equal(merged.coverage, "truncated", "the caller must be told it is not seeing everything");
});

test("a selection naming a turn that does not exist is ignored", () => {
  const merged = mergeSelections([[{ turn: 99, score: 1 }]], 100_000, [turn(1)]);
  assert.deepEqual(merged.turns, [], "a hallucinated id resolves to nothing rather than to the wrong turn");
});

test("the rendered chunk numbers every turn so the model can cite it", () => {
  const rendered = renderChunkForModel({ turns: [turn(7), turn(8)], tokenEstimate: 0 });
  assert.match(rendered, /\[turn 7\]/);
  assert.match(rendered, /\[turn 8\]/);
});

test("containsDigits catches the shapes a framing string must never have", () => {
  assert.equal(containsDigits("估值偏高，现金流稳健"), false);
  assert.equal(containsDigits("P/E 31.2"), true);
  assert.equal(containsDigits("支撑位 189"), true);
  assert.equal(containsDigits("上涨 5%"), true);
  assert.equal(containsDigits("１２３"), true, "full-width digits are digits");
});
