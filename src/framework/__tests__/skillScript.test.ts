import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runSkillScript } from "../skillScript.ts";

async function script(source: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "skill-script-"));
  const file = path.join(dir, "s.ts");
  await writeFile(file, source, "utf8");
  return file;
}

const ECHO = `
let raw = "";
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  const args = JSON.parse(raw || "{}");
  process.stdout.write(JSON.stringify({ doubled: args.n * 2 }));
});
`;

test("args go in as JSON on stdin and the result comes back parsed", async () => {
  const outcome = await runSkillScript(await script(ECHO), { n: 21 });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(outcome.value, { doubled: 42 });
});

test("a script that never finishes is killed and reported as a timeout", async () => {
  const file = await script("while (true) {}");
  const outcome = await runSkillScript(file, {}, 300);
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.code, "script_timeout");
});

test("a non-zero exit is reported with its stderr", async () => {
  const file = await script(`process.stderr.write("boom"); process.exit(3);`);
  const outcome = await runSkillScript(file, {});
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.code, "script_failed");
  assert.match(outcome.message, /boom/);
});

test("stdout that is not JSON is a failure, not a silent empty result", async () => {
  const file = await script(`process.stdout.write("not json");`);
  const outcome = await runSkillScript(file, {});
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.code, "script_failed");
});

test("a child that exits before reading a large stdin payload does not crash the parent with EPIPE", async () => {
  // The child exits immediately without touching stdin. Writing a payload large
  // enough to overflow the pipe buffer (default ~64KB on macOS/Linux) after the
  // read end is closed triggers EPIPE on the write. Without an 'error' listener
  // on child.stdin, Node raises this as an uncaught exception that takes the
  // whole process down — reproduced live, not inferred.
  const file = await script(`process.exit(0);`);
  const bigArgs = { blob: "x".repeat(5 * 1024 * 1024) };
  const outcome = await runSkillScript(file, bigArgs);
  // The exact outcome shape doesn't matter as much as: it resolved instead of
  // crashing the test process, and it reports failure rather than fabricating success.
  assert.equal(outcome.ok, false);
});
