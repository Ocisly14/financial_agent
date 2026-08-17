import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = "skills/dcf-modeling";

function markdownFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return markdownFiles(path);
    return path.endsWith(".md") ? [path] : [];
  });
}

/** Operation names written as if they were being invoked, and the schema's own field names. */
const CALL_SHAPE = /set_formula|set_assumption|set_wacc_input|set_line_item_source|set_valuation_config|set_category_group|replace_fact|add_line_item|lineItemId|appliesTo|periodIds/g;

test("the dcf playbooks describe expressions, never operation call shapes", () => {
  // The tool's schema is the single source of truth for what an operation takes: which fields exist,
  // what they are named, which are required. A playbook that also depicts the shape is a second copy
  // that drifts, and the drift is invisible until a batch is rejected.
  //
  // It has been: formulas.md wrote its recipes as `set_formula <row> <range>: <expression>`, which
  // reads like a call. An agent translated it literally and sent {kind, lineItemId, appliesTo,
  // formula: "<expr>"} — but the schema takes a nested `formula` object whose expression field is
  // `source`, with `periodIds` required. Two batches rejected, both on the last steps of the budget,
  // and a correctly re-derived AMZN forecast was never written. The run that had NOT read the file
  // got the shape right, because the schema was then its only source.
  //
  // Prose may name an operation — "every assumption carries a rationale" is guidance about conduct,
  // not shape. A fenced block is where notation turns into something an agent copies, so that is
  // where the line is drawn.
  const offenders: string[] = [];
  for (const file of markdownFiles(ROOT)) {
    const text = readFileSync(file, "utf8");
    for (const block of text.matchAll(/```.*?\n(.*?)```/gs)) {
      const hits = [...new Set(block[1]!.match(CALL_SHAPE) ?? [])];
      if (hits.length > 0) offenders.push(`${file}: ${hits.join(", ")}`);
    }
  }
  assert.deepEqual(offenders, [],
    "a fenced block depicts an operation's call shape; describe row | range | expression instead and leave the shape to the schema");
});
