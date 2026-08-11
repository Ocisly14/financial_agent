import { readFile } from "node:fs/promises";
import type { RegisteredTool } from "../../mcp_tools/toolRegistry.ts";
import type { JsonObject } from "./types.ts";
import type { SkillRegistry } from "./skill.ts";
import { resolveSkillFile, SkillPathError } from "./skillFiles.ts";
import { runSkillScript } from "./skillScript.ts";

export const READ_SKILL_REFERENCE = "read_skill_reference";
export const INVOKE_SKILL = "invoke_skill";

/**
 * 框架能力，不属于任何领域。category 门是领域隔离（研究 agent 不得触及交易工具），
 * 拿它去卡这两个等于任何 subagent 都别想读自己的方法论——所以豁免走 toolAccess，
 * 授予走各 agent 的 defaultTools：谁拿得到，由注册表显式说了算。
 */
export const SKILL_FRAMEWORK_TOOLS: readonly string[] = [INVOKE_SKILL, READ_SKILL_REFERENCE];

/**
 * 渐进披露的第一级（对 subagent 而言）:它自己判断该用哪个技能、自己取正文。
 * 归属校验和工具扩容都不在这里——execute 是纯函数，既不知道调用方是谁，也改不了
 * 运行中的工具集合。它只把 body 和该技能声明的 tools 交出去，由 subagent 循环处置。
 */
export function createInvokeSkillTool(skills: SkillRegistry): RegisteredTool {
  return {
    name: INVOKE_SKILL,
    description:
      "Load the full guidance of one skill listed in your own skill roster. Returns the skill's body; "
      + "any tools the skill declares become available to you from your next step.",
    category: "main",
    inputSchema: {
      type: "object",
      required: ["skill"],
      properties: { skill: { type: "string", description: "The skill name, exactly as it appears in your roster." } },
    },
    execute: async (input: JsonObject) => {
      const name = typeof input["skill"] === "string" ? input["skill"] : "";
      const skill = skills.get(name, "agent");
      if (!skill) {
        const message = `Skill not found: ${name}`;
        return { summary: message, error: { code: "skill_not_found", message } };
      }
      return {
        summary: `Loaded skill ${skill.name} (${skill.body.length} chars).`,
        generation_context: {
          data: { skill: skill.name, content: skill.body, ...(skill.tools ? { tools: skill.tools } : {}) },
        },
      };
    },
  };
}

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
      // 不限层：references 是文字指导而非能力，一个 agent 层技能的 playbook 不该
      // 因为查找默认落在 topic 层而取不到。
      const skill = skills.getAnyLayer(name);
      if (!skill) {
        const available = skills.list().map((entry) => entry.name).join(", ");
        const message = `Skill not found: ${name}. Available skills: ${available}`;
        return { summary: message, error: { code: "skill_not_found", message } };
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
        const available = skills.list().map((entry) => entry.name).join(", ");
        const message = `Skill not found: ${name}. Available skills: ${available}`;
        return { summary: message, error: { code: "skill_not_found", message } };
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
