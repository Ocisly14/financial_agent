# Plugin to Local MCP Tools Migration

This document defines how old `financial-agent_2.0/packages/plugin-*` packages should be rewritten into local tools under `financial-agent/mcp_tools`.

The current target is local MCP-style tools only. Do not add MCP stdio servers, HTTP servers, or Eliza runtime dependencies.

## Common Rules

- Put each migrated tool under its own `mcp_tools/<tool_name>/` folder.
- Register all tools through `mcp_tools/registerTools.ts`.
- Export local entrypoints through `mcp_tools/index.ts`.
- Do not import `@elizaos/core`, `IAgentRuntime`, `Memory`, `State`, `HandlerCallback`, or old action handlers into `mcp_tools`.
- Extract old action business logic into pure functions that accept JSON input and return `ToolExecutionResult`.
- Tool names should be stable, lower snake case, and globally unique. Preserve existing lowercase names where already used, such as `getnews`.
- Keep old action names in comments or metadata only when helpful for traceability.
- Trading tools must use category `trading`; all other plugin tools use `non_trading`.

Tool shape:

```ts
export function createXTool(): RegisteredTool {
  return {
    name: "tool_name",
    description: "...",
    category: "non_trading",
    inputSchema: { type: "object", required: ["task"], properties: { ... } },
    execute: async (input, context) => ({ summary, generation_context, artifacts }),
  };
}
```

Output requirements:

- `summary`: short deterministic statement of what the tool produced.
- `generation_context.prompt`: rendered text for the main agent or subagent to use as answer material.
- `generation_context.data`: structured JSON containing raw/normalized data used in the prompt.
- `artifacts`: file/url refs only when the tool deterministically creates or finds them.
- `visualizations`: normalized UI-only series/levels specs; tools never generate chart HTML.
- External errors should return structured empty/failed context when possible; do not leak local file paths or secrets.
- MCP tools must not generate final user-facing reports. They return structured data and rendered report-generation instructions for the orchestrator/main agent.

Prompt migration:

- Old `action.name`, `action.description`, `action.examples` were the tool-selection prompt surface.
- New equivalent is `ToolDefinition.name`, `ToolDefinition.description`, and `inputSchema`.
- Old internal LLM prompts inside a plugin should move into `mcp_tools/<tool_name>/prompts.ts`.
- Tools that only fetch/format data, like `getnews`, should not add an LLM call; return rendered `generation_context.prompt` instead.
- Old report-writing prompts/templates should be converted into section-generation guidance for the main agent. Keep the instructions, remove the final report generation from the tool.
- The main agent is the only component that writes final user-facing prose. Code-backed workflows may order sections and collect tool results, but they still pass `generation_context.prompt/data` back to the main agent for final report synthesis.

Report-generation boundary:

```ts
// Good: tool returns facts and report guidance.
return {
  summary: "Prepared BTC technical analysis context.",
  generation_context: {
    data: { symbol: "BTC", indicators, supportResistance },
    prompt: `
Use the provided technical analysis data to write the Technical Analysis section.
Cover trend, momentum, volatility, support/resistance, and invalidation levels.
Do not invent values beyond generation_context.data.
Return a structured visualization spec when the result should be drawn by the client.
`
  },
  visualizations: [{ type: "stock_technical", symbol: "AAPL", indicator: "SMA", series }]
};

// Bad: tool returns the final report directly.
return {
  summary: "Generated final BTC report.",
  generation_context: {
    data,
    prompt: "# Final BTC Report\n..."
  }
};
```

## Per-Plugin Migration Plan

### `plugin-news`

Status: first tool migrated.

- Old action: `getnews`
- New tool: `mcp_tools/getnews/getNewsTool.ts`
- Tool name: `getnews`
- Category: `non_trading`
- Keep: asset detection, date range parsing, limit parsing, S3 news fetch, cache, CSV parsing, retention clamp.
- Remove: Eliza callback response, `createActionResponse`, `generateActionSummary`, runtime/state/message dependencies.
- Output: articles array plus rendered news prompt.

### Financial search

- Tool: `mcp_tools/search/financialSearchTool.ts`
- Tool name: `financial_search`
- Category: `non_trading`
- Input: required `query`, optional `topic`, `limit`, and `search_depth`.
- The market-research subagent writes the complete query. The tool does not derive, expand, or specialize it.
- The tool calls Tavily and returns structured result records directly; it does not produce an analysis prompt.
- Crypto research and institutional-adoption searches use the same generic tool with queries written by the subagent.

### Stock technical indicators

- Tools: `stock_sma`, `stock_ema`, `stock_rsi`, `stock_macd`, `stock_bollinger_bands`, `stock_atr`, `stock_obv`, `stock_vwap`, and `stock_support_resistance`.
- Category: `non_trading`.
- Each tool requires an explicit US stock or ETF `symbol` and optionally accepts `timeframe` and `history_bars`. `1Day` reads daily bars; arbitrary 1-390 minute/hour intervals are aggregated from database 1-minute bars on 09:30 ET session boundaries.
- Bars come from the shared local stock-bar repository, which persists data in SQLite and refreshes it incrementally from Alpaca.
- Each indicator is independently callable; there is no fixed indicator bundle and no analysis prompt template.
- Tools return structured calculation data for the agent to interpret.

### `plugin-prediction`

- Old action: `PREDICTION`
- New tool: `mcp_tools/prediction/predictionTool.ts`
- Tool name: `prediction`
- Category: `non_trading`
- Input: `task`, `symbol`, `timeframes`, optional prior contexts from technical/news tools.
- Do not read old workflow-specific state.
- Accept prior context explicitly in input or let workflow pass previous `TaskResult.generation_context.data`.
- Move LLM forecasting prompt into `mcp_tools/prediction/prompts.ts`.
- Output scenarios, confidence, assumptions, invalidation levels, and rendered prompt material.

### `plugin-content-analysis`

Do not migrate this plugin as MCP tools for now.

Reason:

- These actions primarily ask an LLM to analyze or write over provided content.
- The new architecture keeps final analysis/report prose in the main agent or code-backed workflow.
- MCP tools should focus on data retrieval, deterministic transformations, artifacts, and report-generation context.

If this capability is needed later, implement only a deterministic content extraction/fetching tool, for example `extract_content_context`, and let the main agent perform the actual analysis.

### `plugin-charts`

Removed. Do not expose a render-chart tool and do not generate HTML files. Business tools return normalized visualization specs; the client-owned financial chart renderer performs all drawing.

### `plugin-cex`

Trading migration is separate from non-trading tools.

- Prefer old ADK tool definitions over old Eliza actions.
- Create tools under `mcp_tools/trading/`.
- Read-only tools may include `get_balance`, `get_orders`, `get_fills`.
- Write/preparation tools should start with `preview_order` / `cex_prepare_order`.
- Do not expose direct `create_order` execution to LLM selection.
- Approval and post-approval execution must stay in backend code, not in the tool-selection loop.

### `plugin-bootstrap`

Do not migrate as a business MCP tool unless a concrete action is needed.

- Treat bootstrap behavior as application/runtime initialization.
- If it contains reusable helpers, move them into `src/agent` or `src/infra`, not `mcp_tools`.

## Migration Order

Recommended order after `getnews` review:

1. `financial_search`
2. stock technical indicator tools
3. `prediction`
4. CEX trading tools

This order keeps the analysis pipeline useful early while avoiding trading and approval complexity until the non-trading tool pattern is stable.
