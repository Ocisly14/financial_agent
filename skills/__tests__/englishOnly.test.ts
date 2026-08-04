import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCAN_ROOTS = ["skills", "mcp_tools", "scripts/verify"];
const TEXT_EXTENSIONS = new Set([".md", ".ts", ".json", ".yaml", ".yml"]);
const CJK_CHARACTER = /[\u3400-\u9fff]/u;

async function textFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await textFiles(fullPath));
    else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name))) files.push(fullPath);
  }
  return files;
}

test("skills, tools, and skill verification assets contain English text only", async () => {
  const files = (await Promise.all(
    SCAN_ROOTS.map((root) => textFiles(path.join(REPOSITORY_ROOT, root))),
  )).flat();
  const violations: string[] = [];

  for (const file of files) {
    const content = await readFile(file, "utf8");
    const lines = content.split("\n");
    lines.forEach((line, index) => {
      if (CJK_CHARACTER.test(line)) {
        violations.push(`${path.relative(REPOSITORY_ROOT, file)}:${index + 1}`);
      }
    });
  }

  assert.deepEqual(violations, [], `Non-English text found in:\n${violations.join("\n")}`);
});
