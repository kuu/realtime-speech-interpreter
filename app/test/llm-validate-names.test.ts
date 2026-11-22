import { test } from "node:test";
import assert from "node:assert/strict";
import { missingNames, validateLlmOutputEn } from "../src/llm-validate.js";

const GL: [string, string][] = [
  ["メディアライブ", "MediaLive"],
  ["ＡＷＳ", "AWS"],
  ["山田", "Yamada"], // 2 characters: skipped by the check
  ["エンコーダー", "Encoder"],
];
test("a name present in the source must be in the output (case-insensitive)", () => {
  assert.deepEqual(missingNames("メディアライブを使います。", "We use medialive.", GL), []);
  assert.deepEqual(missingNames("メディアライブを使います。", "We use the live service.", GL), ["MediaLive"]);
});
test("NFKC width folding: a half- or full-width spelling in the source matches the key", () => {
  assert.deepEqual(missingNames("AWSを使います。", "We use Amazon.", GL), ["AWS"]);
  assert.deepEqual(missingNames("ＡＷＳを使います。", "We use AWS.", GL), []);
});
test("keys of one or two characters are skipped", () => {
  assert.deepEqual(missingNames("山田さんが来ました。", "Mr. Smith came.", GL), []);
});
test("a key that is not in the source is not checked; no word boundary (substring)", () => {
  assert.deepEqual(missingNames("今日は晴れです。", "It is sunny.", GL), []);
  assert.deepEqual(missingNames("新エンコーダーです。", "It is new.", GL), ["Encoder"]);
});
test("English output validation: accepts plain English, rejects leaks, labels, markdown, tags and bad lengths", () => {
  const o = { source: "今日は新しい機能を紹介します。", glossary: GL, maxWordsPerChar: 1.2 };
  assert.deepEqual(validateLlmOutputEn("Today I will introduce a new feature.", o), { ok: true, text: "Today I will introduce a new feature." });
  const rule = (t: string) => {
    const r = validateLlmOutputEn(t, o);
    return r.ok ? "ok" : r.rule;
  };
  assert.equal(rule("今日は紹介します。"), "japanese-leak");
  assert.equal(rule("Translation: hello there"), "prefix");
  assert.equal(rule("Sure, here is the text"), "prefix");
  assert.equal(rule("**Hello**"), "markdown");
  assert.equal(rule("<new_chunk>Hello</new_chunk>"), "tag");
  assert.equal(rule("Line one\nLine two"), "multiline");
  assert.equal(rule(""), "empty");
  assert.equal(rule("。。。"), "not-english");
  assert.equal(rule("?!"), "not-english");
  assert.equal(rule("word ".repeat(80)), "too-long");
});
test("English output validation: empty output is fine for an empty source, a name with Japanese in the glossary is allowed", () => {
  assert.deepEqual(validateLlmOutputEn("", { source: "、", glossary: [], maxWordsPerChar: 1.2 }), { ok: true, text: "" });
  const gl: [string, string][] = [["いろは", "Iroha 色葉"]];
  assert.equal(validateLlmOutputEn("That is Iroha 色葉.", { source: "いろはです。", glossary: gl, maxWordsPerChar: 1.2 }).ok, true);
});
