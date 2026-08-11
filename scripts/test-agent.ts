/**
 * End-to-end smoke test for the main agent.
 *
 * Run with:
 *   node --env-file=.env --experimental-strip-types scripts/test-agent.ts
 *
 * Tests:
 *   1. Stock price query   → get_stock_price  → markdown table + price section
 *   2. Financial research  → financial_search → Sources citation section
 *   3. Stock chart request → get_stock_price  → inline <StockChart /> component
 */

import { createFinancialAgentApp } from "../src/agent/createApp.ts";

const RESET  = "\x1b[0m";
const BOLD   = "\x1b[1m";
const GREEN  = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED    = "\x1b[31m";
const CYAN   = "\x1b[36m";
const DIM    = "\x1b[2m";

function pass(msg: string) { console.log(`${GREEN}✔${RESET} ${msg}`); }
function fail(msg: string) { console.log(`${RED}✘${RESET} ${msg}`); }
function info(msg: string) { console.log(`${CYAN}ℹ${RESET} ${msg}`); }
function section(msg: string) { console.log(`\n${BOLD}${YELLOW}── ${msg} ──${RESET}`); }
function divider() { console.log(`${DIM}${"─".repeat(60)}${RESET}`); }

type CheckResult = { label: string; ok: boolean; detail?: string };

function check(label: string, cond: boolean, detail?: string): CheckResult {
  return { label, ok: cond, detail };
}

function printChecks(checks: CheckResult[]) {
  for (const c of checks) {
    if (c.ok) pass(c.label);
    else fail(c.label + (c.detail ? `  → ${c.detail}` : ""));
  }
}

async function runCase(
  app: Awaited<ReturnType<typeof createFinancialAgentApp>>,
  sessionId: string,
  userMessage: string,
): Promise<{ response: string; taskResults: unknown[] }> {
  const result = await app.orchestrator.run({ sessionId, userMessage });
  const state = app.sessions.get(sessionId);
  const taskResults = state ? state.turnResults(state.currentTurn) : [];
  return { response: result.response, taskResults };
}

async function main() {
  console.log(`\n${BOLD}Financial Agent smoke test${RESET}`);
  info(`LLM_PROVIDER = ${process.env["LLM_PROVIDER"] ?? "(not set → mock)"}`);
  info(`ANTHROPIC_API_KEY = ${process.env["ANTHROPIC_API_KEY"] ? "set (" + process.env["ANTHROPIC_API_KEY"]!.slice(0, 12) + "...)" : "NOT SET"}`);
  divider();

  const app = await createFinancialAgentApp();
  let totalPass = 0;
  let totalFail = 0;

  // ── Test 1: Stock price ───────────────────────────────────────────────────
  section("Test 1 — Stock price (AAPL)")
  info("Query: 'AAPL今天价格怎么样？'");

  const t1 = await runCase(app, "smoke-1", "AAPL今天价格怎么样？");
  console.log(`\n${DIM}Response:${RESET}\n${t1.response.slice(0, 800)}${t1.response.length > 800 ? "\n…(truncated)" : ""}\n`);

  const checks1 = [
    check("Response is non-empty", t1.response.trim().length > 0),
    check("Tasks dispatched (≥1)", t1.taskResults.length >= 1),
    check("Contains markdown (## or ** or |)", /##|^\*\*|^\|/m.test(t1.response)),
    check("Mentions AAPL or price", /aapl|price|价格|\$|USD/i.test(t1.response)),
    check("No raw file paths exposed", !/\/Users\//i.test(t1.response)),
    check("No raw JSON leak ({ status: )", !/\{\s*"status"\s*:/.test(t1.response)),
  ];
  printChecks(checks1);
  totalPass += checks1.filter((c) => c.ok).length;
  totalFail += checks1.filter((c) => !c.ok).length;

  // ── Test 2: Web search with citations ────────────────────────────────────
  section("Test 2 — Web search + citation format")
  info("Query: '搜索一下最近比特币相关的新闻'");

  const t2 = await runCase(app, "smoke-2", "搜索一下最近比特币相关的新闻");
  console.log(`\n${DIM}Response:${RESET}\n${t2.response.slice(0, 800)}${t2.response.length > 800 ? "\n…(truncated)" : ""}\n`);

  const checks2 = [
    check("Response is non-empty", t2.response.trim().length > 0),
    check("Tasks dispatched (≥1)", t2.taskResults.length >= 1),
    check("Contains markdown", /##|\*\*|\n-\s/.test(t2.response)),
    // Sources section OR inline URL — either satisfies citation requirement
    check(
      "Has citation (Sources section or URL)",
      /sources|来源|参考|http[s]?:\/\//i.test(t2.response),
      "expected Sources section or URL link",
    ),
    check("No raw file paths exposed", !/\/Users\//i.test(t2.response)),
  ];
  printChecks(checks2);
  totalPass += checks2.filter((c) => c.ok).length;
  totalFail += checks2.filter((c) => !c.ok).length;

  // ── Test 3: Inline live stock chart ───────────────────────────────────────
  section("Test 3 — Inline live stock chart")
  info("Query: '给我画一个AAPL最近1年的股票价格图'");

  const t3 = await runCase(app, "smoke-3", "给我画一个AAPL最近1年的股票价格图");
  console.log(`\n${DIM}Response:${RESET}\n${t3.response.slice(0, 800)}${t3.response.length > 800 ? "\n…(truncated)" : ""}\n`);

  const hasStockChart = /<StockChart\s+symbol=["']AAPL["'](?:\s+range=["']1Y["'])?\s*\/>/i.test(t3.response);

  const checks3 = [
    check("Response is non-empty", t3.response.trim().length > 0),
    check("Tasks dispatched (≥1)", t3.taskResults.length >= 1),
    check(
      "Inline StockChart component in response",
      hasStockChart,
      hasStockChart ? undefined : "agent didn't embed the live StockChart component",
    ),
    check("No raw file paths exposed", !/\/Users\//i.test(t3.response)),
  ];
  printChecks(checks3);
  totalPass += checks3.filter((c) => c.ok).length;
  totalFail += checks3.filter((c) => !c.ok).length;

  // ── Summary ───────────────────────────────────────────────────────────────
  divider();
  const total = totalPass + totalFail;
  const color = totalFail === 0 ? GREEN : RED;
  console.log(`\n${BOLD}Result: ${color}${totalPass}/${total} checks passed${RESET}${totalFail > 0 ? ` (${totalFail} failed)` : ""}\n`);

  process.exit(totalFail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`${RED}Fatal error:${RESET}`, err);
  process.exit(1);
});
