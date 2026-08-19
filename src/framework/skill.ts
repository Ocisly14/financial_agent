import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { Dispatcher } from "./dispatcher.ts";
import type { SessionState } from "./sessionState.ts";
import type { AgentKind, SkillLayer, SkillResult } from "./types.ts";
import { AGENT_KINDS } from "./types.ts";

const SKILL_LAYERS: ReadonlySet<string> = new Set<SkillLayer>(["topic", "research", "agent"]);

/** `## for:` 的第四个合法目标。member Topic 不是 AgentKind——它没有角色，
 *  只有"被问什么"的区别——所以它的小节存在独立字段里，不混进 agentSections。 */
const TOPIC_SECTION_TARGET = "topic";

export type SkillDefinition = {
  name: string;
  description: string;
  path: string; // <name>.md 的绝对路径
  dir: string; // skill 目录的绝对路径，后续任务的路径锁定基准
  layer: SkillLayer;
  /**
   * The FULL post-frontmatter markdown, `## for:` sections included. A skill acts on its reader:
   * the orchestrator reads the whole document and itself judges what each task it writes needs to
   * carry. The framework no longer relays sections behind the reader's back — `agentSections`
   * survives only to validate section targets and to serve the research layer's topicSection.
   */
  body: string;
  agentSections: Partial<Record<AgentKind, string>>;
  /** `## for: topic` 的内容。只有 research 层的技能会有。 */
  topicSection?: string;
  /**
   * 这个技能激活后**额外授予**的工具，叠加在 agent 自己的池之上。它只放宽，
   * 从不收窄——一个 agent 能够到什么，由它自己的 defaultTools 和 topology 说了算。
   */
  tools?: string[];
  workflow?: string;
};

export type WorkflowContext = {
  sessionId: string;
  userMessage: string;
  /** 只有 workflow 型技能会用到,而 workflow 仅限 topic 层——research 层的调用方不传。 */
  dispatcher?: Dispatcher;
  state: SessionState;
};

export type WorkflowHandler = (skill: SkillDefinition, context: WorkflowContext) => Promise<SkillResult>;

export class SkillRegistry {
  private readonly skills = new Map<string, SkillDefinition>();
  private readonly workflows = new Map<string, WorkflowHandler>();

