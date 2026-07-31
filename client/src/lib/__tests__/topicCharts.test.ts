import test from "node:test";
import assert from "node:assert/strict";
import { mergeTopicCharts } from "../topicCharts.ts";
import type { SymbolChartWorkspace } from "../chartWorkspace.ts";

const derivedChart = (symbol: string, range = "1D"): SymbolChartWorkspace => ({
  symbol,
  range: range as SymbolChartWorkspace["range"],
  createdAt: 1_700_000_000_000,
  studies: [],
});

test("with no preferences the derived tabs pass through in order", () => {
  const tabs = mergeTopicCharts([derivedChart("AAPL"), derivedChart("NVDA")], []);
  assert.deepEqual(tabs.map((tab) => tab.symbol), ["AAPL", "NVDA"]);
  assert.equal(tabs.every((tab) => !tab.userAdded), true);
});

test("an agent-sourced change (re-derived chart data) revives a hidden symbol", () => {
  // Spec §6: the controller has full authority over layout; hidden is not a veto over it.
  const tabs = mergeTopicCharts(
    [derivedChart("AAPL"), derivedChart("NVDA")],
    [{ symbol: "NVDA", range: null, hidden: true, sortOrder: 0 }],
  );
  assert.deepEqual(tabs.map((tab) => tab.symbol).sort(), ["AAPL", "NVDA"]);
  assert.equal(tabs.find((tab) => tab.symbol === "NVDA")?.userAdded, false);
});

test("a user-sourced hidden symbol the agent has not re-charted stays gone", () => {
  // The preference-only path (no matching derived chart) is where `hidden` still applies —
  // it means "this was removed and nothing has revived it", not "veto the agent forever".
  const tabs = mergeTopicCharts(
    [derivedChart("AAPL")],
    [{ symbol: "MSFT", range: null, hidden: true, sortOrder: 0 }],
  );
  assert.deepEqual(tabs.map((tab) => tab.symbol), ["AAPL"]);
});

test("a user-added symbol the agent never charted becomes an empty tab", () => {
  const tabs = mergeTopicCharts(
    [derivedChart("AAPL")],
    [{ symbol: "MSFT", range: "1Y", hidden: false, sortOrder: 1 }],
  );
  const msft = tabs.find((tab) => tab.symbol === "MSFT");
  assert.equal(msft?.userAdded, true);
  assert.deepEqual(msft?.studies, []);
  assert.equal(msft?.range, "1Y");
  assert.equal(msft?.createdAt, null);
});

test("once the agent charts a user-added symbol the tab carries its studies", () => {
  const charted = derivedChart("MSFT");
  const tabs = mergeTopicCharts(
    [charted],
    [{ symbol: "MSFT", range: null, hidden: false, sortOrder: 0 }],
  );
  assert.equal(tabs.length, 1);
  assert.equal(tabs[0]?.userAdded, false, "the agent's output supersedes the placeholder");
  assert.equal(tabs[0]?.createdAt, charted.createdAt);
});

test("a range preference overrides the derived range", () => {
  const tabs = mergeTopicCharts(
    [derivedChart("AAPL", "1D")],
    [{ symbol: "AAPL", range: "1Y", hidden: false, sortOrder: 0 }],
  );
  assert.equal(tabs[0]?.range, "1Y");
});

test("a null range preference keeps the derived range", () => {
  const tabs = mergeTopicCharts(
    [derivedChart("AAPL", "1Y")],
    [{ symbol: "AAPL", range: null, hidden: false, sortOrder: 0 }],
  );
  assert.equal(tabs[0]?.range, "1Y");
});

test("explicit sortOrder decides the tab order", () => {
  const tabs = mergeTopicCharts(
    [derivedChart("AAPL"), derivedChart("NVDA"), derivedChart("MSFT")],
    [
      { symbol: "MSFT", range: null, hidden: false, sortOrder: 5 },
      { symbol: "NVDA", range: null, hidden: false, sortOrder: 0 },
      { symbol: "AAPL", range: null, hidden: false, sortOrder: 1 },
    ],
  );
  assert.deepEqual(tabs.map((tab) => tab.symbol), ["NVDA", "AAPL", "MSFT"]);
});

test("a freshly charted symbol goes to the front, ahead of the user's ordered tabs", () => {
  const tabs = mergeTopicCharts(
    [derivedChart("AAPL"), derivedChart("NVDA")],
    [{ symbol: "NVDA", range: null, hidden: false, sortOrder: 0 }],
  );
  // AAPL has no stored preference, so the agent just drew it — it is what the
  // user wants to see, and burying it behind the existing tabs would hide it.
  assert.deepEqual(tabs.map((tab) => tab.symbol), ["AAPL", "NVDA"]);
});

test("a batch of fresh symbols keeps the order the answer mentioned them in", () => {
  const tabs = mergeTopicCharts(
    [derivedChart("AAPL"), derivedChart("MSFT"), derivedChart("NVDA")],
    [{ symbol: "NVDA", range: null, hidden: false, sortOrder: 0 }],
  );
  assert.deepEqual(tabs.map((tab) => tab.symbol), ["AAPL", "MSFT", "NVDA"]);
});

test("an unknown range string in a stored preference is ignored", () => {
  const tabs = mergeTopicCharts(
    [derivedChart("AAPL", "1Y")],
    [{ symbol: "AAPL", range: "not-a-range", hidden: false, sortOrder: 0 }],
  );
  assert.equal(tabs[0]?.range, "1Y", "a corrupt stored value must not break the chart");
});
