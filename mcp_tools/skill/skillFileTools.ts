import { readFile } from "node:fs/promises";
import type { RegisteredTool } from "../toolRegistry.ts";
import type { JsonObject } from "../../src/framework/types.ts";
import type { SkillRegistry } from "../../src/framework/skill.ts";
import { resolveSkillFile, SkillPathError } from "../../src/framework/skillFiles.ts";
import { runSkillScript } from "../../src/framework/skillScript.ts";

export const READ_SKILL_REFERENCE = "read_skill_reference";

/** 渐进披露的第三级:references 只在模型明确要读时才进上下文。 */
export function createReadSkillReferenceTool(skills: SkillRegistry): RegisteredTool {
  return {
    name: READ_SKILL_REFERENCE,
    description:
      "Read one reference file belonging to an active skill. Paths are relative to that skill's references/ directory.",
    category: "main",
    inputSchema: {
      type: "object",
      required: ["skill", "path"],
      properties: {
        skill: { type: "string", description: "The skill name." },
        path: { type: "string", description: "Path relative to the skill's references/ directory." },
      },
    },
    execute: async (input: JsonObject) => {
      const name = typeof input["skill"] === "string" ? input["skill"] : "";
      const relative = typeof input["path"] === "string" ? input["path"] : "";
      const skill = skills.get(name);
      if (!skill) {
        return {
          summary: `Skill not found: ${name}`,
          error: { code: "skill_not_found", message: `Skill not found: ${name}` },
        };
      }
      let full: string;
      try {
        full = resolveSkillFile(skill, "references", relative);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          summary: message,
          error: { code: error instanceof SkillPathError ? "path_escape" : "invalid_path", message },
        };
      }
      const content = await readFile(full, "utf8").catch(() => null);
      if (content === null) {
        const message = `Reference not found: ${relative}`;
        return { summary: message, error: { code: "reference_not_found", message } };
      }
      return {
        summary: `Read ${name}/references/${relative} (${content.length} chars).`,
        generation_context: { data: { skill: name, path: relative, content } },
      };
    },
  };
}

export const RUN_SKILL_SCRIPT = "run_skill_script";

export function createRunSkillScriptTool(skills: SkillRegistry): RegisteredTool {
  return {
    name: RUN_SKILL_SCRIPT,
    description:
      "Run one script belonging to an active skill. Arguments are passed as JSON; the script returns JSON.",
    category: "main",
    inputSchema: {
      type: "object",
      required: ["skill", "script"],
      properties: {
        skill: { type: "string", description: "The skill name." },
        script: { type: "string", description: "Path relative to the skill's scripts/ directory." },
        args: { type: "object", description: "JSON arguments handed to the script on stdin." },
      },
    },
    execute: async (input: JsonObject) => {
      const name = typeof input["skill"] === "string" ? input["skill"] : "";
      const relative = typeof input["script"] === "string" ? input["script"] : "";
      const skill = skills.get(name);
      if (!skill) {
        return {
          summary: `Skill not found: ${name}`,
          error: { code: "skill_not_found", message: `Skill not found: ${name}` },
        };
      }
      let full: string;
      try {
        full = resolveSkillFile(skill, "scripts", relative);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          summary: message,
          error: { code: error instanceof SkillPathError ? "path_escape" : "invalid_path", message },
        };
      }
      const outcome = await runSkillScript(full, input["args"] ?? {});
      if (!outcome.ok) {
        return { summary: outcome.message, error: { code: outcome.code, message: outcome.message } };
      }
      return {
        summary: `Ran ${name}/scripts/${relative}.`,
        generation_context: { data: { skill: name, script: relative, result: outcome.value as JsonObject } },
      };
    },
  };
}
