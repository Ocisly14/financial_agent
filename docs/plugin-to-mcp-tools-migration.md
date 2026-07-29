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
- `artifacts`: chart/file/url refs only when the tool deterministically creates or finds them.
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
Reference chart artifacts if present.
`
  },
  artifacts: [{ type: "chart", ref: "...", label: "BTC technical chart" }]
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

### `plugin-web-search`

- Old action: `WEB_SEARCH`
- New tool: `mcp_tools/web_search/webSearchTool.ts`
- Tool name: `web_search`
- Category: `non_trading`
- Input: `task`, `query`, `topic: "general" | "news"`, `limit`.
- Keep Tavily key rotation and sanitized search query logic.
- Remove runtime setting lookups; read env/config through a small local config helper.
- Output structured search results with title, url, snippet, source, published date if available.
- Prompt must instruct the main agent to cite URLs when using results.
- Keep prompt instructions in `mcp_tools/web_search/prompts.ts`.

### `plugin-crypto_research_search`

- Old action: `CRYPTO_RESEARCH_SEARCH`
- New tool: `mcp_tools/crypto_research_search/cryptoResearchSearchTool.ts`
- Tool name: `crypto_research_search`
- Category: `non_trading`
- Input: `task`, `query`, `symbol`, `limit`.
- Reuse the same search client layer as `web_search`, but apply crypto research focused query shaping.
- Output research-oriented results and a rendered prompt emphasizing source quality and institutional/academic context.
- Keep prompt instructions in `mcp_tools/crypto_research_search/prompts.ts`.

### `plugin-institutional_adoption`

- Old action: `INSTITUTIONAL_CRYPTO_SEARCH`
- New tool: `mcp_tools/institutional_adoption_search/institutionalAdoptionSearchTool.ts`
- Tool name: `institutional_adoption_search`
- Category: `non_trading`
- Input: `task`, `query`, `symbol`, `limit`.
- Reuse shared search client.
- Query shaping should target ETFs, treasury holdings, custody, funds, regulatory filings, and corporate adoption.
- Output source list plus adoption-signal summary data.
- Keep prompt instructions in `mcp_tools/institutional_adoption_search/prompts.ts`.

### `plugin-technic_analysis`

- Old action: `TECHNICAL_ANALYSIS`
- New tool: `mcp_tools/technical_analysis/technicalAnalysisTool.ts`
- Tool name: `technical_analysis`
- Category: `non_trading`
- Input: `task`, `symbol`, `from`, `to`, `timeframes`, retention options.
- Extract market data retrieval, indicator calculation, and chart generation into pure modules.
- Move old `dynamicPrompt` construction into `mcp_tools/technical_analysis/prompts.ts`.
- Output indicators, trend, support/resistance, volatility, timeframe summaries, chart artifacts if generated.

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

Migrate deterministic chart creation only. Do not expose a generic render-chart tool to LLMs.

- `PlotChartAction` -> tool-local helper used by technical tools, not a default execution tool.
- New location: the specific tool folder that owns the chart output, for example `mcp_tools/technical_analysis/chartArtifacts.ts`.
- Output chart artifacts from business tools, not from an independently selected chart tool.

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

1. `web_search`
2. `crypto_research_search`
3. `technical_analysis`
4. `prediction`
5. institutional search
6. CEX trading tools

This order keeps the analysis pipeline useful early while avoiding trading and approval complexity until the non-trading tool pattern is stable.
