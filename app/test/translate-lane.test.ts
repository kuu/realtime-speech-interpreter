// Translate request and engine selection per lane (node:test).
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { translateClient, translateText, translateTextFor } from "../src/translate-call.js";
import { config, llmConfig } from "../src/config.js";
import { LlmEngine, createTranslationEngine, directionOf, TranslateOnlyEngine } from "../src/translate-engine.js";
import { laneSettingsFor } from "../src/lane-settings.js";
import type { LlmClient, ConverseResult } from "../src/bedrock-llm.js";
import type { LlmRequest } from "../src/llm-prompt.js";

function capture() {
  const sent: any[] = [];
  const m = mock.method(translateClient, "send", async (cmd: any) => {
    sent.push(cmd.input);
    return { TranslatedText: "ok" };
  });
  return { sent, restore: () => m.mock.restore() };
}
test("English target: no Settings.Formality, the lane's terminology and languages", async () => {
  const c = capture();
  try {
    const lane = laneSettingsFor({ source: "ja-JP", target: "en", pollyVoice: "Joanna", transcribeVocabulary: "", translateTerminology: "t-ja-en" }, 1);
    await translateTextFor(lane.translate)("今日は晴れです。");
    assert.deepEqual(c.sent[0], { Text: "今日は晴れです。", SourceLanguageCode: "ja", TargetLanguageCode: "en", TerminologyNames: ["t-ja-en"] });
  } finally {
    c.restore();
  }
});
test("lane 1 request equals today's translateText request", async () => {
  const c = capture();
  try {
    const lane = laneSettingsFor({ source: "en-US", target: "ja", pollyVoice: config.polly.voiceId, transcribeVocabulary: "", translateTerminology: config.translate.terminologyName }, 0);
    await translateTextFor(lane.translate)("Hello.");
    await translateText("Hello.");
    assert.deepEqual(c.sent[0], c.sent[1]);
  } finally {
    c.restore();
  }
});
test("directionOf: ja-JP to en is ja-en, everything else en-ja", () => {
  assert.equal(directionOf({ source: "ja-JP", target: "en" }), "ja-en");
  assert.equal(directionOf({ source: "en-US", target: "ja" }), "en-ja");
});

const USAGE = { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 };
function jaEnEngine(llmText: string, translateText: string) {
  const llmCalls: LlmRequest[] = [];
  const llm: LlmClient = {
    converse: async (req): Promise<ConverseResult> => {
      llmCalls.push(req);
      return { text: llmText, stopReason: "end_turn", usage: USAGE };
    },
  };
  const translates: string[] = [];
  const logs: string[] = [];
  const engine = new LlmEngine({
    cfg: { ...llmConfig({}), timeoutMs: 200 },
    llm,
    translate: async (t) => {
      translates.push(t);
      return translateText;
    },
    glossary: [["メディアライブ", "MediaLive"]],
    direction: "ja-en",
    log: { info: (...a) => void logs.push(a.join(" ")), warn: (...a) => void logs.push(a.join(" ")), error: (...a) => void logs.push(a.join(" ")) },
  });
  return { engine, llmCalls, translates, logs };
}
test("ja-en LLM engine: own prompt, glossary lines `ja = en`, chunk flag from 。", async () => {
  const t = jaEnEngine("We use MediaLive today.", "unused");
  const r = await t.engine.translate({ text: "今日はメディアライブを使います。", previous: [] });
  assert.equal(r.engine, "llm");
  assert.equal(r.text, "We use MediaLive today.");
  const sys = (t.llmCalls[0].system[0] as { text: string }).text;
  assert.match(sys, /GLOSSARY \(Japanese = English\)\nメディアライブ = MediaLive/);
  assert.match(t.llmCalls[0].messages[0].content[0].text, /<chunk_ends_sentence>yes<\/chunk_ends_sentence>/);
  assert.equal(t.translates.length, 0);
});
test("ja-en LLM engine: a Japanese leak falls back to Translate for the chunk", async () => {
  const t = jaEnEngine("今日はメディアライブです。", "Translate says hi.");
  const r = await t.engine.translate({ text: "今日はメディアライブです。", previous: [] });
  assert.equal(r.engine, "fallback");
  assert.equal(r.fallbackReason, "validation-japanese-leak");
  assert.equal(r.text, "Translate says hi.");
});
test("ja-en LLM engine: a missing glossary name falls back to Translate (name-miss); a second miss is logged and used", async () => {
  const t = jaEnEngine("We use the live service today.", "We use the live tool.");
  const r = await t.engine.translate({ text: "今日はメディアライブを使います。", previous: [] });
  assert.equal(r.engine, "fallback");
  assert.equal(r.fallbackReason, "name-miss");
  assert.equal(r.text, "We use the live tool.");
  assert.ok(t.logs.some((l) => l.includes("name-miss after fallback")));
  assert.equal(t.translates.length, 1);
  assert.match(t.engine.summaryLine("lane") ?? "", /name-miss/);
});
test("ja-en LLM engine: when Translate keeps the name, the fallback is silent", async () => {
  const t = jaEnEngine("We use the live service today.", "We use MediaLive.");
  const r = await t.engine.translate({ text: "今日はメディアライブを使います。", previous: [] });
  assert.equal(r.text, "We use MediaLive.");
  assert.ok(!t.logs.some((l) => l.includes("name-miss after fallback")));
});
test("each lane's engine has its own circuit breaker and stats", () => {
  const a = jaEnEngine("x", "y").engine;
  const b = jaEnEngine("x", "y").engine;
  assert.notEqual(a.breaker, b.breaker);
  assert.notEqual(a.stats, b.stats);
});
test("createTranslationEngine with a lane: translate engine for a Translate lane; direction and glossary name for an LLM lane", async () => {
  const lane = laneSettingsFor({ source: "ja-JP", target: "en", pollyVoice: "Joanna", transcribeVocabulary: "", translateTerminology: "t-ja-en", translateEngine: "translate" }, 1);
  const eng = await createTranslationEngine({ lane, translate: async () => "x" });
  assert.ok(eng instanceof TranslateOnlyEngine);
  const llmLane = laneSettingsFor({ source: "ja-JP", target: "en", pollyVoice: "Joanna", transcribeVocabulary: "", translateTerminology: "t-ja-en", translateEngine: "llm" }, 1);
  let loaded = 0;
  const eng2 = await createTranslationEngine({
    lane: llmLane,
    translate: async () => "x",
    makeLlm: () => ({ converse: async () => ({ text: "Hi.", stopReason: "end_turn", usage: USAGE }) }),
    loadGlossary: async () => {
      loaded++;
      return [["メディアライブ", "MediaLive"]];
    },
    cfg: { ...llmConfig({}), keepWarmMs: 0 },
  });
  assert.equal(eng2.name, "llm");
  assert.equal(loaded, 1);
  eng2.dispose();
});
