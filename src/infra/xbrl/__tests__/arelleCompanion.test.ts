import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ARELLE_COMPANION_SCRIPT as SCRIPT } from "../arelleAdapter.ts";

const FIXTURE = fileURLToPath(new URL("../../../../scripts/xbrl/fixtures/minimal-response.json", import.meta.url));
const REQUEST = JSON.stringify({
  protocolVersion: 3,
  filings: [{ accession: "request", form: "10-K", filedAt: "2026-02-01", reportDate: "2025-12-31",
    primaryDocumentUrl: "https://example.test/request.htm" }],
  periods: [{ id: "FY2025", label: "FY2025", start: "2025-01-01", end: "2025-12-31", cls: "actual" }],
});

test("Python companion emits exactly one valid fixture protocol response on stdout", () => {
  const result = spawnSync("python3", [SCRIPT, "--fixture-response", FIXTURE], { input: `${REQUEST}\n`, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.trim().split("\n").length, 1);
  const output = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.equal(output["protocolVersion"], 3);
  const filings = output["filings"] as Array<Record<string, unknown>>;
  assert.equal(filings.length, 1);
  assert.equal((filings[0]!["tables"] as unknown[]).length, 1);
  assert.deepEqual(filings[0]!["negatedConcepts"], []);
  assert.deepEqual(filings[0]!["statements"], []);
});

test("Python companion reports an explicit unavailable runtime without Arelle", () => {
  // -S excludes site-packages even on machines that have Arelle installed.
  const result = spawnSync("python3", ["-S", SCRIPT], { input: `${REQUEST}\n`, encoding: "utf8" });
  assert.equal(result.status, 69);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /"code": "xbrl_runtime_unavailable"/);
  assert.match(result.stderr, /arelle-release/);
});
