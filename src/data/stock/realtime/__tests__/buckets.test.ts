import { test } from "node:test";
import assert from "node:assert/strict";
import { createBucketBuffer } from "../buckets.ts";

const BUCKET_MS = 500;

test("prices inside one bucket collapse into a single sample keeping the extremes", () => {
  const buffer = createBucketBuffer();
  buffer.append(100, 1_000);
  buffer.append(105, 1_200);
  buffer.append(98, 1_400);
  buffer.append(101, 1_499);

  const window = buffer.window(60_000, 1_500);
  assert.equal(window.length, 1);
  assert.deepEqual(window[0], { ts: 1_000, high: 105, low: 98, close: 101 });
});

test("crossing a bucket boundary seals the previous bucket and opens a new one", () => {
  const buffer = createBucketBuffer();
  buffer.append(100, 1_000);
  buffer.append(110, 1_499);
  buffer.append(90, 1_500);

  const window = buffer.window(60_000, 1_600);
  assert.equal(window.length, 2);
  assert.deepEqual(window[0], { ts: 1_000, high: 110, low: 100, close: 110 });
  assert.deepEqual(window[1], { ts: 1_500, high: 90, low: 90, close: 90 });
});

test("the still-open current bucket is included in the window", () => {
  const buffer = createBucketBuffer();
  buffer.append(100, 1_000);

  // Nothing has crossed the boundary yet, so the bucket is unsealed.
  const window = buffer.window(60_000, 1_100);
  assert.equal(window.length, 1);
  assert.equal(window[0]!.close, 100);
});

test("window excludes buckets older than the requested span", () => {
  const buffer = createBucketBuffer();
  buffer.append(100, 10_000);
  buffer.append(200, 40_000);
  buffer.append(300, 70_000);

  const window = buffer.window(35_000, 70_500);
  assert.deepEqual(window.map((sample) => sample.close), [200, 300]);
});

test("the ring wraps: writing past capacity drops the oldest buckets, not the newest", () => {
  // A 5-second window at 500ms is 10 slots; write 13 buckets through it.
  const buffer = createBucketBuffer({ windowMs: 5_000 });
  for (let index = 0; index < 13; index++) {
    buffer.append(index, index * BUCKET_MS);
  }

  const window = buffer.window(5_000, 13 * BUCKET_MS);
  assert.equal(window.length, 10);
  assert.deepEqual(window.map((sample) => sample.close), [3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
});

test("isArmed is false until the buffer spans the requested window", () => {
  const buffer = createBucketBuffer();
  buffer.append(100, 10_000);
  buffer.append(101, 40_000);

  assert.equal(buffer.isArmed(60_000, 40_000), false);
  assert.equal(buffer.isArmed(20_000, 40_000), true);
});

test("isArmed is false on an empty buffer", () => {
  const buffer = createBucketBuffer();
  assert.equal(buffer.isArmed(60_000, 1_000), false);
});

test("seeding with backfilled bars arms the buffer without waiting for the stream", () => {
  const buffer = createBucketBuffer();
  buffer.seed([
    { ts: 0, high: 101, low: 99, close: 100 },
    { ts: 60_000, high: 103, low: 100, close: 102 },
  ]);

  assert.equal(buffer.isArmed(60_000, 60_000), true);
  assert.deepEqual(buffer.window(120_000, 60_000).map((sample) => sample.close), [100, 102]);
});

test("streamed prices continue to land after a seed", () => {
  const buffer = createBucketBuffer();
  buffer.seed([{ ts: 0, high: 101, low: 99, close: 100 }]);
  buffer.append(105, 60_000);

  assert.deepEqual(buffer.window(120_000, 60_000).map((sample) => sample.close), [100, 105]);
});

test("out-of-order samples older than the current bucket are ignored", () => {
  const buffer = createBucketBuffer();
  buffer.append(100, 5_000);
  buffer.append(999, 1_000);

  const window = buffer.window(60_000, 5_100);
  assert.equal(window.length, 1);
  assert.equal(window[0]!.close, 100);
});

test("latest returns the most recent close, or undefined when empty", () => {
  const buffer = createBucketBuffer();
  assert.equal(buffer.latest(), undefined);
  buffer.append(100, 1_000);
  buffer.append(107, 1_600);
  assert.equal(buffer.latest(), 107);
});
