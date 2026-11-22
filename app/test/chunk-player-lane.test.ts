// ChunkPlayer with lane settings (node:test): Polly voice and engine per lane, speed off for English, log fields,
// English readings, and lane 1 unchanged. Offline: fake sink, engine and Polly client.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { PollyClient } from "@aws-sdk/client-polly";
import { ChunkPlayer, makeSynthesizer, type QueuedChunk } from "../src/chunk-player.js";
import { createReadings } from "../src/polly-readings.js";
import { laneSettingsFor } from "../src/lane-settings.js";
import { config } from "../src/config.js";
import type { AudioSink } from "../src/audio-sink.js";
import type { TranslationEngine, EngineRequest } from "../src/translate-engine.js";

class FakeSink implements AudioSink {
  pushes = 0;
  async connect() {}
  async pushPcm(pcm: Buffer) { this.pushes++; return pcm.length; }
  queuedMs() { return 0; }
  async waitForPlayout() {}
  async disconnect() {}
}
function engineOf(out: string, seen: EngineRequest[] = []): TranslationEngine {
  return {
    name: "translate", contextChunks: 3, contextResetMs: 0, skipBacklogMs: 0,
    async translate(req) { seen.push(req); return { text: out, engine: "translate" }; },
    summaryLine: () => null, startupLine: () => null, dispose() {},
  };
}
const chunk = (text: string, session = 1): QueuedChunk => ({
  english: text, reason: "sentence", words: 3, resultId: "r1", resultCounts: { r1: 1 },
  audioStart: 0, audioEnd: 1, committedAt: Date.now(), t0: Date.now() - 1000, session,
});
const EN_LANE = laneSettingsFor({ source: "ja-JP", target: "en", pollyVoice: "Joanna", transcribeVocabulary: "", translateTerminology: "t-ja-en" }, 1);
const JA_LANE = laneSettingsFor({ source: "en-US", target: "ja", pollyVoice: config.polly.voiceId, transcribeVocabulary: "", translateTerminology: "" }, 0);

function capturePolly() {
  const reqs: any[] = [];
  const m = mock.method(PollyClient.prototype, "send", async (cmd: any) => {
    reqs.push(cmd.input);
    return { AudioStream: (async function* () { yield new Uint8Array(3200); })() };
  });
  return { reqs, restore: () => m.mock.restore() };
}

test("the English lane's Polly request carries its voice, the global engine and its sample rate", async () => {
  const p = capturePolly();
  try {
    const synth = makeSynthesizer(EN_LANE.polly, () => null);
    const r = await synth("Hello everyone.", 100, "[t]");
    assert.equal(r.pcm.length, 3200);
    assert.deepEqual(p.reqs[0], {
      Text: "Hello everyone.", TextType: "text", VoiceId: "Joanna", Engine: config.polly.engine, OutputFormat: "pcm", SampleRate: String(config.polly.sampleRateHertz),
    });
  } finally {
    p.restore();
  }
});
test("lane 1's Polly request equals the one with no lane (same voice, engine, rate, key order)", async () => {
  const p = capturePolly();
  try {
    await makeSynthesizer(JA_LANE.polly, () => null)("こんにちは。", 100, "[t]");
    const sink = new FakeSink();
    const player = new ChunkPlayer(sink, engineOf("こんにちは。")); // no lane: the global synthesizer
    player.enqueue(chunk("Hello."));
    await player.drain();
    assert.equal(p.reqs.length, 2);
    assert.deepEqual(p.reqs[0], p.reqs[1]);
    assert.equal(JSON.stringify(p.reqs[0]), JSON.stringify(p.reqs[1]), "key order too");
  } finally {
    p.restore();
  }
});
test("an English lane speaks at 100% whatever the backlog (speed control off) and uses English readings", async () => {
  const p = capturePolly();
  try {
    const readings = createReadings([{ term: "SRT", reading: "ess are tee" }]);
    const sink = new FakeSink();
    const seen: EngineRequest[] = [];
    const player = new ChunkPlayer(sink, engineOf("We use SRT now.", seen), undefined, undefined, EN_LANE, true, readings);
    // a chunk whose last word is 20 s old: a Japanese lane would speed up
    const c = chunk("今日はSRTを使います。");
    c.t0 = Date.now() - 20000;
    c.audioEnd = 1;
    player.enqueue(c);
    await player.drain();
    assert.equal(seen[0].text, "今日はSRTを使います。", "no English filler filter or correction on a Japanese source");
    assert.equal(p.reqs[0].VoiceId, "Joanna");
    assert.equal(p.reqs[0].TextType, "ssml");
    assert.match(p.reqs[0].Text, /<sub alias="ess are tee">SRT<\/sub>/);
    assert.doesNotMatch(p.reqs[0].Text, /prosody/, "rate stays 100");
    assert.equal(player.stats.sped, 0);
  } finally {
    p.restore();
  }
});
test("lane log lines: [chunk n ch=en], src/out fields; one-lane lines keep [chunk n] and en/ja", async () => {
  const lines: string[] = [];
  const m = mock.method(console, "log", (...a: unknown[]) => void lines.push(a.map(String).join(" ")));
  const p = capturePolly();
  try {
    const l2 = new ChunkPlayer(new FakeSink(), engineOf("Hello."), undefined, async () => ({ pcm: Buffer.alloc(3200), rate: 100, hits: 0 }), EN_LANE, true);
    l2.enqueue(chunk("こんにちは。"));
    await l2.drain();
    const l1 = new ChunkPlayer(new FakeSink(), engineOf("こんにちは。"), undefined, async () => ({ pcm: Buffer.alloc(3200), rate: 100, hits: 0 }));
    l1.enqueue(chunk("Hello."));
    await l1.drain();
    const two = lines.filter((x) => x.includes("ch=en]"));
    assert.ok(two.some((x) => x.includes("COMMIT") && x.includes('src="こんにちは。"')), lines.join("\n"));
    assert.ok(two.some((x) => x.includes("SYNTH") && x.includes('out="Hello."')));
    const one = lines.filter((x) => /\[chunk 1\] /.test(x));
    assert.ok(one.some((x) => x.includes('en="Hello."')));
    assert.ok(one.some((x) => x.includes('ja="こんにちは。"')));
    assert.match(l2.summary("x"), /^\[summary\] ch=en x /);
    assert.match(l1.summary("x"), /^\[summary\] x /);
  } finally {
    m.mock.restore();
    p.restore();
  }
});
test("context pushed by a Japanese-source lane keeps en = English text, ja = Japanese text", async () => {
  const seen: EngineRequest[] = [];
  const synth = async () => ({ pcm: Buffer.alloc(3200), rate: 100, hits: 0 });
  const player = new ChunkPlayer(new FakeSink(), engineOf("Hello.", seen), undefined, synth, EN_LANE, true);
  const quiet = mock.method(console, "log", () => {});
  try {
    player.enqueue(chunk("こんにちは。"));
    player.enqueue(chunk("今日は晴れです。"));
    await player.drain();
  } finally {
    quiet.mock.restore();
  }
  assert.deepEqual(seen[1].previous, [{ en: "Hello.", ja: "こんにちは。" }]);
});
