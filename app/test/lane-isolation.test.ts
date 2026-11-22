// Fault injection: lane 2 breaks or hangs, lane 1 keeps its timing (node:test). Offline.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { ChunkPlayer, type QueuedChunk } from "../src/chunk-player.js";
import { laneSettingsFor } from "../src/lane-settings.js";
import { LanguageGate } from "../src/language-gate.js";
import { LaneRouter } from "../src/lane-router.js";
import { Segmenter, type Chunk, type SegmenterOptions } from "../src/segmenter.js";
import { JaSegmenter } from "../src/segmenter-ja.js";
import { JA_DEFAULT_CLAUSE_ENDINGS, JA_DEFAULT_DANGLING_TOKENS } from "../src/ja-defaults.js";
import type { AudioSink } from "../src/audio-sink.js";
import type { TranslationEngine } from "../src/translate-engine.js";
import { jaPartial } from "./fixtures/ja-stream.js";

class Sink implements AudioSink {
  pushedAt: number[] = [];
  fail = false;
  async connect() {}
  async pushPcm(pcm: Buffer) {
    if (this.fail) throw new Error("sink disconnected");
    this.pushedAt.push(Date.now());
    return pcm.length;
  }
  queuedMs() { return 0; }
  async waitForPlayout() {}
  async disconnect() {}
}
const eng = (translate: () => Promise<string>): TranslationEngine => ({
  name: "translate", contextChunks: 0, contextResetMs: 0, skipBacklogMs: 0,
  async translate() { return { text: await translate(), engine: "translate" }; },
  summaryLine: () => null, startupLine: () => null, dispose() {},
});
const synthOk = async () => ({ pcm: Buffer.alloc(3200), rate: 100, hits: 0 });
const chunk = (english: string): QueuedChunk => ({
  english, reason: "sentence", words: 3, resultId: "r1", resultCounts: { r1: 1 }, audioStart: 0, audioEnd: 1, committedAt: Date.now(), t0: Date.now() - 1000, session: 1,
});
const EN_LANE = laneSettingsFor({ source: "ja-JP", target: "en", pollyVoice: "Joanna", transcribeVocabulary: "", translateTerminology: "" }, 1);
const quiet = <T>(fn: () => Promise<T>): Promise<T> => {
  const a = mock.method(console, "log", () => {});
  const b = mock.method(console, "error", () => {});
  return fn().finally(() => {
    a.mock.restore();
    b.mock.restore();
  });
};
// Time from enqueue to the sink push of lane 1 with the given lane 2 behaviour running at the same time.
async function lane1Delay(lane2: "none" | "hang" | "throw" | "polly-error" | "sink-down"): Promise<number> {
  const s1 = new Sink();
  const p1 = new ChunkPlayer(s1, eng(async () => "こんにちは。"), undefined, synthOk);
  let p2: ChunkPlayer | null = null;
  if (lane2 !== "none") {
    const s2 = new Sink();
    if (lane2 === "sink-down") s2.fail = true;
    const translate =
      lane2 === "hang" ? () => new Promise<string>(() => {}) : lane2 === "throw" ? async () => { throw new Error("lane 2 engine broke"); } : async () => "Hello.";
    const synth = lane2 === "polly-error" ? async () => { throw new Error("Polly down"); } : synthOk;
    p2 = new ChunkPlayer(s2, eng(translate), undefined, synth, EN_LANE, true);
    p2.enqueue(chunk("こんにちは。"));
    p2.enqueue(chunk("今日は晴れです。"));
  }
  const t0 = Date.now();
  p1.enqueue(chunk("Hello."));
  await p1.drain();
  const dt = s1.pushedAt[0] - t0;
  assert.equal(s1.pushedAt.length, 1);
  void p2;
  return dt;
}
test("lane 2 engine hangs, throws, Polly fails or its sink is down: lane 1 plays within the same tolerance as without lane 2", async () => {
  await quiet(async () => {
    const base = await lane1Delay("none");
    for (const k of ["hang", "throw", "polly-error", "sink-down"] as const) {
      const dt = await lane1Delay(k);
      assert.ok(dt < base + 100, `${k}: lane 1 took ${dt} ms, base ${base} ms`);
    }
  });
});
test("a failure inside lane 2's gate does not stop lane 1's gate or its chunks", async () => {
  const SEG: SegmenterOptions = {
    mode: "clause", minWords: 8, maxWords: 22, maxMs: 0, pauseMs: 900, conjunctions: ["but"], mergeShort: false, sentenceMinWords: 8, mergePauseMs: 0, mergeMaxHoldMs: 6000,
  };
  const out: Chunk[] = [];
  const g1 = new LanguageGate({ laneId: "ja", source: "en-US", settleWords: 1, shortWords: 0, shortMinConf: 0 }, new Segmenter(SEG, (c) => out.push(c)), () => 0);
  const bad = new JaSegmenter({ mode: "simple", maxWaitMs: 0, mergeShort: false, sentenceMinChars: 6, mergePauseMs: 0, mergeMaxHoldMs: 6000, clauseMinChars: 12, maxChars: 40, pauseMs: 900, clauseEndings: JA_DEFAULT_CLAUSE_ENDINGS, danglingTokens: JA_DEFAULT_DANGLING_TOKENS, danglingMaxChars: 10 }, () => {
    throw new Error("lane 2 chunk handler broke");
  });
  const g2 = new LanguageGate({ laneId: "en", source: "ja-JP", settleWords: 1, settleItems: 1, shortWords: 0, shortMinConf: 0 }, bad, () => 0);
  const router = new LaneRouter([{ id: "ja", sink: g1, tick() {} }, { id: "en", sink: g2, tick() {} }]);
  await quiet(async () => {
    router.onResult(jaPartial("j", ["今日", "は", "晴れ", "です", "。"]), 1000);
    router.onResult({ ResultId: "e", IsPartial: false, LanguageCode: "en-US", Alternatives: [{ Items: [
      { Content: "Hello", Type: "pronunciation", StartTime: 50, EndTime: 50.3 }, { Content: "there", Type: "pronunciation", StartTime: 50.4, EndTime: 50.7 }, { Content: ".", Type: "punctuation" },
    ] }] }, 1100);
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].english, "Hello there.");
});
