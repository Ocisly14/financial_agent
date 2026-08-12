import assert from "node:assert/strict";
import { test } from "node:test";
import { REQUIRED_HISTORY_LINE_ITEMS } from "../service.ts";
import { REQUIRED_MAPPING_IDS, createSkeleton } from "../skeleton.ts";
import type { Period } from "../types.ts";

const PERIODS: Period[] = [
  { id: "FY2024", label: "FY2024", start: "2024-01-01", end: "2024-12-31", cls: "actual" },
  { id: "FY2025", label: "FY2025", start: "2025-01-01", end: "2025-12-31", cls: "actual" },
  { id: "FY2026", label: "FY2026", start: "2026-01-01", end: "2026-12-31", cls: "forecast" },
];

/**
 * Two lists decide whether a model can leave `draft`, and they are maintained in different files:
 * `historyGate` reads REQUIRED_HISTORY_LINE_ITEMS (service.ts) while spine_mapping is held to
 * REQUIRED_MAPPING_IDS (skeleton.ts). When they drift, the mapping subagent honestly reports full
 * coverage against its own list and the model still pins at `draft` on a row nobody was asked for —
 * which is exactly how `operating_expenses` blocked an entire AAPL run: the gate required it, the
 * mapping set omitted it, and it only ever got mapped when the orchestrator happened to name it by
 * hand in the dispatch task.
 *
 * The skeleton is source-free, so it can no longer be used as a proxy for the mapping decision.
 * Instead this test makes the hand-off explicit: rows that the history gate cannot derive from
 * another history-gated row must be mapping targets; the remaining rows are formulas the modeler
 * (or the working-capital compiler) writes after data is present.
 */
test("every non-derived required-history row is a required spine mapping target", () => {
  const derived = new Set([
    "ebitda", "nopat", "operating_working_capital", "change_nwc", "fcff",
  ]);
  const mustBeMapped = REQUIRED_HISTORY_LINE_ITEMS.filter((id) => !derived.has(id));
  const missing = mustBeMapped.filter((id) => !REQUIRED_MAPPING_IDS.has(id));

  assert.deepEqual(missing, [],
    `historyGate requires these but spine_mapping is never asked to cover them: ${missing.join(", ")}`);
});

test("the skeleton leaves every required-history row unclaimed until its fill channel is known", () => {
  const skeleton = createSkeleton({ currency: "USD", periods: PERIODS });
  const modeById = new Map(skeleton.lineItems.map((item) => [item.id, item.historical]));

  const predeclared = REQUIRED_HISTORY_LINE_ITEMS.filter((id) => modeById.get(id) !== "none");

  assert.deepEqual(predeclared, [],
    `skeleton predeclares a source before a fill channel exists: ${predeclared.join(", ")}`);
});

/** A required mapping target the spine does not define could never be mapped in the first place. */
test("every required mapping target exists in the skeleton", () => {
  const skeleton = createSkeleton({ currency: "USD", periods: PERIODS });
  const ids = new Set(skeleton.lineItems.map((item) => item.id));

  const undefined_ = [...REQUIRED_MAPPING_IDS].filter((id) => !ids.has(id));

  assert.deepEqual(undefined_, [], `required mapping targets absent from the spine: ${undefined_.join(", ")}`);
});
