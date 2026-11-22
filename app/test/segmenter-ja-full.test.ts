// Japanese segmenter, full mode (opt-in experiment): rules 1 to 7, dangling test D, merge-short (node:test).
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { JaSegmenter, type JaSegmenterOptions } from "../src/segmenter-ja.js";
import { JA_DEFAULT_CLAUSE_ENDINGS, JA_DEFAULT_DANGLING_TOKENS } from "../src/ja-defaults.js";
import { jaSegmentationConfig } from "../src/config.js";
import type { Chunk } from "../src/segmenter.js";
import { jaFinal, jaPartial } from "./fixtures/ja-stream.js";

const FULL: JaSegmenterOptions = {
  mode: "full", maxWaitMs: 4000, mergeShort: false, sentenceMinChars: 6, mergePauseMs: 1500, mergeMaxHoldMs: 6000,
  clauseMinChars: 12, maxChars: 40, pauseMs: 900, clauseEndings: JA_DEFAULT_CLAUSE_ENDINGS, danglingTokens: JA_DEFAULT_DANGLING_TOKENS,
  danglingMaxChars: 10,
};
function make(opts: Partial<JaSegmenterOptions> = {}) {
  const chunks: Chunk[] = [];
  const seg = new JaSegmenter({ ...FULL, ...opts }, (c) => chunks.push(c));
  return { seg, chunks, texts: () => chunks.map((c) => `${c.reason}|${c.english}`) };
}
function quiet<T>(fn: () => T): T {
  const l = mock.method(console, "log", () => {});
  const e = mock.method(console, "error", () => {});
  try {
    return fn();
  } finally {
    l.mock.restore();
    e.mock.restore();
  }
}
const W = (n: number) => Array.from({ length: n }, () => "あいう"); // n tokens of 3 characters

test("rule 1: a stable 。 always cuts, even a short sentence and even after a dangling token (D not applied)", () => {
  const { seg, texts } = make();
  quiet(() => seg.onResult(jaPartial("a", ["はい", "。", "今日", "は", "が", "。"]), 1000));
  assert.deepEqual(texts(), ["sentence|はい。", "sentence|今日はが。"]);
});
test("rule 2: a stable 、 cuts only with clauseMinChars and when D is false", () => {
  const short = make();
  quiet(() => short.seg.onResult(jaPartial("a", ["はい", "、", "ええ"]), 1000));
  assert.deepEqual(short.texts(), [], "2 characters: no cut");
  const long = make();
  quiet(() => long.seg.onResult(jaPartial("a", ["本日", "は", "新しい", "機能", "を", "紹介", "し", "ます", "、", "続き"]), 1000));
  assert.deepEqual(long.texts(), ["clause|本日は新しい機能を紹介します、"]);
  const dangling = make();
  quiet(() => dangling.seg.onResult(jaPartial("a", ["本日", "は", "新しい", "機能", "を", "紹介", "し", "ます", "が", "、", "続き"]), 1000));
  assert.deepEqual(dangling.texts(), [], "last token before 、 is a dangling particle");
});
test("rule 3: a clause ending closes the chunk after a quiet pauseMs", () => {
  const { seg, texts } = make();
  quiet(() => seg.onResult(jaPartial("a", ["今日", "は", "時間", "が", "あまり", "ない", "ので"]), 1000));
  quiet(() => seg.tick(1899));
  assert.deepEqual(texts(), []);
  quiet(() => seg.tick(1900));
  assert.deepEqual(texts(), ["ending|今日は時間があまりないので"]);
});
test("rule 3 needs clauseMinChars", () => {
  const { seg, texts } = make();
  quiet(() => seg.onResult(jaPartial("a", ["時間", "ない", "ので"]), 1000));
  quiet(() => seg.tick(1900)); // pause rule instead
  assert.deepEqual(texts(), ["pause|時間ないので"]);
});
test("rule 4: maxChars cuts at the end when nothing dangles", () => {
  const { seg, texts } = make();
  quiet(() => seg.onResult(jaPartial("a", W(14)), 1000)); // 42 characters
  assert.deepEqual(texts(), [`maxchars|${W(14).join("")}`]);
});
test("rule 4: a dangling token at the limit moves the cut back within danglingMaxChars", () => {
  const { seg, texts } = make();
  quiet(() => seg.onResult(jaPartial("a", [...W(13), "は"]), 1000)); // 39 + 1 = 40 characters, last token dangles
  assert.deepEqual(texts(), [`maxchars|${W(13).join("")}`]);
  quiet(() => seg.endOfStream("eof", 1100));
  assert.deepEqual(texts(), [`maxchars|${W(13).join("")}`, "eof|は"]);
});
test("rule 4: prefers the last 、 (D false) within the look-back", () => {
  const { seg, texts } = make({ clauseMinChars: 100 }); // rule 2 off for this test
  quiet(() => seg.onResult(jaPartial("a", [...W(12), "、", ...W(2)]), 1000)); // 42 characters, 、 after 36
  assert.deepEqual(texts(), [`maxchars|${W(12).join("")}、`]);
});
test("rule 4: with no dangling-free boundary in the look-back the cut is at the end", () => {
  const { seg, texts } = make({ danglingTokens: ["あいう"], clauseEndings: [] });
  quiet(() => seg.onResult(jaPartial("a", W(14)), 1000));
  assert.equal(texts().length, 1);
  assert.match(texts()[0], /^maxchars\|/);
  assert.equal(seg.pendingTokens, 0);
});
test("rule 5: pause cuts after a quiet pauseMs unless D is true", () => {
  const ok = make();
  quiet(() => ok.seg.onResult(jaPartial("a", ["今日", "は", "晴れ", "です"]), 1000));
  quiet(() => ok.seg.tick(1900));
  assert.deepEqual(ok.texts(), ["pause|今日は晴れです"]);
  const held = make();
  quiet(() => held.seg.onResult(jaPartial("a", ["今日", "は", "晴れ", "の"]), 1000));
  quiet(() => held.seg.tick(1900));
  assert.deepEqual(held.texts(), [], "dangling: the pause cut waits");
});
test("rule 6: max wait cuts a dangling tail one token back (look-back), keeping the dangling token for the next chunk", () => {
  const { seg, texts } = make();
  quiet(() => seg.onResult(jaPartial("a", ["今日", "は", "晴れ", "の"]), 1000));
  quiet(() => seg.tick(5000));
  assert.deepEqual(texts(), ["maxwait|今日は晴れ"]);
  assert.equal(seg.pendingTokens, 1);
});
test("rule 7: the final always cuts, D is not applied", () => {
  const { seg, texts } = make();
  quiet(() => seg.onResult(jaFinal("a", ["今日", "は", "晴れ", "が"]), 1000));
  assert.deepEqual(texts(), ["final|今日は晴れが"]);
});
test("merge-short on holds a short sentence; off cuts it", () => {
  const on = make({ mergeShort: true });
  quiet(() => on.seg.onResult(jaPartial("a", ["はい", "。", "では", "始め", "ます", "。"]), 1000));
  assert.deepEqual(on.texts(), ["sentence|はい。では始めます。"]);
  const off = make({ mergeShort: false });
  quiet(() => off.seg.onResult(jaPartial("a", ["はい", "。", "では", "始め", "ます", "。"]), 1000));
  assert.deepEqual(off.texts(), ["sentence|はい。", "sentence|では始めます。"]);
});
test("a held short sentence is not cut by the pause rule; the merge pause releases it", () => {
  const { seg, texts } = make({ mergeShort: true });
  quiet(() => seg.onResult(jaFinal("a", ["はい", "。"]), 1000));
  quiet(() => seg.tick(2000));
  assert.deepEqual(texts(), []);
  quiet(() => seg.tick(2500));
  assert.deepEqual(texts(), ["merge_pause|はい。"]);
});
test("every chunk carries exactly one reason and reasons are counted", () => {
  const { seg, chunks } = make();
  quiet(() => seg.onResult(jaPartial("a", ["本日", "は", "新しい", "機能", "を", "紹介", "し", "ます", "、", "続き", "を", "どうぞ", "。"]), 1000));
  quiet(() => seg.endOfStream("eof", 1100));
  assert.ok(chunks.length >= 2);
  const counted = Object.values(seg.reasons).reduce((a, b) => a + (b ?? 0), 0);
  assert.equal(counted, chunks.length);
});

