import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { replay, type ReplayFixture } from "../lib/replay.ts";
import { pct } from "../lib/metrics.ts";
import type { EvalResult } from "../lib/report.ts";

const DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURE_FILES = [
  "clean-5pct-drawdown.json",
  "single-wick-spike.json",
  "noisy-chop.json",
  "trailing-stop-retrace.json",
];

function loadFixtures(): ReplayFixture[] {
  return FIXTURE_FILES.map((f) =>
    JSON.parse(readFileSync(join(DIR, "..", "datasets", "trigger-replay", f), "utf8")) as ReplayFixture,
  );
}

export function runTriggerEval(): EvalResult {
  const fixtures = loadFixtures();
  const outcomes = fixtures.map((fx) => ({ fx, fired: replay(fx).fired }));

  const shouldFire = outcomes.filter((o) => o.fx.expectedFire);
  const shouldNot = outcomes.filter((o) => !o.fx.expectedFire);
  const firedCount = shouldFire.filter((o) => o.fired).length;
  const falseTriggers = shouldNot.filter((o) => o.fired).length;

  const recallVal = shouldFire.length === 0 ? 1 : firedCount / shouldFire.length;
  const ftr = shouldNot.length === 0 ? 0 : falseTriggers / shouldNot.length;
  const truePos = firedCount;
  const precisionVal = truePos + falseTriggers === 0 ? 1 : truePos / (truePos + falseTriggers);

  const gateViolations: string[] = [];
  for (const o of outcomes) {
    if (o.fired !== o.fx.expectedFire) {
      gateViolations.push(`② ${o.fx.id}: fired=${o.fired}, expected=${o.fx.expectedFire}`);
    }
  }

  return {
    category: "② trigger",
    metrics: { recall: recallVal, falseTriggerRate: ftr, precision: precisionVal, n: fixtures.length },
    gateViolations,
    lines: [
      `② trigger:  recall ${pct(recallVal)} (${firedCount}/${shouldFire.length}) · ` +
        `false-trigger ${pct(ftr)} (${falseTriggers}/${shouldNot.length}) · precision ${pct(precisionVal)}`,
    ],
  };
}
