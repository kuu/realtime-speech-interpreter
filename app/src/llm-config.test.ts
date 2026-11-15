import { test } from "node:test";
import assert from "node:assert/strict";
import { llmConfig, translateEngine, translateFormality, langidSettleConfig, DEFAULT_LLM_MODEL_ID } from "./config.js";

function quiet<T>(fn: () => T): { out: T; warns: string[] } {
  const orig = console.error;
  const warns: string[] = [];
  console.error = (...a: unknown[]) => void warns.push(a.join(" "));
  try {
    return { out: fn(), warns };
  } finally {
    console.error = orig;
  }
}

test("defaults when unset", () => {
  const { out, warns } = quiet(() => llmConfig({}));
  assert.deepEqual(out, {
    modelId: DEFAULT_LLM_MODEL_ID,
    timeoutMs: 1500,
    contextChunks: 3,
    contextResetMs: 60000,
    glossary: "full",
    maxTokens: 400,
    breakerMs: 30000,
    skipBacklogMs: 0,
    parallelFallback: false,
    maxCharsPerWord: 15,
    keepWarmMs: 240000,
    promptVersion: 2,
  });
  assert.equal(warns.length, 0);
  assert.equal(translateEngine({}), "translate");
});

test("engine parsing", () => {
  assert.equal(translateEngine({ TRANSLATE_ENGINE: "llm" }), "llm");
  assert.equal(translateEngine({ TRANSLATE_ENGINE: " LLM " }), "llm");
  const { out, warns } = quiet(() => translateEngine({ TRANSLATE_ENGINE: "foo" }));
  assert.equal(out, "translate");
  assert.equal(warns.length, 1);
});

test("out of range or invalid values fall back with a WARN", () => {
  const { out, warns } = quiet(() =>
    llmConfig({
      LLM_TIMEOUT_MS: "5",
      LLM_CONTEXT_CHUNKS: "9",
      LLM_KEEPWARM_MS: "10",
      LLM_GLOSSARY: "compact",
      LLM_PARALLEL_FALLBACK: "maybe",
      LLM_MAX_TOKENS: "abc",
      LLM_BREAKER_MS: "-1",
      LLM_MAX_CHARS_PER_WORD: "100",
      LLM_SKIP_BACKLOG_MS: "99999999",
      LLM_CONTEXT_RESET_MS: "x",
      LLM_MODEL_ID: "",
      LLM_PROMPT_VERSION: "3",
    }),
  );
  assert.equal(out.timeoutMs, 1500);
  assert.equal(out.contextChunks, 3);
  assert.equal(out.keepWarmMs, 240000);
  assert.equal(out.glossary, "full");
  assert.equal(out.parallelFallback, false);
  assert.equal(out.maxTokens, 400);
  assert.equal(out.breakerMs, 30000);
  assert.equal(out.maxCharsPerWord, 15);
  assert.equal(out.skipBacklogMs, 0);
  assert.equal(out.contextResetMs, 60000);
  assert.equal(out.modelId, DEFAULT_LLM_MODEL_ID);
  assert.equal(out.promptVersion, 2);
  assert.equal(warns.length, 12);
});

test("valid values are used; keep-warm 0 means off; context 0 disables", () => {
  const { out, warns } = quiet(() =>
    llmConfig({
      LLM_KEEPWARM_MS: "0",
      LLM_CONTEXT_CHUNKS: "0",
      LLM_CONTEXT_RESET_MS: "0",
      LLM_TIMEOUT_MS: "1000",
      LLM_GLOSSARY: "off",
      LLM_PARALLEL_FALLBACK: "on",
      LLM_SKIP_BACKLOG_MS: "4500",
      LLM_MODEL_ID: "jp.anthropic.other-v1:0",
    }),
  );
  assert.equal(out.keepWarmMs, 0);
  assert.equal(out.contextChunks, 0);
  assert.equal(out.contextResetMs, 0);
  assert.equal(out.timeoutMs, 1000);
  assert.equal(out.glossary, "off");
  assert.equal(out.parallelFallback, true);
  assert.equal(out.skipBacklogMs, 4500);
  assert.equal(out.modelId, "jp.anthropic.other-v1:0");
  assert.equal(warns.length, 0);
});

