// Offline replay harness over synthetic Japanese result streams: per-reason counts for simple and full (node:test).
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { replayJa, type TimedResult } from "../src/ja-replay.js";
import { JA_DEFAULT_CLAUSE_ENDINGS, JA_DEFAULT_DANGLING_TOKENS } from "../src/ja-defaults.js";
import type { JaSegmenterOptions } from "../src/segmenter-ja.js";
import { jaFinal, jaPartial } from "./fixtures/ja-stream.js";

const BASE: JaSegmenterOptions = {
  mode: "simple", maxWaitMs: 4000, mergeShort: false, sentenceMinChars: 6, mergePauseMs: 1500, mergeMaxHoldMs: 6000,
  clauseMinChars: 12, maxChars: 40, pauseMs: 900, clauseEndings: JA_DEFAULT_CLAUSE_ENDINGS, danglingTokens: JA_DEFAULT_DANGLING_TOKENS,
  danglingMaxChars: 10,
};
// Hand-set timings: a sentence with 、, a clause that ends in ので without punctuation, a final that ends on が.
const STREAM: TimedResult[] = [
  { t: 1000, result: jaPartial("a", ["本日", "は", "ご来場", "ありがとう", "ござい", "ます", "、"], 7, 0) },
  { t: 1600, result: jaPartial("a", ["本日", "は", "ご来場", "ありがとう", "ござい", "ます", "、", "まず", "は", "概要", "を", "説明", "し", "ます", "。"], 15, 0) },
  { t: 2200, result: jaFinal("a", ["本日", "は", "ご来場", "ありがとう", "ござい", "ます", "、", "まず", "は", "概要", "を", "説明", "し", "ます", "。"], 0) },
  { t: 3000, result: jaPartial("b", ["今日", "は", "時間", "が", "あまり", "ない", "ので"], 7, 10) },
  { t: 9000, result: jaFinal("b", ["今日", "は", "時間", "が", "あまり", "ない", "ので", "急ぎ", "ます", "が"], 10) },
];
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

test("simple: reasons are sentence, clause, maxwait or final; the report prints per-reason counts", () => {
  const r = quiet(() => replayJa(STREAM, BASE));
  assert.deepEqual(r.reasons, { clause: 1, sentence: 1, maxwait: 1, final: 1 });
  assert.match(r.report, /^mode=simple chunks=4 reasons: /);
  assert.match(r.report, /clause=1/);
  assert.match(r.report, /maxwait=1/);
  assert.match(r.report, /chars per chunk p50=/);
  assert.match(r.report, /ends on dangling token: 25\.0%/); // the last chunk ends on が
});
test("full on the same stream: clause rule needs 12 characters, the ending rule closes ので, the final keeps が", () => {
  const r = quiet(() => replayJa(STREAM, { ...BASE, mode: "full" }));
  assert.equal(r.reasons.ending, 1);
  assert.equal(r.reasons.final, 1);
  assert.ok((r.reasons.clause ?? 0) + (r.reasons.sentence ?? 0) >= 1);
  assert.match(r.report, /^mode=full /);
});
test("both variants are comparable in one run: the same text, different cut reasons", () => {
  const a = quiet(() => replayJa(STREAM, BASE));
  const b = quiet(() => replayJa(STREAM, { ...BASE, mode: "full" }));
  const text = (x: { chunks: { english: string }[] }) => x.chunks.map((c) => c.english).join("").replace(/[。、]/g, "");
  assert.equal(text(a), text(b));
  assert.notDeepEqual(a.reasons, b.reasons);
});

test("behind the gate of a ja-JP lane: English results never reach the Japanese segmenter", async () => {
  const { LanguageGate } = await import("../src/language-gate.js");
  const { JaSegmenter } = await import("../src/segmenter-ja.js");
  const chunks: string[] = [];
  const seg = new JaSegmenter(BASE, (c) => chunks.push(`${c.reason}|${c.english}`));
  const gate = new LanguageGate({ laneId: "en", source: "ja-JP", settleWords: 5, settleItems: 3, shortWords: 4, shortMinConf: 0.6 }, seg, () => 0);
  quiet(() => {
    gate.onResult(jaPartial("a", ["本日", "は", "晴れ", "です", "。"], 5, 0), 1000);
    gate.onResult({ ResultId: "b", IsPartial: false, LanguageCode: "en-US", Alternatives: [{ Items: [{ Content: "okay", Type: "pronunciation", StartTime: 50, EndTime: 50.3 }] }] }, 1100);
    gate.onResult(jaFinal("a", ["本日", "は", "晴れ", "です", "。"], 0), 1200);
    gate.endOfStream("eof", 1300);
  });
  assert.deepEqual(chunks, ["sentence|本日は晴れです。"]);
});
