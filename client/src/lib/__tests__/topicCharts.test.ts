import test from "node:test";
import assert from "node:assert/strict";
import { mergeTopicCharts } from "../topicCharts.ts";
import type { SymbolChartWorkspace } from "../chartWorkspace.ts";
import type { TopicChartPreference } from "../../types/core.ts";

const derivedChart = (symbol: string, range = 1): SymbolChartWorkspace => ({
  symbol,
  range,
  createdAt: 1_700_000_000_000,
  studies: [],
});

const symbolPreference = (
  symbol: string,
  opts: { range?: number | null; hidden?: boolean; sortOrder: number },
): TopicChartPreference => ({
  id: `pref_${symbol}`,
  kind: "symbol",
  symbol,
  range: opts.range ?? null,
  hidden: opts.hidden ?? false,
  sortOrder: opts.sortOrder,
});

const overlayPreference = (
  id: string,
  symbols: string[],
  opts: { hidden?: boolean; sortOrder: number },
): TopicChartPreference => ({
  id,
  kind: "overlay",
  overlay: { symbols, range: 252, normalize: "pct" },
  range: null,
  hidden: opts.hidden ?? false,
  sortOrder: opts.sortOrder,
});

test("with no preferences the derived tabs pass through in order", () => {
  const tabs = mergeTopicCharts([derivedChart("AAPL"), derivedChart("NVDA")], []);
  assert.deepEqual(tabs.map((tab) => (tab.kind === "symbol" ? tab.symbol : tab.id)), ["AAPL", "NVDA"]);
  assert.equal(tabs.every((tab) => tab.kind === "symbol" && !tab.userAdded), true);
});

test("an agent-sourced change (re-derived chart data) revives a hidden symbol", () => {
  // Spec §6: the controller has full authority over layout; hidden is not a veto over it.
  const tabs = mergeTopicCharts(
    [derivedChart("AAPL"), derivedChart("NVDA")],
    [symbolPreference("NVDA", { hidden: true, sortOrder: 0 })],
  );
  assert.deepEqual(tabs.map((tab) => (tab.kind === "symbol" ? tab.symbol : tab.id)).sort(), ["AAPL", "NVDA"]);
  const nvda = tabs.find((tab) => tab.kind === "symbol" && tab.symbol === "NVDA");
  assert.equal(nvda?.kind === "symbol" && nvda.userAdded, false);
});

test("a user-sourced hidden symbol the agent has not re-charted stays gone", () => {
  // The preference-only path (no matching derived chart) is where `hidden` still applies —
  // it means "this was removed and nothing has revived it", not "veto the agent forever".
  const tabs = mergeTopicCharts(
    [derivedChart("AAPL")],
    [symbolPreference("MSFT", { hidden: true, sortOrder: 0 })],
  );
  assert.deepEqual(tabs.map((tab) => (tab.kind === "symbol" ? tab.symbol : tab.id)), ["AAPL"]);
});

test("a user-added symbol the agent never charted becomes an empty tab", () => {
  const tabs = mergeTopicCharts(
    [derivedChart("AAPL")],
    [symbolPreference("MSFT", { range: 252, sortOrder: 1 })],
  );
  const msft = tabs.find((tab) => tab.kind === "symbol" && tab.symbol === "MSFT");
  assert.equal(msft?.kind === "symbol" && msft.userAdded, true);
  assert.equal(msft?.kind === "symbol" && msft.studies.length, 0);
  assert.equal(msft?.kind === "symbol" && msft.range, 252);
  assert.equal(msft?.kind === "symbol" && msft.createdAt, null);
});

test("once the agent charts a user-added symbol the tab carries its studies", () => {
  const charted = derivedChart("MSFT");
  const tabs = mergeTopicCharts(
    [charted],
    [symbolPreference("MSFT", { sortOrder: 0 })],
  );
  assert.equal(tabs.length, 1);
  const msft = tabs[0];
  assert.equal(msft?.kind === "symbol" && msft.userAdded, false, "the agent's output supersedes the placeholder");
  assert.equal(msft?.kind === "symbol" && msft.createdAt, charted.createdAt);
});

test("a range preference overrides the derived range", () => {
  const tabs = mergeTopicCharts(
    [derivedChart("AAPL", 1)],
    [symbolPreference("AAPL", { range: 252, sortOrder: 0 })],
  );
  const aapl = tabs[0];
  assert.equal(aapl?.kind === "symbol" && aapl.range, 252);
});

