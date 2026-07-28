// Standalone copy of the framework registry used by all mcp_tools/*.
// Structurally identical to src/infra/mcp/toolRegistry.ts; TypeScript structural typing ensures compatibility.
import type { JsonObject, ToolDefinition, ToolExecutionResult } from "../src/framework/types.ts";

export type ToolHandler = (input: JsonObject, context: { sessionId: string; taskId?: string }) => Promise<ToolExecutionResult>;

export type RegisteredTool = ToolDefinition & {
  execute: ToolHandler;
};

export class McpToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register(tool: RegisteredTool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`duplicate tool registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()].map(({ execute: _execute, ...definition }) => definition);
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  async call(name: string, input: JsonObject, context: { sessionId: string; taskId?: string }): Promise<ToolExecutionResult> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`tool not found: ${name}`);
    return tool.execute(input, context);
  }
}
