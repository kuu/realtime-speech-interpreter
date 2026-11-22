import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SYSTEM_PROMPT_JA_EN_TEMPLATE,
  buildSystemTextJaEn,
  buildUserTextJaEn,
  buildConverseRequestJaEn,
  chunkEndsSentenceJa,
  maxTokensForJa,
} from "../src/llm-prompt-ja-en.js";
import { SYSTEM_PROMPT_TEMPLATE, STOP_SEQUENCES } from "../src/llm-prompt.js";

test("template: English-only output, glossary names as written, no invented subject, Western name order, fillers dropped", () => {
  const t = SYSTEM_PROMPT_JA_EN_TEMPLATE;
  assert.match(t, /Output English only/);
  assert.match(t, /exactly as written in the GLOSSARY/);
  assert.match(t, /katakana/);
  assert.match(t, /do NOT invent a subject/);
  assert.match(t, /Western order \(given name first\) unless the GLOSSARY says otherwise/);
  assert.match(t, /Do not translate fillers/);
  assert.match(t, /chunk_ends_sentence/);
  assert.match(t, /GLOSSARY \(Japanese = English\)\n\{\{GLOSSARY\}\}$/);
});
test("the English-to-Japanese template is untouched and different", () => {
  assert.notEqual(SYSTEM_PROMPT_TEMPLATE, SYSTEM_PROMPT_JA_EN_TEMPLATE);
  assert.match(SYSTEM_PROMPT_TEMPLATE, /GLOSSARY \(English = Japanese\)/);
});
test("glossary lines are inserted verbatim, '$' sequences included", () => {
  const s = buildSystemTextJaEn("メディアライブ = MediaLive\n価格$& = Price$&");
  assert.ok(s.endsWith("メディアライブ = MediaLive\n価格$& = Price$&"));
  assert.ok(!s.includes("{{GLOSSARY}}"));
});
test("chunk_ends_sentence follows 。？！ and ASCII ? ! with closing quotes, not 、", () => {
  for (const t of ["今日は晴れです。", "本当ですか？", "すごい！", "本当?", "「行きます。」", "行きます。）"]) assert.equal(chunkEndsSentenceJa(t), true, t);
  for (const t of ["今日は晴れで、", "今日は晴れ", "そして"]) assert.equal(chunkEndsSentenceJa(t), false, t);
});
test("user text: previous as JA/EN pairs, the flag, the chunk; empty previous uses the start marker", () => {
  const u = buildUserTextJaEn([{ ja: "こんにちは。", en: "Hello." }], "今日は晴れです、", false);
  assert.equal(u, "<previous>\nJA: こんにちは。\nEN: Hello.\n</previous>\n<chunk_ends_sentence>no</chunk_ends_sentence>\n<new_chunk>今日は晴れです、</new_chunk>");
  assert.match(buildUserTextJaEn([], "はい。", true), /^<previous>\n\(none, this is the start of the talk\)\n<\/previous>\n<chunk_ends_sentence>yes/);
});
test("request: system with cache point, stop sequences, temperature 0, max tokens from the character count", () => {
  const r = buildConverseRequestJaEn({ modelId: "m", system: "S", previous: [], chunk: "今日は晴れです。", maxTokens: 400, cache: true, endsSentence: true });
  assert.deepEqual(r.system, [{ text: "S" }, { cachePoint: { type: "default" } }]);
  assert.deepEqual(r.inferenceConfig.stopSequences, [...STOP_SEQUENCES]);
  assert.equal(r.inferenceConfig.temperature, 0);
  assert.equal(r.inferenceConfig.maxTokens, 48);
  assert.equal(maxTokensForJa(100, 400), 300);
  assert.equal(maxTokensForJa(500, 400), 400);
  const n = buildConverseRequestJaEn({ modelId: "m", system: "S", previous: [], chunk: "あ", maxTokens: 400, cache: false, endsSentence: false });
  assert.deepEqual(n.system, [{ text: "S" }]);
});
