import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { Dispatcher } from "./dispatcher.ts";
import type { SessionState } from "./sessionState.ts";
import type { SkillResult } from "./types.ts";

export type SkillDefinition = {
  name: string;
  description: string;
  workflow?: string;
  path: string;
  body: string;
};

export type WorkflowContext = {
  sessionId: string;
  userMessage: string;
  dispatcher: Dispatcher;
  state: SessionState;
};

export type WorkflowHandler = (skill: SkillDefinition, context: WorkflowContext) => Promise<SkillResult>;

export class SkillRegistry {
  private readonly skills = new Map<string, SkillDefinition>();
  private readonly workflows = new Map<string, WorkflowHandler>();

  async loadFromDirectory(root: string): Promise<void> {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillPath = path.join(root, entry.name, "SKILL.md");
      const raw = await readFile(skillPath, "utf8").catch(() => null);
      if (!raw) continue;
      const skill = parseSkillMarkdown(skillPath, raw);
      this.skills.set(skill.name, skill);
    }
  }

  registerWorkflow(name: string, handler: WorkflowHandler): void {
    if (this.workflows.has(name)) throw new Error(`duplicate workflow registered: ${name}`);
    this.workflows.set(name, handler);
  }

  list(): SkillDefinition[] {
    return [...this.skills.values()];
  }

  get(name: string): SkillDefinition | undefined {
    return this.skills.get(name);
  }

  async invoke(name: string, context: WorkflowContext): Promise<SkillResult> {
    const skill = this.skills.get(name);
    if (!skill) {
      return {
        skill: name,
        status: "failed",
        summary: `Skill not found: ${name}`,
        error: { code: "skill_not_found", message: `Skill not found: ${name}` },
      };
    }
    if (!skill.workflow) {
      return {
        skill: skill.name,
        status: "loaded",
        summary: `Loaded skill ${skill.name}.`,
      };
    }
    const workflow = this.workflows.get(skill.workflow);
    if (!workflow) {
      return {
        skill: skill.name,
        workflow: skill.workflow,
        status: "failed",
        summary: `Workflow binding not found: ${skill.workflow}`,
        error: { code: "workflow_not_found", message: `Workflow binding not found: ${skill.workflow}` },
      };
    }
    return workflow(skill, context);
  }
}

function parseSkillMarkdown(filePath: string, raw: string): SkillDefinition {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    throw new Error(`skill missing frontmatter: ${filePath}`);
  }
  const frontmatter = parseYamlSubset(match[1] ?? "");
  const name = frontmatter.name;
  const description = frontmatter.description;
  if (!name || !description) {
    throw new Error(`skill frontmatter must include name and description: ${filePath}`);
  }
  const skill: SkillDefinition = {
    name,
    description,
    path: filePath,
    body: match[2] ?? "",
  };
  if (frontmatter.workflow !== undefined) skill.workflow = frontmatter.workflow;
  return skill;
}

function parseYamlSubset(input: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of input.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf(":");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    out[key] = value;
  }
  return out;
}