test("LLM_PROMPT_VERSION accepts 1 and 2 only", () => {
  assert.equal(quiet(() => llmConfig({ LLM_PROMPT_VERSION: "1" })).out.promptVersion, 1);
  assert.equal(quiet(() => llmConfig({ LLM_PROMPT_VERSION: "2" })).out.promptVersion, 2);
  const bad = quiet(() => llmConfig({ LLM_PROMPT_VERSION: "v2" }));
  assert.equal(bad.out.promptVersion, 2);
  assert.equal(bad.warns.length, 1);
});
test("TRANSLATE_FORMALITY: FORMAL / INFORMAL / off are valid in any case and never warn (regression: FORMAL was rejected)", () => {
  for (const [raw, want] of [
    ["FORMAL", "FORMAL"],
    ["formal", "FORMAL"],
    [" Formal ", "FORMAL"],
    ["INFORMAL", "INFORMAL"],
    ["informal", "INFORMAL"],
    ["off", "off"],
    ["OFF", "off"],
  ] as const) {
    const { out, warns } = quiet(() => translateFormality({ TRANSLATE_FORMALITY: raw }));
    assert.equal(out, want, raw);
    assert.equal(warns.length, 0, raw);
  }
  const unset = quiet(() => translateFormality({}));
  assert.equal(unset.out, "FORMAL");
  assert.equal(unset.warns.length, 0);
  assert.equal(quiet(() => translateFormality({ TRANSLATE_FORMALITY: "" })).warns.length, 0);
});
test("TRANSLATE_FORMALITY: a really invalid value warns once and falls back to FORMAL", () => {
  const { out, warns } = quiet(() => translateFormality({ TRANSLATE_FORMALITY: "casual" }));
  assert.equal(out, "FORMAL");
  assert.equal(warns.length, 1);
  assert.match(warns[0], /TRANSLATE_FORMALITY="casual" invalid \(allowed FORMAL\|INFORMAL\|off\)/);
});
test("LANGID_SETTLE_*: defaults are fixed / 3 / 5 / 60000; valid values pass in any case without a WARN", () => {
  const d = quiet(() => langidSettleConfig({}));
  assert.deepEqual(d.out, { settleMode: "fixed", settleWordsDefault: 3, settleWordsAfterJa: 5, jaMemoryMs: 60000 });
  assert.equal(d.warns.length, 0);
  const v = quiet(() => langidSettleConfig({ LANGID_SETTLE_MODE: "DYNAMIC", LANGID_SETTLE_WORDS_DEFAULT: "2", LANGID_SETTLE_WORDS_AFTER_JA: "6", LANGID_JA_MEMORY_MS: "0" }));
  assert.deepEqual(v.out, { settleMode: "dynamic", settleWordsDefault: 2, settleWordsAfterJa: 6, jaMemoryMs: 0 });
  assert.equal(v.warns.length, 0);
  assert.equal(quiet(() => langidSettleConfig({ LANGID_SETTLE_MODE: " Fixed " })).out.settleMode, "fixed");
  assert.equal(quiet(() => langidSettleConfig({ LANGID_SETTLE_MODE: "" })).warns.length, 0);
});
test("LANGID_SETTLE_*: bad values fall back to the default with one WARN each", () => {
  const { out, warns } = quiet(() =>
    langidSettleConfig({ LANGID_SETTLE_MODE: "auto", LANGID_SETTLE_WORDS_DEFAULT: "0", LANGID_SETTLE_WORDS_AFTER_JA: "x", LANGID_JA_MEMORY_MS: "-5" }),
  );
  assert.deepEqual(out, { settleMode: "fixed", settleWordsDefault: 3, settleWordsAfterJa: 5, jaMemoryMs: 60000 });
  assert.equal(warns.length, 4);
  assert.match(warns[0], /LANGID_SETTLE_MODE="auto" invalid \(allowed fixed\|dynamic\)/);
});
