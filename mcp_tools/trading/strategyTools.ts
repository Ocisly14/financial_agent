import type { RegisteredTool } from "../toolRegistry.ts";
import type { JsonObject } from "../../src/framework/types.ts";
import {
  tryParsePriceStrategy,
  summarizePriceStrategy,
  normalizePriceStrategyInput,
} from "./strategy/priceStrategy.ts";
import {
  saveStrategy,
  loadStrategy,
  listStrategies,
  listExecutions,
  applyStrategyOp,
  type StoredStrategy,
  type StrategyLifecycle,
  type ManageOp as StoreManageOp,
} from "../../src/trading/persistence/strategyStore.ts";
import { fetchStockStrategyPrice } from "../../src/trading/stockStrategyMarketData.ts";
import { wakeMonitor } from "../../src/trading/strategyMonitor.ts";

let idCounter = 0;
function newStrategyId(): string {
  return `strat-${Date.now().toString(36)}-${(idCounter++).toString(36)}`;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

// ── create_strategy ──────────────────────────────────────────────────────────
export function createCreateStrategyTool(): RegisteredTool {
  return {
    name: "create_strategy",
    description:
      "Create ONE price-driven US stock or ETF strategy as a DRAFT (does not run yet). " +
      "Use this for a future price or technical-indicator condition — a percentage move, price level, fill-relative move, trailing stop, RSI threshold, MACD cross, or SMA/EMA cross — whether a single conditional phase or a dependency-driven multi-phase plan. This tool does not place immediate broker orders. " +
      "Put EVERY leg in the single phases[] array; use depends_on for phases that must wait for earlier fills/completion and cancel_group for mutually exclusive exits. Never call this tool more than once for one plan. Use the exact field names, types and enums from the args schema below — do not rename or invent fields. " +
      "Do not invent values the user did not give: if a required field is missing (for example a rolling-change window_minutes, threshold, or action size), name the missing field instead of calling this tool. Time-based DCA is not supported. Strategies support paper and shadow evaluation only; live broker execution is unavailable. Then call start_strategy to request activation.",
    category: "trading",
    inputSchema: {
      type: "object",
      required: ["task", "name", "symbol", "phases"],
      properties: {
        task: { type: "string", description: "Natural-language description of the user's intent." },
        user_id: { type: "string", description: "Owner id for per-user state. Defaults to 'default'." },
        name: { type: "string", description: "Human-friendly strategy plan name." },
        symbol: { type: "string", description: "US stock or ETF ticker, e.g. AAPL, MSFT, SPY, or BRK.B." },
        mode: { type: "string", enum: ["paper", "shadow"], description: "Defaults to paper. Live broker execution is not supported." },
        phases: {
          type: "array",
          description: "Every leg of the plan. Root phases without dependencies monitor in parallel; dependent phases wait until their dependencies are satisfied.",
          items: {
            type: "object",
            required: ["name", "price_trigger", "action", "recurrence"],
            properties: {
              id: { type: "string", description: "Stable phase id. Required in practice when another phase refers to this phase." },
              name: { type: "string" },
              depends_on: {
                type: "array",
                items: { type: "string" },
                description: "Phase ids that must satisfy activate_on before this phase becomes active. Omit or use [] for an immediately active root phase.",
              },
              activate_on: {
                type: "string",
                enum: ["first_fill", "phase_completed"],
                description: "How every dependency is satisfied. Use first_fill for entry→exit workflows; defaults to phase_completed.",
              },
              price_anchor: {
                type: "object",
                required: ["type", "phase_id"],
                description: "Seed a relative_change or trailing_stop trigger from an earlier phase's actual simulated fill price.",
                properties: {
                  type: { type: "string", enum: ["phase_fill"] },
                  phase_id: { type: "string", description: "The dependency phase whose latest fill supplies the anchor." },
                },
              },
              cancel_group: {
                type: "string",
                description: "OCO group name. When this phase fills, other non-terminal phases in the same group are cancelled.",
              },
              price_trigger: {
                type: "object",
                required: ["type", "direction"],
                properties: {
                  type: { type: "string", enum: ["rolling_change", "absolute_threshold", "relative_change", "trailing_stop", "rsi_threshold", "macd_cross", "moving_average_cross"] },
                  direction: {
                    type: "string",
                    enum: ["up", "down", "above", "below", "bullish", "bearish"],
                    description: "up/down for price triggers; above/below for RSI; bullish/bearish for MACD or moving-average crosses",
                  },
                  pct: { type: "number", description: "required for rolling_change, relative_change & trailing_stop" },
                  window_minutes: { type: "integer", description: "required for rolling_change" },
                  price: { type: "number", description: "required for absolute_threshold" },
                  reference_price: { type: "number", description: "Explicit anchor for relative_change or trailing_stop. Omit when price_anchor supplies a phase fill." },
                  threshold: { type: "number", description: "required RSI threshold from 0 to 100" },
                  period: { type: "integer", description: "RSI period; defaults to 14" },
                  fast_period: { type: "integer", description: "fast MACD or moving-average period; defaults to 12 for MACD and 20 for moving averages" },
                  slow_period: { type: "integer", description: "slow MACD or moving-average period; defaults to 26 for MACD and 50 for moving averages" },
                  signal_period: { type: "integer", description: "MACD signal period; defaults to 9" },
                  average_type: { type: "string", enum: ["sma", "ema"], description: "moving-average type; defaults to sma" },
                  timeframe: { type: "string", description: "1Day or any 1-390 minute/hour interval such as 15Min, 1h, or 4Hour; defaults to 1Day" },
                  confirm_samples: { type: "integer", description: "default 2" },
                },
              },
              action: {
                type: "object",
                required: ["side", "size"],
                properties: {
                  side: { type: "string", enum: ["BUY", "SELL"] },
                  size: {
                    type: "object",
                    required: ["type", "value"],
                    properties: {
                      type: { type: "string", enum: ["pct_of_position", "pct_of_portfolio", "fixed_quote_usd", "fixed_base_qty"] },
                      value: { type: "number" },
                    },
                  },
                  order_type: { type: "string", enum: ["market", "marketable_limit"], description: "default marketable_limit" },
                  max_slippage_bps: { type: "integer", description: "default 50" },
                },
              },
              recurrence: {
                type: "object",
                required: ["mode"],
                properties: {
                  mode: { type: "string", enum: ["one_shot", "recurring"] },
                  cooldown_minutes: { type: "integer", description: "min minutes between triggers (recurring)" },
                  max_triggers: { type: "integer", description: "cap on fires (recurring)" },
                  reanchor: { type: "boolean", description: "default false" },
                },
              },
            },
          },
        },
        guardrails: {
          type: "object",
          description: "optional caps",
          properties: {
            total_budget_usd: { type: "number", description: "cumulative cap across all fills" },
            max_notional_usd: { type: "number", description: "max notional of any single order" },
          },
        },
        force: { type: "boolean", description: "create even if an absolute_threshold is already satisfied now" },
      },
    },
    execute: async (input: JsonObject) => {
      const candidate = normalizePriceStrategyInput(input);
      const parsed = tryParsePriceStrategy(candidate);
      if (!parsed.ok) {
        const message = `Strategy is invalid: ${parsed.issues.join("; ")}`;
        return { summary: message, error: { code: "invalid_strategy", message } };
      }
      const dsl = parsed.value;

      // Creation-time level check for absolute_threshold phases (avoid surprise "active immediately").
      if (input["force"] !== true) {
        try {
          const mid = await fetchStockStrategyPrice(dsl.symbol);
          for (const phase of dsl.phases) {
            if (phase.status !== "active") continue;
            const t = phase.price_trigger;
            if (t.type !== "absolute_threshold") continue;
            const already =
              t.price !== undefined &&
              mid > 0 &&
              ((t.direction === "down" && mid < t.price) || (t.direction === "up" && mid > t.price));
            if (already) {
              const message = `${dsl.symbol} is already ${t.direction === "down" ? "below" : "above"} the ${t.price} threshold for phase "${phase.name}" (current ~${mid.toFixed(2)}). Re-create with force:true to proceed.`;
              return {
                summary: message,
                error: { code: "threshold_already_met", message },
                generation_context: { prompt: "Warn the user the threshold is already met; ask them to confirm before forcing creation.", data: { current_price: mid, phase: phase.name, threshold: t.price ?? null } },
              };
            }
          }
        } catch { /* fail-open: allow creation if price check fails */ }
      }

      const id = newStrategyId();
      const strategy: StoredStrategy = {
        id,
        owner: str(input["user_id"]) || "default",
        symbol: dsl.symbol,
        status: "draft",
        created_at: new Date().toISOString(),
        dsl,
      };
      await saveStrategy(strategy);
      const summary = `Created draft strategy ${id}: ${summarizePriceStrategy(dsl)}. Call start_strategy to request activation.`;
      return {
        summary,
        generation_context: { prompt: "Confirm the draft multi-phase strategy was created and tell the user to start it when ready.", data: { strategy_id: id, status: "draft", phases: dsl.phases.length, summary: summarizePriceStrategy(dsl) } },
      };
    },
  };
}

// ── start_strategy ───────────────────────────────────────────────────────────
export function createStartStrategyTool(): RegisteredTool {
  return {
    name: "start_strategy",
    description:
      "Request activation of a DRAFT strategy. This does NOT activate it directly — it moves " +
      "the strategy to pending_approval and returns an approval request; the user must confirm " +
      "activation in the UI before the monitor starts trading it.",
    category: "trading",
    inputSchema: {
      type: "object",
      required: ["task", "strategy_id"],
      properties: {
        task: { type: "string", description: "Natural-language request." },
        strategy_id: { type: "string", description: "The strategy id to start." },
      },
    },
    execute: async (input: JsonObject) => {
      const id = str(input["strategy_id"]);
      const strategy = await loadStrategy(id);
      if (!strategy) {
        const message = `Strategy ${id} not found.`;
        return { summary: message, error: { code: "not_found", message } };
      }
      if (strategy.status !== "draft" && strategy.status !== "paused") {
        const message = `Strategy ${id} cannot be started from status '${strategy.status}'.`;
        return { summary: message, error: { code: "invalid_transition", message } };
      }
      strategy.status = "pending_approval";
      await saveStrategy(strategy);
      const summary = `Activation requested for ${id}: ${summarizePriceStrategy(strategy.dsl)}. Awaiting user confirmation in the UI.`;
      return {
        summary,
        approval: {
          approval_id: id,
          payload: {
            kind: "strategy_activation",
            actionName: "activate_strategy",
            strategy_id: id,
            summary: summarizePriceStrategy(strategy.dsl),
            mode: strategy.dsl.mode,
            phases: strategy.dsl.phases.length,
            strategy: strategy as unknown as JsonObject,
          },
        },
        generation_context: { prompt: "Tell the user activation is pending their confirmation in the UI.", data: { strategy_id: id, status: "pending_approval" } },
      };
    },
  };
}

// ── list_strategies ──────────────────────────────────────────────────────────
export function createListStrategiesTool(): RegisteredTool {
  return {
    name: "list_strategies",
    description: "List stock price strategies (optionally filtered by status), with the current price where available.",
    category: "trading",
    inputSchema: {
      type: "object",
      required: ["task"],
      properties: {
        task: { type: "string", description: "Natural-language request." },
        status: { type: "string", description: "Optional status filter (draft|pending_approval|active|running|paused|completed|cancelled|failed)." },
      },
    },
    execute: async (input: JsonObject) => {
      const statusFilter = str(input["status"]) as StrategyLifecycle | "";
      const all = await listStrategies(statusFilter ? (statusFilter as StrategyLifecycle) : undefined);
      const rows = await Promise.all(
        all.map(async (s) => {
          let price = 0;
          try { price = await fetchStockStrategyPrice(s.symbol); } catch { /* ignore */ }
          return {
            strategy_id: s.id,
            symbol: s.symbol,
            status: s.status,
            mode: s.dsl.mode,
            phases: s.dsl.phases.length,
            summary: summarizePriceStrategy(s.dsl),
            current_price: price || null,
          };
        }),
      );
      return {
        summary: `${rows.length} strateg${rows.length === 1 ? "y" : "ies"}${statusFilter ? ` with status ${statusFilter}` : ""}.`,
        generation_context: { prompt: "Present the strategies as a concise list with status, mode, condition, and current price.", data: { strategies: rows } },
      };
    },
  };
}

// ── manage_strategy ──────────────────────────────────────────────────────────
const VALID_OPS = ["pause", "resume", "cancel", "get"] as const;
type ManageOp = (typeof VALID_OPS)[number];

export function createManageStrategyTool(): RegisteredTool {
  return {
    name: "manage_strategy",
    description: "Manage one strategy: op=get (details + execution history), pause, resume, or cancel. Pause/resume toggle active<->paused; cancel is terminal.",
    category: "trading",
    inputSchema: {
      type: "object",
      required: ["task", "strategy_id", "op"],
      properties: {
        task: { type: "string", description: "Natural-language request." },
        strategy_id: { type: "string", description: "The strategy id." },
        op: { type: "string", description: "get | pause | resume | cancel.", enum: ["get", "pause", "resume", "cancel"] },
      },
    },
    execute: async (input: JsonObject) => {
      const id = str(input["strategy_id"]);
      const op = str(input["op"]).toLowerCase() as ManageOp;
      if (!(VALID_OPS as readonly string[]).includes(op)) {
        const message = `Invalid op '${op}'. Expected one of: ${VALID_OPS.join(", ")}.`;
        return { summary: message, error: { code: "invalid_op", message } };
      }
      const strategy = await loadStrategy(id);
      if (!strategy) {
        const message = `Strategy ${id} not found.`;
        return { summary: message, error: { code: "not_found", message } };
      }

      if (op === "get") {
        const executions = await listExecutions(id);
        return {
          summary: `Strategy ${id} [${strategy.status}]: ${summarizePriceStrategy(strategy.dsl)}. ${executions.length} execution(s).`,
          generation_context: { prompt: "Present the strategy details and its execution history.", data: { strategy, executions } as unknown as JsonObject },
        };
      }

      const result = applyStrategyOp(strategy, op as StoreManageOp);
      if (!result.ok) {
        return { summary: result.error, error: { code: "invalid_transition", message: result.error } };
      }
      await saveStrategy(result.strategy);

      if (op === "cancel") {
        return { summary: `Strategy ${id} cancelled.`, generation_context: { prompt: "Confirm cancellation.", data: { strategy_id: id, status: "cancelled" } } };
      }
      if (op === "pause") {
        return { summary: `Strategy ${id} paused.`, generation_context: { prompt: "Confirm pause.", data: { strategy_id: id, status: "paused" } } };
      }
      // Resuming is the other way a strategy becomes active, so it too has to
      // pull the monitor out of its idle heartbeat.
      wakeMonitor();
      return { summary: `Strategy ${id} resumed (active).`, generation_context: { prompt: "Confirm resume.", data: { strategy_id: id, status: "active" } } };
    },
  };
}