// ---- config ----
test("config: defaults are simple mode with the documented values", () => {
  const c = jaSegmentationConfig({});
  assert.equal(c.mode, "simple");
  assert.equal(c.maxWaitMs, 4000);
  assert.equal(c.sentenceMinChars, 6);
  assert.equal(c.clauseMinChars, 12);
  assert.equal(c.maxChars, 40);
  assert.equal(c.pauseMs, 900);
  assert.equal(c.danglingMaxChars, 10);
});
test("config: values from the environment; invalid values fall back with a warning", () => {
  const warn = mock.method(console, "error", () => {});
  try {
    const ok = jaSegmentationConfig({ JA_SEGMENTATION_MODE: "full", JA_MAX_WAIT_MS: "2500", JA_PAUSE_MS: "600" });
    assert.equal(ok.mode, "full");
    assert.equal(ok.maxWaitMs, 2500);
    assert.equal(ok.pauseMs, 600);
    const bad = jaSegmentationConfig({ JA_SEGMENTATION_MODE: "clause", JA_MAX_WAIT_MS: "-1" });
    assert.equal(bad.mode, "simple");
    assert.equal(bad.maxWaitMs, 4000);
    assert.ok(warn.mock.callCount() >= 2);
  } finally {
    warn.mock.restore();
  }
});
test("config: overlapping endings and dangling lists are rejected (both fall back to the built-in lists)", () => {
  const warn = mock.method(console, "error", () => {});
  try {
    const c = jaSegmentationConfig({ JA_CLAUSE_ENDINGS: "ので,が", JA_DANGLING_TOKENS: "が,を" });
    assert.deepEqual(c.clauseEndings, [...JA_DEFAULT_CLAUSE_ENDINGS]);
    assert.deepEqual(c.danglingTokens, [...JA_DEFAULT_DANGLING_TOKENS]);
    assert.equal(warn.mock.callCount(), 1);
    const fine = jaSegmentationConfig({ JA_CLAUSE_ENDINGS: "ので", JA_DANGLING_TOKENS: "が,を" });
    assert.deepEqual(fine.clauseEndings, ["ので"]);
    assert.deepEqual(fine.danglingTokens, ["が", "を"]);
  } finally {
    warn.mock.restore();
  }
});
test("the built-in lists share no entry", () => {
  assert.deepEqual(JA_DEFAULT_CLAUSE_ENDINGS.filter((e) => JA_DEFAULT_DANGLING_TOKENS.includes(e)), []);
});
