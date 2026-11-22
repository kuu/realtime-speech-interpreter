// Japanese segmenter, simple mode (default): stable 。？！, every stable 、, max wait, final (node:test).
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { JaSegmenter, joinJapanese, type JaSegmenterOptions } from "../src/segmenter-ja.js";
import { JA_DEFAULT_CLAUSE_ENDINGS, JA_DEFAULT_DANGLING_TOKENS } from "../src/ja-defaults.js";
import type { Chunk } from "../src/segmenter.js";
import { jaFinal, jaPartial, rng, WORDS, SEPS } from "./fixtures/ja-stream.js";

export const SIMPLE: JaSegmenterOptions = {
  mode: "simple", maxWaitMs: 4000, mergeShort: false, sentenceMinChars: 6, mergePauseMs: 1500, mergeMaxHoldMs: 6000,
  clauseMinChars: 12, maxChars: 40, pauseMs: 900, clauseEndings: JA_DEFAULT_CLAUSE_ENDINGS, danglingTokens: JA_DEFAULT_DANGLING_TOKENS,
  danglingMaxChars: 10,
};
function make(opts: Partial<JaSegmenterOptions> = {}) {
  const chunks: Chunk[] = [];
  const seg = new JaSegmenter({ ...SIMPLE, ...opts }, (c) => chunks.push(c));
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

test("cuts at a stable 。 and at every stable 、, with no minimum length", () => {
  const { seg, texts } = make();
  quiet(() => seg.onResult(jaPartial("a", ["はい", "、", "今日", "は", "晴れ", "です", "。"]), 1000));
  assert.deepEqual(texts(), ["clause|はい、", "sentence|今日は晴れです。"]);
});
test("an unstable punctuation mark is not a cut point", () => {
  const { seg, texts } = make();
  quiet(() => seg.onResult(jaPartial("a", ["今日", "は", "晴れ", "、", "です"], 3), 1000));
  assert.deepEqual(texts(), []);
  quiet(() => seg.onResult(jaPartial("a", ["今日", "は", "晴れ", "、", "です", "。"], 6), 1100));
  assert.deepEqual(texts(), ["clause|今日は晴れ、", "sentence|です。"]);
});
test("？ and ！ (and ASCII ? !) end a sentence", () => {
  const { seg, texts } = make();
  quiet(() => seg.onResult(jaPartial("a", ["本当", "です", "か", "？", "はい", "！", "そう", "?"]), 1000));
  assert.deepEqual(texts(), ["sentence|本当ですか？", "sentence|はい！", "sentence|そう?"]);
});
test("a closing quote stays with the chunk it closes; 「 and 」 are not cut points", () => {
  const { seg, texts } = make();
  quiet(() => seg.onResult(jaPartial("a", ["彼", "は", "「", "行き", "ます", "。", "」", "と", "言い", "ました", "。"]), 1000));
  assert.deepEqual(texts(), ["sentence|彼は「行きます。」", "sentence|と言いました。"]);
});
test("max wait cuts the oldest stable text, nothing earlier", () => {
  const { seg, texts } = make({ maxWaitMs: 4000 });
  quiet(() => seg.onResult(jaPartial("a", ["これ", "は", "長い"]), 1000));
  quiet(() => seg.tick(4900));
  assert.deepEqual(texts(), []);
  quiet(() => seg.tick(5000));
  assert.deepEqual(texts(), ["maxwait|これは長い"]);
});
test("max wait 0 disables the wait rule", () => {
  const { seg, texts } = make({ maxWaitMs: 0 });
  quiet(() => seg.onResult(jaPartial("a", ["これ", "は", "長い"]), 1000));
  quiet(() => seg.tick(900000));
  assert.deepEqual(texts(), []);
});
test("the final commits the rest, including unstable items", () => {
  const { seg, texts } = make();
  quiet(() => seg.onResult(jaPartial("a", ["今日", "は", "晴れ"], 2), 1000));
  assert.deepEqual(texts(), []);
  quiet(() => seg.onResult(jaFinal("a", ["今日", "は", "晴れ", "です"]), 1200));
  assert.deepEqual(texts(), ["final|今日は晴れです"]);
});
test("end of stream flushes an open partial as eof or error", () => {
  const a = make();
  quiet(() => a.seg.onResult(jaPartial("a", ["今日", "は"], 1), 1000));
  quiet(() => a.seg.endOfStream("eof", 2000));
  assert.deepEqual(a.texts(), ["eof|今日は"]);
  const b = make();
  quiet(() => b.seg.onResult(jaPartial("a", ["今日", "は"], 2), 1000));
  quiet(() => b.seg.endOfStream("error", 2000));
  assert.deepEqual(b.texts(), ["error|今日は"]);
});
test("a split result: text of the next result continues without loss or repeat", () => {
  const { seg, texts } = make();
  quiet(() => seg.onResult(jaPartial("a", ["今日", "は", "晴れ"]), 1000));
  quiet(() => seg.onResult(jaFinal("a", ["今日", "は", "晴れ"]), 1100));
  quiet(() => seg.onResult(jaFinal("b", ["です", "ね", "。"]), 1200));
  assert.deepEqual(texts(), ["final|今日は晴れ", "sentence|ですね。"]);
});
test("closeResult (late language flip) removes the not-yet-emitted tokens and returns the counts", () => {
  const { seg, texts } = make();
  quiet(() => seg.onResult(jaPartial("a", ["今日", "は", "晴れ", "です", "。", "明日", "は"]), 1000));
  const r = quiet(() => seg.closeResult("a", "en-US", 1100));
  assert.deepEqual(r, { emitted: 5, removed: 2 });
  quiet(() => seg.endOfStream("eof", 1200));
  assert.deepEqual(texts(), ["sentence|今日は晴れです。"]);
});
test("merge-short holds a short sentence and joins it with the next", () => {
  const { seg, texts } = make({ mergeShort: true, sentenceMinChars: 6 });
  quiet(() => seg.onResult(jaPartial("a", ["はい", "。", "では", "始め", "ます", "。"]), 1000));
  assert.deepEqual(texts(), ["sentence|はい。では始めます。"]);
  const m = make({ mergeShort: true });
  quiet(() => m.seg.onResult(jaFinal("a", ["はい", "。"]), 1000));
  assert.deepEqual(m.texts(), []);
  quiet(() => m.seg.tick(2600)); // 1500 ms of silence
  assert.deepEqual(m.texts(), ["merge_pause|はい。"]);
});
test("merge-short never holds longer than the max hold", () => {
  const { seg, texts } = make({ mergeShort: true, maxWaitMs: 0, mergePauseMs: 0, mergeMaxHoldMs: 6000 });
  quiet(() => seg.onResult(jaFinal("a", ["はい", "。"]), 1000));
  quiet(() => seg.tick(6900));
  assert.deepEqual(texts(), []);
  quiet(() => seg.tick(7000));
  assert.deepEqual(texts(), ["merge_hold|はい。"]);
});
test("Latin words keep a space, Japanese is joined without separators", () => {
  assert.equal(joinJapanese([{ content: "Amazon", punct: false }, { content: "Bedrock", punct: false }, { content: "を", punct: false }, { content: "使い", punct: false }, { content: "ます", punct: false }, { content: "。", punct: true }]), "Amazon Bedrockを使います。");
  assert.equal(joinJapanese([{ content: "2", punct: false }, { content: "0", punct: false }, { content: "年", punct: false }]), "2 0年");
});
test("fillers are removed from the source before translation (only before 、 or 。)", () => {
  const { seg, texts } = make({ fillerPatterns: ["えー", "あの", "つまり、"] });
  quiet(() => seg.onResult(jaPartial("a", ["えー", "、", "今日", "は", "晴れ", "です", "。", "つまり", "、", "あの", "人", "は", "あの", "。"]), 1000));
  assert.deepEqual(texts(), ["sentence|今日は晴れです。", "sentence|あの人は。"]);
});
test("a filler word that is part of the sentence is kept", () => {
  const { seg, texts } = make({ fillerPatterns: ["あの"] });
  quiet(() => seg.onResult(jaPartial("a", ["あの", "人", "は", "来", "ます", "。"]), 1000));
  assert.deepEqual(texts(), ["sentence|あの人は来ます。"]);
});

// ---- invariants ----
test("invariants over random stable streams: no loss, no repeat, no empty chunk, one reason each", () => {
  for (let seed = 1; seed <= 40; seed++) {
    const rand = rng(seed);
    for (const mode of ["simple", "full"] as const) {
      const { seg, chunks } = make({ mode, mergeShort: rand() < 0.5 });
      const all: string[] = [];
      let now = 1000;
      const nResults = 1 + Math.floor(rand() * 4);
      for (let r = 0; r < nResults; r++) {
        const tokens: string[] = [];
        const n = 3 + Math.floor(rand() * 30);
        for (let i = 0; i < n; i++) {
          tokens.push(WORDS[Math.floor(rand() * WORDS.length)]);
          if (rand() < 0.15) tokens.push(SEPS[Math.floor(rand() * SEPS.length)]);
        }
        all.push(...tokens);
        const id = `r${r}`;
        // Reveal the result in growing partials, then the final; ticks in between.
        for (let k = 0; k < tokens.length; k += 1 + Math.floor(rand() * 6)) {
          quiet(() => seg.onResult(jaPartial(id, tokens.slice(0, k + 1), k + 1, r * 100), (now += 150)));
          quiet(() => seg.tick((now += 100)));
        }
        quiet(() => seg.onResult(jaFinal(id, tokens, r * 100), (now += 200)));
        quiet(() => seg.tick((now += 3000)));
      }
      quiet(() => seg.endOfStream("eof", (now += 100)));
      // A chunk that would only be punctuation is dropped, so compare the words.
      const words = (t: string) => t.replace(/[。、？！?!「」\s]/g, "");
      assert.equal(words(chunks.map((c) => c.english).join("")), words(all.join("")), `seed ${seed} ${mode}: text lost or repeated`);
      for (const c of chunks) {
        assert.ok(c.english.length > 0 && c.words > 0, "empty chunk");
        assert.equal(typeof c.reason, "string");
      }
      const reasonTotal = Object.values(seg.reasons).reduce((a, b) => a + (b ?? 0), 0);
      assert.ok(reasonTotal >= chunks.length, "every chunk has a counted reason");
    }
  }
});
