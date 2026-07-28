import type { JsonObject } from "./types.ts";

export type PromptTemplate = {
  system: string;
  prompt: string;
};

export type RenderedPrompt = {
  system: string;
  prompt: string;
};

export class PromptRenderer {
  render(template: PromptTemplate, state: JsonObject): RenderedPrompt {
    return {
      system: this.renderString(template.system, state),
      prompt: this.renderString(template.prompt, state),
    };
  }

  private renderString(input: string, state: JsonObject): string {
    return input.replace(/{{\s*([\w.]+)\s*}}/g, (_match, key: string) => {
      const value = this.getPath(state, key);
      if (value === undefined || value === null) return "";
      if (typeof value === "string") return value;
      return JSON.stringify(value, null, 2);
    });
  }

  private getPath(state: JsonObject, path: string): unknown {
    let current: unknown = state;
    for (const part of path.split(".")) {
      if (!current || typeof current !== "object" || !(part in current)) return undefined;
      current = (current as Record<string, unknown>)[part];
    }
    return current;
  }
}

export function formatList(items: { name: string; description: string }[]): string {
  if (items.length === 0) return "None";
  return items.map((item) => `- ${item.name}: ${item.description}`).join("\n");
}
