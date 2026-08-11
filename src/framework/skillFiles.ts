import path from "node:path";
import { realpathSync, lstatSync } from "node:fs";
import type { SkillDefinition } from "./skill.ts";

export class SkillPathError extends Error {
  readonly code = "path_escape";
}

/**
 * 把模型给出的相对路径锁进 skill 的 references/ 或 scripts/ 目录。
 *
 * 比较时在基准目录后补一个分隔符：否则 "references-evil" 会通过
 * "references" 的前缀检查。
 */
export function resolveSkillFile(
  skill: SkillDefinition,
  kind: "references" | "scripts",
  relative: string,
): string {
  const base = path.resolve(skill.dir, kind);
  const target = path.resolve(base, relative);
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new SkillPathError(`path '${relative}' escapes ${skill.name}/${kind}`);
  }

  // path.resolve is purely lexical — it never looks at the filesystem, so a
  // symlink planted inside references/ or scripts/ passes the check above
  // while pointing anywhere. realpathSync(target) throwing ENOENT is
  // ambiguous by itself: it means either "nothing here yet" (fine — normal
  // writes to not-yet-created scripts must keep working) or "a symlink here
  // points nowhere" (must NOT be treated as fine — a dangling link can't be
  // proven contained). lstatSync distinguishes the two without following the
  // link, so check it first.
  let isSymlink: boolean;
  try {
    isSymlink = lstatSync(target).isSymbolicLink();
  } catch {
    // Genuinely nothing at this path — nothing to dereference, lexical result stands.
    return target;
  }

  let realBase: string;
  try {
    realBase = realpathSync(base);
  } catch {
    return target;
  }

  if (isSymlink) {
    // The link itself exists; its target must resolve and be contained.
    // A dangling link (target does not resolve) is rejected outright.
    let realTarget: string;
    try {
      realTarget = realpathSync(target);
    } catch {
      throw new SkillPathError(`path '${relative}' is a symlink with no resolvable target in ${skill.name}/${kind}`);
    }
    if (realTarget !== realBase && !realTarget.startsWith(realBase + path.sep)) {
      throw new SkillPathError(`path '${relative}' escapes ${skill.name}/${kind} via symlink`);
    }
    return target;
  }

  // Not a symlink itself, but a parent directory component might be — resolve
  // fully and re-check containment against the realpath of the base.
  const realTarget = realpathSync(target);
  if (realTarget !== realBase && !realTarget.startsWith(realBase + path.sep)) {
    throw new SkillPathError(`path '${relative}' escapes ${skill.name}/${kind} via symlink`);
  }
  return target;
}