  async loadFromDirectory(root: string): Promise<void> {
    // 目录不存在是合法的空状态（还没有任何 skill）；目录存在而内容非法
    // 则必须抛——一个写错的 skill 静默消失是最难查的一类问题。
    const entries = await readdir(root, { withFileTypes: true }).catch(() => null);
    if (entries === null) return;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(root, entry.name);
      // The file is named after the skill, not a fixed SKILL.md: an editor with
      // six skills open shows six distinct tab titles instead of six identical ones.
      const skillPath = path.join(dir, `${entry.name}.md`);
      const raw = await readFile(skillPath, "utf8").catch(() => null);
      if (raw === null) continue;
      const skill = parseSkillMarkdown(skillPath, dir, raw);
      if (skill.name !== entry.name) {
        throw new Error(
          `skill frontmatter name '${skill.name}' does not match its directory '${entry.name}': ${skillPath}`,
        );
      }
      this.skills.set(skill.name, skill);
    }
  }

  registerWorkflow(name: string, handler: WorkflowHandler): void {
    if (this.workflows.has(name)) throw new Error(`duplicate workflow registered: ${name}`);
    this.workflows.set(name, handler);
  }

  /**
   * 默认只返回 topic 层。这个默认值是刻意的：它让既有的 Topic orchestrator
   * 与 read_skill_reference / run_skill_script 一个字节都不用改，就自动看不到
   * research 层的技能。
   */
  list(layer: SkillLayer = "topic"): SkillDefinition[] {
    return [...this.skills.values()].filter((skill) => skill.layer === layer);
  }

  get(name: string, layer: SkillLayer = "topic"): SkillDefinition | undefined {
    const skill = this.skills.get(name);
    return skill && skill.layer === layer ? skill : undefined;
  }

  /**
   * 不限层的按名查找。技能名在这个 Map 里就是全局唯一键，所以按名解析没有歧义。
   *
   * 层隔离的是**发现与调用**——谁能在自己的清单里看见它、谁能 invoke 它。references
   * 是文字指导而非能力，read_skill_reference 因此走这条：一个 agent 层技能的 playbook
   * 不该因为查找默认落在 topic 层而取不到。
   */
  getAnyLayer(name: string): SkillDefinition | undefined {
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
        content: skill.body,
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

/**
 * agent 声明的技能必须存在，且必须是 agent 层的。启动期就抛——一个静默消失的
 * 技能是最难查的一类问题：agent 会照着 prompt 里的清单去 invoke，拿到
 * skill_not_found，然后凭记忆把方法论编出来，日志里看不出区别。
 */
export function assertSubagentSkills(
  definitions: { name: string; skills?: string[] }[],
  skills: SkillRegistry,
): void {
  for (const definition of definitions) {
    for (const name of definition.skills ?? []) {
      const skill = skills.getAnyLayer(name);
      if (!skill) {
        throw new Error(`subagent ${definition.name} declares unknown skill '${name}'`);
      }
      if (skill.layer !== "agent") {
        throw new Error(
          `subagent ${definition.name} declares skill '${name}', which is a ${skill.layer}-layer skill; only agent-layer skills can be owned by an agent`,
        );
      }
    }
  }
}

/** 只匹配行首的 `## for: <agent>`，普通二级标题不受影响。 */
const AGENT_SECTION = /^##[ \t]+for:[ \t]*(\S+)[ \t]*$/gm;

export function splitAgentSections(
  raw: string,
  context: string,
): { body: string; agentSections: Partial<Record<AgentKind, string>>; topicSection?: string } {
  const agentSections: Partial<Record<AgentKind, string>> = {};
  let topicSection: string | undefined;
  const matches = [...raw.matchAll(AGENT_SECTION)];
  if (matches.length === 0) return { body: raw, agentSections };

  const body = raw.slice(0, matches[0]!.index);
  for (let i = 0; i < matches.length; i += 1) {
    const current = matches[i]!;
    const target = current[1]!;
    if (target !== TOPIC_SECTION_TARGET && !AGENT_KINDS.has(target)) {
      throw new Error(`skill section '## for: ${target}' names an unknown agent: ${context}`);
    }
    const start = current.index! + current[0].length;
    const end = i + 1 < matches.length ? matches[i + 1]!.index! : raw.length;
    const content = raw.slice(start, end).trim();
    if (target === TOPIC_SECTION_TARGET) topicSection = content;
    else agentSections[target as AgentKind] = content;
  }
  return topicSection === undefined ? { body, agentSections } : { body, agentSections, topicSection };
}

function parseSkillMarkdown(filePath: string, dir: string, raw: string): SkillDefinition {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) throw new Error(`skill missing frontmatter: ${filePath}`);

  const frontmatter = parseYaml(match[1] ?? "") as Record<string, unknown> | null;
  if (!frontmatter || typeof frontmatter !== "object") {
    throw new Error(`skill frontmatter must be a mapping: ${filePath}`);
  }

  const name = requireString(frontmatter, "name", filePath);
  const description = requireString(frontmatter, "description", filePath);

  const layerRaw = frontmatter["layer"];
  if (layerRaw !== undefined && (typeof layerRaw !== "string" || !SKILL_LAYERS.has(layerRaw))) {
    throw new Error(`skill ${name} declares unknown layer '${String(layerRaw)}': ${filePath}`);
  }
  const layer = (layerRaw as SkillLayer | undefined) ?? "topic";

  const split = splitAgentSections(match[2] ?? "", filePath);
  // 写错层的小节静默失效是最难查的一类问题，两个方向都抛。
  if (layer === "topic" && split.topicSection !== undefined) {
    throw new Error(`topic-layer skill ${name} carries a '## for: topic' section: ${filePath}`);
  }
  if (layer === "research" && Object.keys(split.agentSections).length > 0) {
    const first = Object.keys(split.agentSections)[0];
    throw new Error(`research-layer skill ${name} carries a '## for: ${first}' section: ${filePath}`);
  }
  // agent 层的受众就是注册它的那个 agent，正文整篇都是写给它的。分小节意味着
  // 这份文件还想服务第二种读者——那是 topic 层的形态，不是这一层的。
  if (layer === "agent") {
    const section = Object.keys(split.agentSections)[0] ?? (split.topicSection === undefined ? undefined : TOPIC_SECTION_TARGET);
    if (section !== undefined) {
      throw new Error(`agent-layer skill ${name} carries a '## for: ${section}' section; its body is the whole guidance: ${filePath}`);
    }
  }

  const skill: SkillDefinition = {
    name,
    description,
    path: filePath,
    dir,
    layer,
    body: (match[2] ?? "").trim(),
    agentSections: split.agentSections,
  };
  if (split.topicSection !== undefined) skill.topicSection = split.topicSection;

  // `agents:` 曾是派活白名单。它被删掉了：技能是指导，不是沙箱——能派给谁由 topology
  // 说了算，跑题由技能正文和 orchestrator 自己的判断管。留着不报错会让
  // 作者以为白名单还在生效，所以写了就抛。
  if (frontmatter["agents"] !== undefined) {
    throw new Error(`skill ${name} declares 'agents', which no longer exists — a skill guides, it does not gate: ${filePath}`);
  }

  const tools = optionalStringArray(frontmatter, "tools", filePath);
  if (tools) {
    // Only an agent-layer skill may declare tools, because that grant is SELF-directed: invoke_skill
    // folds them into the caller's own live set. A topic skill's reader is the orchestrator, and its
    // old `tools:` widened the pools of the agents it dispatched — a capability side-channel around
    // the topology, which is the one place an agent's reach is declared.
    if (layer !== "agent") {
      throw new Error(`${layer}-layer skill ${name} may not declare 'tools' — a skill guides its reader; an agent's pool is declared in the topology: ${filePath}`);
    }
    skill.tools = tools;
  }

  if (frontmatter["workflow"] !== undefined) {
    // workflow handler 拿的是 Dispatcher；research 控制器和 subagent 都没有。
    if (layer !== "topic") {
      throw new Error(`${layer}-layer skill ${name} may not declare 'workflow': ${filePath}`);
    }
    skill.workflow = requireString(frontmatter, "workflow", filePath);
  }
  return skill;
}

function requireString(frontmatter: Record<string, unknown>, key: string, filePath: string): string {
  const value = frontmatter[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`skill frontmatter '${key}' must be a non-empty string: ${filePath}`);
  }
  return value.trim();
}

function optionalStringArray(
  frontmatter: Record<string, unknown>,
  key: string,
  filePath: string,
): string[] | undefined {
  const value = frontmatter[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`skill frontmatter '${key}' must be a list of strings: ${filePath}`);
  }
  return value as string[];
}
