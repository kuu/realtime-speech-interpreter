// Golden: one lane replays a fixed Transcribe result stream (English with a Japanese passage) to fixed chunks.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { Segmenter, type Chunk, type SegmenterOptions, type TxItem, type TxResult } from "../src/segmenter.js";
import { LanguageGate } from "../src/language-gate.js";

const SEG: SegmenterOptions = {
  mode: "clause", minWords: 8, maxWords: 22, maxMs: 0, pauseMs: 900, conjunctions: ["because", "but", "which"],
  mergeShort: true, sentenceMinWords: 8, mergePauseMs: 1500, mergeMaxHoldMs: 6000,
};
export function replay(GateClass: typeof LanguageGate): { chunks: string[]; summary: string } {
  const out: Chunk[] = [];
  const seg = new Segmenter(SEG, (c) => out.push(c));
  const gate = new GateClass({ source: "en-US", settleWords: 5, shortWords: 4, shortMinConf: 0.6 }, seg, () => 0);
  const mk = (id: string, base: number, lang: string, text: string, stable: number, partial: boolean): TxResult => {
    const its: TxItem[] = text.split(" ").map((c, i) => ({
      Content: c,
      Type: /^[.,、。]$/.test(c) ? "punctuation" : "pronunciation",
      Stable: i < stable,
      StartTime: base + i * 0.4,
      EndTime: base + i * 0.4 + 0.3,
      Confidence: 0.9,
    }));
    return { ResultId: id, IsPartial: partial, LanguageCode: lang, StartTime: base, EndTime: base + its.length * 0.4, Alternatives: [{ Transcript: text, Items: its }] };
  };
  const quiet = mock.method(console, "log", () => {});
  const quietE = mock.method(console, "error", () => {});
  try {
    let t = 1000;
    const feed = (r: TxResult) => gate.onResult(r, (t += 250));
    feed(mk("r1", 0, "en-US", "welcome everyone to the event today", 3, true));
    feed(mk("r1", 0, "en-US", "welcome everyone to the event today and thank you for coming", 9, true));
    feed(mk("r1", 0, "en-US", "welcome everyone to the event today and thank you for coming . ", 10, false));
    feed(mk("r2", 20, "ja-JP", "では 次 の 話題 に 移り ます 。", 8, true));
    feed(mk("r2", 20, "ja-JP", "では 次 の 話題 に 移り ます 。", 0, false));
    feed(mk("r3", 40, "en-US", "so the first thing we want to show is the new dashboard , which is live now .", 5, true));
    feed(mk("r3", 40, "en-US", "so the first thing we want to show is the new dashboard , which is live now .", 0, false));
    t += 5000;
    seg.tick(t);
    gate.endOfStream("eof", t + 100);
  } finally {
    quiet.mock.restore();
    quietE.mock.restore();
  }
  return { chunks: out.map((c) => `${c.reason}|${c.english}`), summary: gate.summary(1) };
}

test("one lane replays the fixed stream to the golden chunks", () => {
  const r = replay(LanguageGate);
  assert.deepEqual(r.chunks, GOLDEN);
  assert.equal(r.summary, "[langfilter] stream=1 results=3 kept=2 dropped=1 droppedWords=7 late=0 carried=0 repeats=0");
});
const GOLDEN: string[] = [
  "sentence|welcome everyone to the event today and thank you for coming.",
  "comma|so the first thing we want to show is the new dashboard,",
  "merge_pause|which is live now.",
];
