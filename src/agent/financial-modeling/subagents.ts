import type { ModelClass } from "../../infra/llm/provider.ts";
import { spineMappingPrompt, statementUnificationPrompt } from "../prompts/dcfSubagentPrompts.ts";

/**
 * The DCF Agent's mapping subagents — every one of them an LLM call. Filing extraction is deliberately
 * NOT here: it is a deterministic Arelle pipeline the DCF Agent calls as a plain tool.
 *
 * statement_unification aligns the issuer's own concepts across years; spine_mapping places those
 * unified rows on the canonical spine. Both read what extraction stored and write their result back to
 * the store, returning the DCF Agent a description of what they did rather than the data itself. The
 * DCF Agent then authors the forecast and judges the valuation itself, with its own tools.
 */
export type DcfSubagentKind = "statement_unification" | "spine_mapping";

/** Private registry is intentionally a different type from framework SubagentRegistry. */
export type DcfSubagentDefinition = {
  name: DcfSubagentKind;
  modelClass: ModelClass;
  authority: "read_only_proposal";
  prompt: string;
};

export class DcfSubagentRegistry {
  private readonly subagents = new Map<DcfSubagentKind, DcfSubagentDefinition>();
  constructor() {
    this.register({ name: "statement_unification", modelClass: "MEDIUM", authority: "read_only_proposal", prompt: statementUnificationPrompt });
    this.register({ name: "spine_mapping", modelClass: "MEDIUM", authority: "read_only_proposal", prompt: spineMappingPrompt });
  }
  register(definition: DcfSubagentDefinition): void {
    if (this.subagents.has(definition.name)) throw new Error(`duplicate DCF subagent: ${definition.name}`);
    this.subagents.set(definition.name, definition);
  }
  get(subagent: DcfSubagentKind): DcfSubagentDefinition {
    const definition = this.subagents.get(subagent); if (!definition) throw new Error(`unknown DCF subagent: ${subagent}`); return definition;
  }
  has(subagent: DcfSubagentKind): boolean { return this.subagents.has(subagent); }
  list(): DcfSubagentKind[] { return [...this.subagents.keys()]; }
}
