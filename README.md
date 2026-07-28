# Financial Agent

Local backend tools MVP for the redesigned Financial Agent framework.

## Commands

```bash
pnpm build
pnpm test
pnpm tools:list
```

The current focus is local MCP-style tools, not a server process. Tools are
registered through `mcp_tools/index.ts` and can be called directly from local
code with `callLocalMcpTool`.