test("a null range preference keeps the derived range", () => {
  const tabs = mergeTopicCharts(
    [derivedChart("AAPL", 252)],
    [symbolPreference("AAPL", { range: null, sortOrder: 0 })],
  );
  const aapl = tabs[0];
  assert.equal(aapl?.kind === "symbol" && aapl.range, 252);
});

test("explicit sortOrder decides the tab order", () => {
  const tabs = mergeTopicCharts(
    [derivedChart("AAPL"), derivedChart("NVDA"), derivedChart("MSFT")],
    [
      symbolPreference("MSFT", { sortOrder: 5 }),
      symbolPreference("NVDA", { sortOrder: 0 }),
      symbolPreference("AAPL", { sortOrder: 1 }),
    ],
  );
  assert.deepEqual(tabs.map((tab) => (tab.kind === "symbol" ? tab.symbol : tab.id)), ["NVDA", "AAPL", "MSFT"]);
});

test("a freshly charted symbol goes to the front, ahead of the user's ordered tabs", () => {
  const tabs = mergeTopicCharts(
    [derivedChart("AAPL"), derivedChart("NVDA")],
    [symbolPreference("NVDA", { sortOrder: 0 })],
  );
  // AAPL has no stored preference, so the agent just drew it — it is what the
  // user wants to see, and burying it behind the existing tabs would hide it.
  assert.deepEqual(tabs.map((tab) => (tab.kind === "symbol" ? tab.symbol : tab.id)), ["AAPL", "NVDA"]);
});

test("a batch of fresh symbols keeps the order the answer mentioned them in", () => {
  const tabs = mergeTopicCharts(
    [derivedChart("AAPL"), derivedChart("MSFT"), derivedChart("NVDA")],
    [symbolPreference("NVDA", { sortOrder: 0 })],
  );
  assert.deepEqual(tabs.map((tab) => (tab.kind === "symbol" ? tab.symbol : tab.id)), ["AAPL", "MSFT", "NVDA"]);
});

test("an unknown range string in a stored preference is ignored", () => {
  const tabs = mergeTopicCharts(
    [derivedChart("AAPL", 252)],
    // Deliberately ill-typed: a preference row outlives the build that wrote
    // it, so storage really can hand back something this build's type forbids.
    [symbolPreference("AAPL", { range: "not-a-range" as unknown as number, sortOrder: 0 })],
  );
  const aapl = tabs[0];
  assert.equal(aapl?.kind === "symbol" && aapl.range, 252, "a corrupt stored value must not break the chart");
});

// ── overlay tabs: kept, but never matched against derived charts ───────────

test("an overlay tab containing AAPL does not merge with the agent's freshly charted AAPL", () => {
  const tabs = mergeTopicCharts(
    [derivedChart("AAPL")],
    [overlayPreference("ov_1", ["AAPL", "NVDA"], { sortOrder: 0 })],
  );
  // Both survive as distinct tabs: one plain AAPL symbol tab (the agent's
  // fresh chart, unmatched by anything since overlays never participate in
  // that lookup), and one overlay tab that happens to also contain AAPL.
  assert.equal(tabs.length, 2);
  const symbolTab = tabs.find((tab) => tab.kind === "symbol");
  const overlayTab = tabs.find((tab) => tab.kind === "overlay");
  assert.equal(symbolTab?.kind === "symbol" && symbolTab.symbol, "AAPL");
  assert.equal(symbolTab?.kind === "symbol" && symbolTab.userAdded, false);
  assert.equal(overlayTab?.kind === "overlay" && overlayTab.id, "ov_1");
  assert.deepEqual(overlayTab?.kind === "overlay" && overlayTab.overlay.symbols, ["AAPL", "NVDA"]);
});

test("overlay tabs participate in sortOrder alongside symbol tabs", () => {
  const tabs = mergeTopicCharts(
    [derivedChart("AAPL")],
    [
      symbolPreference("AAPL", { sortOrder: 1 }),
      overlayPreference("ov_1", ["AAPL", "NVDA"], { sortOrder: 0 }),
    ],
  );
  assert.deepEqual(
    tabs.map((tab) => (tab.kind === "symbol" ? tab.symbol : tab.id)),
    ["ov_1", "AAPL"],
  );
});

test("a hidden overlay preference is dropped, same as a hidden symbol preference", () => {
  const tabs = mergeTopicCharts(
    [],
    [overlayPreference("ov_1", ["AAPL", "NVDA"], { hidden: true, sortOrder: 0 })],
  );
  assert.deepEqual(tabs, []);
});
