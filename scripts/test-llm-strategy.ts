/**
 * Tests whether the LLM produces CORRECT strategy DSL from natural language.
 * Reproduces the real trade-subagent prompt (all trading tools visible, so the
 * model must also pick the right tool) and feeds clear + ambiguous requests.
 *
 * Run: node --env-file=.env --experimental-strip-types scripts/test-llm-strategy.ts
 */
import { McpToolRegistry } from "../mcp_tools/toolRegistry.ts";
import { registerAllTools, TRADING_OPERATIONS_TOOLS } from "../mcp_tools/registerTools.ts";
import { tradingOperationsSubagentPrompt } from "../src/agent/prompts/subagentPrompts.ts";
import { PromptRenderer } from "../src/framework/prompt.ts";
import { GoogleProvider } from "../src/infra/llm/googleProvider.ts";
import { ModelRouter } from "../src/infra/llm/provider.ts";
import { tryParsePriceStrategy, normalizePriceStrategyInput } from "../mcp_tools/trading/strategy/priceStrategy.ts";
import type { ToolDefinition } from "../src/framework/types.ts";

// ── Reproduce the framework's tool list + JSON-action parsing ─────────────────
function formatAllowedTools(tools: ToolDefinition[]): string {
  return tools
    .map((tool) => {
      const props = tool.inputSchema?.properties ?? {};
      const params = Object.keys(props).filter((k) => k !== "task");
      const hint = params.length > 0 ? ` (optional args: ${params.join(", ")})` : "";
      return `- ${tool.name}: ${tool.description}${hint}`;
    })
    .join("\n");
}
function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return null;
}
function parseCalls(text: string): { tool: string; input: Record<string, unknown> }[] {
  const json = extractJsonObject(text);
  if (!json) return [];
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(json) as Record<string, unknown>; } catch { return []; }
  const calls = Array.isArray(raw["calls"]) ? (raw["calls"] as unknown[]) : raw["tool"] ? [raw] : [];
  return calls
    .map((c) => (c && typeof c === "object" ? (c as Record<string, unknown>) : null))
    .filter((c): c is Record<string, unknown> => c !== null && typeof c["tool"] === "string")
    .map((c) => ({ tool: String(c["tool"]), input: (c["input"] && typeof c["input"] === "object" ? c["input"] : {}) as Record<string, unknown> }));
}

// ── Build the allowed-tools block exactly as the trade subagent sees it ───────
const registry = new McpToolRegistry();
registerAllTools(registry);
const tradingDefs = registry.list().filter((t) => (TRADING_OPERATIONS_TOOLS as readonly string[]).includes(t.name));
const allowedTools = formatAllowedTools(tradingDefs);

const renderer = new PromptRenderer();
const provider = new GoogleProvider(process.env["GOOGLE_GENERATIVE_AI_API_KEY"] ?? "");
const router = new ModelRouter(provider);

// ── Build the candidate DSL from a create_strategy tool input, then validate
function validateStrategyInput(input: Record<string, unknown>): { ok: boolean; issues?: string[]; canonical?: unknown } {
  const candidate = normalizePriceStrategyInput(input);
  const r = tryParsePriceStrategy(candidate);
  return r.ok ? { ok: true, canonical: r.value } : { ok: false, issues: r.issues };
}

interface Case { label: string; prompt: string; expectCreate: boolean }
const CASES: Case[] = [
  { label: "clear rolling_change", prompt: "If AAPL drops 5% within 10 minutes, buy $500 of AAPL.", expectCreate: true },
  { label: "clear absolute_threshold", prompt: "Sell all my MSFT if the price falls below $400.", expectCreate: true },
  { label: "clear trailing_stop", prompt: "Set an 8% trailing stop on my SPY position.", expectCreate: true },
  { label: "recurring dip entry", prompt: "Every time AAPL drops 3% within an hour, buy $100, up to 5 times.", expectCreate: true },
  { label: "vague (no numbers)", prompt: "如果 AAPL 跌太多就卖一点。", expectCreate: false },
  { label: "vague (protect)", prompt: "Protect my MSFT holdings from a sudden crash.", expectCreate: false },
  { label: "colloquial zh", prompt: "如果英伟达十分钟内涨超过 7%，就卖掉一半 NVDA。", expectCreate: true },
  { label: "buy the dip (underspecified)", prompt: "Buy the dip on SPY for me.", expectCreate: false },
];

const cgArgs = (input: Record<string, unknown>) => JSON.stringify(input, null, 2);

for (const c of CASES) {
  console.log(`\n════════ ${c.label} ════════`);
  console.log(`prompt: ${c.prompt}`);
  const { system, prompt } = renderer.render(tradingOperationsSubagentPrompt, {
    allowedTools,
    task: c.prompt,
    progress: "(nothing yet)",
  });
  let text = "";
  try {
    const res = await router.generate(
      [{ role: "system", content: system }, { role: "user", content: prompt }],
      { modelClass: "MEDIUM", temperature: 0, metadata: { mode: "subagent", agent: "trade" } },
    );
    text = res.text;
  } catch (err) {
    console.log("❌ LLM call failed:", err instanceof Error ? err.message : String(err));
    continue;
  }
  const calls = parseCalls(text);
  if (calls.length === 0) {
    console.log("→ model did NOT call a tool (finished/asked). Raw:", text.slice(0, 300));
    continue;
  }
  for (const call of calls) {
    console.log(`→ tool: ${call.tool}`);
    if (call.tool === "create_strategy") {
      console.log("  input:", cgArgs(call.input));
      const v = validateStrategyInput(call.input);
      if (v.ok) {
        console.log("  ✅ DSL VALID (after normalization) →", JSON.stringify(v.canonical));
      } else {
        console.log(`  ❌ DSL INVALID: ${v.issues?.join("; ")}`);
      }
    } else {
      console.log(`  (chose ${call.tool} instead of create_strategy)`);
      console.log("  input:", cgArgs(call.input));
    }
  }
}

console.log("\nDone. Review each case: did the model pick create_strategy only when the stock strategy was sufficiently specified?");
