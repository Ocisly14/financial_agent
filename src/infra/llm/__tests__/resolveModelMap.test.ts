import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveModelMap } from "../provider.ts";

const DEFAULTS = { SMALL: "small-default", MEDIUM: "medium-default", LARGE: "large-default" } as const;

test("falls back to the provider's own defaults when nothing is configured", () => {
  const models = resolveModelMap(DEFAULTS, ["ANTHROPIC"], {});
  assert.deepEqual(models, { SMALL: "small-default", MEDIUM: "medium-default", LARGE: "large-default" });
});

test("a prefixed override replaces only the class it names", () => {
  const models = resolveModelMap(DEFAULTS, ["ANTHROPIC"], { ANTHROPIC_MODEL_MEDIUM: "claude-sonnet-5" });
  assert.deepEqual(models, { SMALL: "small-default", MEDIUM: "claude-sonnet-5", LARGE: "large-default" });
});

test("treats a declared-but-empty override as unset", () => {
  const models = resolveModelMap(DEFAULTS, ["ANTHROPIC"], { ANTHROPIC_MODEL_SMALL: "" });
  assert.equal(models.SMALL, "small-default");
});

test("ignores another provider's overrides", () => {
  const models = resolveModelMap(DEFAULTS, ["DEEPSEEK"], {
    ANTHROPIC_MODEL_MEDIUM: "claude-sonnet-5",
    GOOGLE_MODEL_MEDIUM: "gemini-2.5-flash",
  });
  assert.equal(models.MEDIUM, "medium-default");
});

test("ignores the removed provider-agnostic LLM_MODEL_* variables", () => {
  const models = resolveModelMap(DEFAULTS, ["DEEPSEEK"], {
    LLM_MODEL_SMALL: "claude-haiku-4-5-20251001",
    LLM_MODEL_MEDIUM: "claude-sonnet-5",
    LLM_MODEL_LARGE: "claude-opus-5",
  });
  assert.deepEqual(models, { SMALL: "small-default", MEDIUM: "medium-default", LARGE: "large-default" });
});

test("an earlier prefix wins over a later fallback prefix", () => {
  const models = resolveModelMap(DEFAULTS, ["VERTEX", "GOOGLE"], {
    VERTEX_MODEL_LARGE: "gemini-3.1-pro-preview",
    GOOGLE_MODEL_LARGE: "gemini-2.5-pro",
  });
  assert.equal(models.LARGE, "gemini-3.1-pro-preview");
});

test("a later prefix supplies classes the earlier one leaves unset", () => {
  const models = resolveModelMap(DEFAULTS, ["VERTEX", "GOOGLE"], {
    VERTEX_MODEL_LARGE: "gemini-3.1-pro-preview",
    GOOGLE_MODEL_SMALL: "gemini-2.5-flash",
  });
  assert.deepEqual(models, {
    SMALL: "gemini-2.5-flash",
    MEDIUM: "medium-default",
    LARGE: "gemini-3.1-pro-preview",
  });
});
