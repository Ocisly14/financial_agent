import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, mkdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolveSkillFile, SkillPathError } from "../skillFiles.ts";
import type { SkillDefinition } from "../skill.ts";

const SKILL: SkillDefinition = {
  name: "demo",
  description: "d",
  path: "/tmp/skills/demo/demo.md",
  dir: "/tmp/skills/demo",
  body: "",
  agentSections: {},
};

test("a plain relative path resolves inside the skill directory", () => {
  assert.equal(
    resolveSkillFile(SKILL, "references", "playbook.md"),
    path.join("/tmp/skills/demo", "references", "playbook.md"),
  );
});

test("a traversing path is refused", () => {
  assert.throws(() => resolveSkillFile(SKILL, "references", "../../../etc/passwd"), SkillPathError);
});

test("an absolute path is refused", () => {
  assert.throws(() => resolveSkillFile(SKILL, "references", "/etc/passwd"), SkillPathError);
});

test("a path that only looks like a sibling directory is refused", () => {
  // "references-evil" 以 "references" 为前缀；单纯的 startsWith 会漏掉这一个。
  assert.throws(() => resolveSkillFile(SKILL, "references", "../references-evil/x.md"), SkillPathError);
});

async function makeTempSkill(): Promise<SkillDefinition> {
  const dir = await mkdtemp(path.join(tmpdir(), "skill-symlink-"));
  await mkdir(path.join(dir, "scripts"), { recursive: true });
  return {
    name: "demo",
    description: "d",
    path: path.join(dir, "demo.md"),
    dir,
    body: "",
    agentSections: {},
  };
}

test("a symlink inside scripts/ pointing outside the skill dir is refused", async () => {
  const skill = await makeTempSkill();
  const outsideDir = await mkdtemp(path.join(tmpdir(), "skill-outside-"));
  const outsideFile = path.join(outsideDir, "evil.ts");
  await writeFile(outsideFile, "// outside", "utf8");
  const linkPath = path.join(skill.dir, "scripts", "link.ts");
  await symlink(outsideFile, linkPath);

  assert.throws(() => resolveSkillFile(skill, "scripts", "link.ts"), SkillPathError);
});

test("a not-yet-existing, non-symlinked path is still accepted", async () => {
  const skill = await makeTempSkill();
  // fs.realpathSync throws ENOENT here; the lexical containment result must stand.
  assert.equal(
    resolveSkillFile(skill, "scripts", "not-created-yet.ts"),
    path.join(skill.dir, "scripts", "not-created-yet.ts"),
  );
});

test("a dangling symlink inside scripts/ is refused, not silently accepted", async () => {
  // realpathSync(target) throws ENOENT for a dangling symlink too — the same
  // error as a genuinely-absent path. lstatSync distinguishes them: the link
  // itself exists, so this must be rejected rather than falling through to
  // the "nothing to dereference yet" case.
  const skill = await makeTempSkill();
  const linkPath = path.join(skill.dir, "scripts", "dangling.ts");
  await symlink(path.join(skill.dir, "scripts", "does-not-exist.ts"), linkPath);

  assert.throws(() => resolveSkillFile(skill, "scripts", "dangling.ts"), SkillPathError);
});
