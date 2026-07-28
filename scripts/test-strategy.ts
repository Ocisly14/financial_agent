/**
 * Manual verification for the auto-trading strategy tools.
 * Run: node --experimental-strip-types scripts/test-strategy.ts
 *
 * Exercises: create (valid + invalid) → read back persisted file → start → manage(get).
 * Writes real files under ./data/strategies/. Network is only touched for
 * absolute_threshold creation and list pricing; this script uses rolling_change
 * to stay offline-friendly.
 */
import { readFile } from "node:fs/promises";
import {
  createCexCreateStrategyTool,
  createCexStartStrategyTool,
  createCexManageStrategyTool,
} from "../mcp_tools/trading/strategyTools.ts";
import { strategyPath } from "../src/trading/persistence/paths.ts";

const ctx = { sessionId: "test-strategy" };
const create = createCexCreateStrategyTool();
const start = createCexStartStrategyTool();
const manage = createCexManageStrategyTool();

function hr(label: string): void {
  console.log(`\n──────── ${label} ────────`);
}

// 1. Valid strategy: "BTC drops 5% within 10 min → sell 10% of position (paper)".
hr("1. create valid rolling_change strategy");
const validInput = {
  task: "If BTC drops 5% in 10 minutes, sell 10% of my position",
  user_id: "tester",
  name: "BTC 5% stop",
  symbol: "BTCUSDT",
  mode: "paper",
  price_trigger: { type: "rolling_change", direction: "down", pct: 5, window_minutes: 10, confirm_samples: 2 },
  action: { side: "SELL", size: { type: "pct_of_position", value: 10 }, order_type: "marketable_limit", max_slippage_bps: 50 },
  recurrence: { mode: "one_shot", reanchor: false, trigger_count: 0 },
};
const createRes = await create.execute(validInput, ctx);
console.log("summary:", createRes.summary);
console.log("data:", JSON.stringify(createRes.generation_context?.data, null, 2));
if (createRes.error) throw new Error(`create failed: ${createRes.error.message}`);

const strategyId = String((createRes.generation_context?.data as Record<string, unknown>)["strategy_id"]);

// 2. Read the persisted file back and show it.
hr("2. read back persisted strategy file");
const filePath = strategyPath(strategyId);
console.log("path:", filePath);
const onDisk = JSON.parse(await readFile(filePath, "utf8"));
console.log(JSON.stringify(onDisk, null, 2));

// Assertions on the round-trip.
const ok =
  onDisk.id === strategyId &&
  onDisk.status === "draft" &&
  onDisk.symbol === "BTCUSDT" &&
  onDisk.dsl.price_trigger.type === "rolling_change" &&
  onDisk.dsl.price_trigger.pct === 5 &&
  onDisk.dsl.action.order_type === "marketable_limit" &&
  onDisk.dsl.mode === "paper";
console.log(ok ? "✅ round-trip fields match" : "❌ round-trip MISMATCH");

// 3. Invalid strategy: rolling_change missing pct should be rejected.
hr("3. create invalid strategy (rolling_change missing pct)");
const badRes = await create.execute(
  { task: "bad", symbol: "ETHUSDT", price_trigger: { type: "rolling_change", direction: "down", window_minutes: 10 }, action: { side: "SELL", size: { type: "pct_of_position", value: 50 }, order_type: "market" }, recurrence: { mode: "one_shot", reanchor: false, trigger_count: 0 } },
  ctx,
);
console.log("summary:", badRes.summary);
console.log(badRes.error ? "✅ correctly rejected" : "❌ should have been rejected");

// 4. Start (request activation) → pending_approval + approval payload.
hr("4. start strategy (request activation)");
const startRes = await start.execute({ task: "start it", strategy_id: strategyId }, ctx);
console.log("summary:", startRes.summary);
console.log("approval:", JSON.stringify(startRes.approval, null, 2));

// 5. Manage: get details + execution history.
hr("5. manage op=get");
const getRes = await manage.execute({ task: "show me", strategy_id: strategyId, op: "get" }, ctx);
console.log("summary:", getRes.summary);

hr("done");
console.log(`Inspect the file at: ${filePath}`);
console.log("(cancel it with cex_manage_strategy op=cancel, or delete the file, when finished.)");
