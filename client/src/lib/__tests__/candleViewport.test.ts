import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MIN_VISIBLE_CANDLES,
  panViewport,
  resolveViewport,
  zoomViewport,
} from "../candleViewport.ts";

const TOTAL = 200;

test("without a viewport the whole series is shown", () => {
  assert.deepEqual(resolveViewport(null, TOTAL), { start: 0, end: TOTAL });
});

test("zooming in shows fewer candles", () => {
  const zoomed = zoomViewport(null, TOTAL, 0.5, 0.5);
  const { start, end } = resolveViewport(zoomed, TOTAL);
  assert.equal(end - start, 100);
});

test("zooming out shows more", () => {
  const inOnce = zoomViewport(null, TOTAL, 0.25, 0.5);
  const back = zoomViewport(inOnce, TOTAL, 2, 0.5);
  const { start, end } = resolveViewport(back, TOTAL);
  assert.equal(end - start, 100);
});

test("zooming in stops at the floor rather than collapsing to one candle", () => {
  let viewport = zoomViewport(null, TOTAL, 0.5, 0.5);
  for (let step = 0; step < 20; step++) viewport = zoomViewport(viewport, TOTAL, 0.5, 0.5);
  const { start, end } = resolveViewport(viewport, TOTAL);
  assert.equal(end - start, MIN_VISIBLE_CANDLES);
});

test("zooming out stops at the whole series", () => {
  let viewport = zoomViewport(null, TOTAL, 0.5, 0.5);
  for (let step = 0; step < 20; step++) viewport = zoomViewport(viewport, TOTAL, 2, 0.5);
  assert.deepEqual(resolveViewport(viewport, TOTAL), { start: 0, end: TOTAL });
});

test("the candle under the cursor keeps its place when zooming", () => {
  // Anchored a quarter of the way in: that candle must still sit a quarter of the way in.
  const before = resolveViewport(null, TOTAL);
  const anchorIndex = before.start + 0.25 * (before.end - before.start);

  const zoomed = zoomViewport(null, TOTAL, 0.5, 0.25);
  const after = resolveViewport(zoomed, TOTAL);

  assert.equal(after.start + 0.25 * (after.end - after.start), anchorIndex);
});

test("zooming anchored at the right edge keeps the newest candle in view", () => {
  const zoomed = zoomViewport(null, TOTAL, 0.5, 1);
  assert.equal(resolveViewport(zoomed, TOTAL).end, TOTAL);
});

test("zooming anchored at the left edge keeps the oldest candle in view", () => {
  const zoomed = zoomViewport(null, TOTAL, 0.5, 0);
  assert.equal(resolveViewport(zoomed, TOTAL).start, 0);
});

test("panning backwards moves the window towards older candles", () => {
  const zoomed = zoomViewport(null, TOTAL, 0.5, 0.5);
  const before = resolveViewport(zoomed, TOTAL);
  const panned = panViewport(zoomed, TOTAL, -10);
  const after = resolveViewport(panned, TOTAL);

  assert.equal(after.start, before.start - 10);
  assert.equal(after.end, before.end - 10);
});

test("panning stops at the oldest candle", () => {
  let viewport = zoomViewport(null, TOTAL, 0.5, 0.5);
  for (let step = 0; step < 50; step++) viewport = panViewport(viewport, TOTAL, -20);
  assert.equal(resolveViewport(viewport, TOTAL).start, 0);
});

test("panning stops at the newest candle", () => {
  let viewport = zoomViewport(null, TOTAL, 0.5, 0.5);
  for (let step = 0; step < 50; step++) viewport = panViewport(viewport, TOTAL, 20);
  assert.equal(resolveViewport(viewport, TOTAL).end, TOTAL);
});

test("a window held at the right edge follows new candles as they arrive", () => {
  const zoomed = zoomViewport(null, TOTAL, 0.5, 1); // anchored right, so pinned
  const grown = resolveViewport(zoomed, TOTAL + 5);

  assert.equal(grown.end, TOTAL + 5, "still showing the latest");
  assert.equal(grown.end - grown.start, 100);
});

test("a window panned back stays on the same candles as new ones arrive", () => {
  const zoomed = zoomViewport(null, TOTAL, 0.5, 0.5);
  const panned = panViewport(zoomed, TOTAL, -30);
  const before = resolveViewport(panned, TOTAL);
  const after = resolveViewport(panned, TOTAL + 5);

  assert.deepEqual(after, before, "the user is reading history; it must not slide away");
});

test("panning back to the right edge re-pins the window", () => {
  const zoomed = zoomViewport(null, TOTAL, 0.5, 0.5);
  const away = panViewport(zoomed, TOTAL, -30);
  const home = panViewport(away, TOTAL, 500); // dragged well past the newest candle

  assert.equal(resolveViewport(home, TOTAL + 5).end, TOTAL + 5);
});

test("a viewport outliving a shorter series is brought back inside it", () => {
  // Switching the range preset replaces 200 candles with 30 while the viewport still describes
  // a window far past the end of the new series.
  const zoomed = panViewport(zoomViewport(null, 200, 0.5, 0.5), 200, -30);
  const { start, end } = resolveViewport(zoomed, 30);

  assert.ok(start >= 0 && end <= 30, `window ${start}..${end} escaped the series`);
  assert.equal(end - start, 30, "a series shorter than the window is shown whole");
});

test("a viewport wider than the series collapses to the series", () => {
  const zoomed = zoomViewport(null, 10, 0.5, 0.5);
  assert.deepEqual(resolveViewport(zoomed, 10), { start: 0, end: 10 });
});

test("an empty series resolves to an empty window", () => {
  assert.deepEqual(resolveViewport(null, 0), { start: 0, end: 0 });
  assert.deepEqual(resolveViewport(zoomViewport(null, 0, 0.5, 0.5), 0), { start: 0, end: 0 });
});

test("a series shorter than the floor is shown whole", () => {
  const zoomed = zoomViewport(null, 8, 0.5, 0.5);
  assert.deepEqual(resolveViewport(zoomed, 8), { start: 0, end: 8 });
});
