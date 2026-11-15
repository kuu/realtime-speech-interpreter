// ChunkPlayer caption timing hook (node:test). Offline: fake sink, engine and synthesizer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ChunkPlayer, type QueuedChunk } from "../src/chunk-player.js";
import { CaptionPublisher } from "../src/caption-publisher.js";
import type { AudioSink } from "../src/audio-sink.js";
import type { TranslationEngine } from "../src/translate-engine.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

class FakeSink implements AudioSink {
  queued = 0;
  pushes: number[] = [];
  failPush = false;
  data: { at: number; topic: string; ev: any }[] = [];
  failData = false;
  hasData = true;
  async connect() {}
  async pushPcm(pcm: Buffer) {
    if (this.failPush) throw new Error("push failed");
    this.pushes.push(Date.now());
    return pcm.length;
  }
  queuedMs() { return this.queued; }
  async waitForPlayout() {}
  async disconnect() {}
  publishData?(payload: Uint8Array, topic: string): Promise<void>;
  enableData() {
    this.publishData = async (payload, topic) => {
      if (this.failData) throw new Error("data failed");
      this.data.push({ at: Date.now(), topic, ev: JSON.parse(new TextDecoder().decode(payload)) });
    };
  }
}

function engine(ja: string | (() => string) | Error = "こんにちは"): TranslationEngine {
  return {
    name: "translate", contextChunks: 0, contextResetMs: 0, skipBacklogMs: 0,
    async translate() {
      if (ja instanceof Error) throw ja;
      return { text: typeof ja === "function" ? ja() : ja, engine: "translate" };
    },
    summaryLine: () => null, startupLine: () => null, dispose() {},
  };
}
const synth = async () => ({ pcm: Buffer.alloc(3200), rate: 100, hits: 0 }); // 100 ms at 16 kHz
let n = 0;
const chunk = (english: string): QueuedChunk => ({
  english, reason: "sentence", words: english.split(" ").length, resultId: "r1", resultCounts: { r1: 1 },
  audioStart: 0, audioEnd: 1, committedAt: Date.now(), t0: Date.now() - 1000, session: 1 + (n++ & 0),
});
function setup(over: { enabled?: boolean; eng?: TranslationEngine; data?: boolean; sink?: FakeSink } = {}) {
  const sink = over.sink ?? new FakeSink();
  if (over.data !== false) sink.enableData();
  const pub = new CaptionPublisher(sink, over.enabled ?? true);
  const player = new ChunkPlayer(sink, over.eng ?? engine(), pub, synth);
  return { sink, pub, player };
}

test("caption fires when the audio starts leaving the queue, not before", async () => {
  const { sink, player } = setup();
  sink.queued = 400;
  player.enqueue(chunk("Hello there friend"));
  await player.drain();
  assert.equal(sink.data.length, 0, "not sent at push time");
  await wait(480);
  assert.equal(sink.data.length, 1);
  const d = sink.data[0];
  const delay = d.at - sink.pushes[0];
  assert.ok(delay >= 340 && delay <= 520, `delay ${delay}`);
  assert.ok(Math.abs(d.ev.startAt - (sink.pushes[0] + 400)) <= 30, "startAt = push start + queued");
  assert.equal(d.topic, "captions");
  assert.equal(d.ev.type, "caption");
});

test("nothing queued: fires immediately", async () => {
  const { sink, player } = setup();
  player.enqueue(chunk("Hello there friend"));
  await player.drain();
  await wait(30);
  assert.equal(sink.data.length, 1);
});

test("no caption for SKIPPED, FAILED translate, FAILED push (timer cleared) or empty translation", async () => {
  {
    const { sink, player } = setup();
    player.enqueue(chunk("um uh")); // filler only
    await player.drain();
    await wait(30);
    assert.equal(sink.data.length, 0);
    assert.equal(player.stats.skipped, 1);
  }
  {
    const { sink, player } = setup({ eng: engine(new Error("nope")) });
    player.enqueue(chunk("Hello there friend"));
    await player.drain();
    await wait(30);
    assert.equal(sink.data.length, 0);
    assert.equal(player.stats.failed, 1);
  }
  {
    const sink = new FakeSink();
    sink.failPush = true;
    sink.queued = 100;
    const { player } = setup({ sink });
    player.enqueue(chunk("Hello there friend"));
    await player.drain();
    await wait(200);
    assert.equal(sink.data.length, 0);
    assert.equal(player.stats.failed, 1);
  }
});

test("captions off: no packets, no change to summary", async () => {
  const { sink, player } = setup({ enabled: false });
  player.enqueue(chunk("Hello there friend"));
  await player.drain();
  await wait(30);
  assert.equal(sink.data.length, 0);
  assert.doesNotMatch(player.summary("x"), /captions/);
  assert.equal(player.stats.played, 1);
});

test("a rejecting publishData does not affect playback stats", async () => {
  const { sink, pub, player } = setup();
  sink.failData = true;
  player.enqueue(chunk("Hello there friend"));
  await player.drain();
  await wait(30);
  assert.equal(player.stats.failed, 0);
  assert.equal(player.stats.played, 1);
  assert.equal(pub.stats.failed, 1);
});

test("sink without a data channel is accepted", async () => {
  const { sink, player } = setup({ data: false });
  player.enqueue(chunk("Hello there friend"));
  await player.drain();
  assert.equal(player.stats.played, 1);
  assert.equal(sink.data.length, 0);
});

test("events are ordered; text has no SSML; sourceText is filler-filtered English", async () => {
  const { sink, player } = setup({ eng: engine("<sub> & 日本語") });
  player.enqueue(chunk("um so we use AWS"));
  player.enqueue(chunk("and then we deploy"));
  player.enqueue(chunk("it works"));
  await player.drain();
  await wait(40);
  assert.equal(sink.data.length, 3);
  const evs = sink.data.map((d) => d.ev);
  for (let i = 1; i < evs.length; i++) {
    assert.ok(evs[i].seq > evs[i - 1].seq);
    assert.ok(evs[i].startAt >= evs[i - 1].startAt);
  }
  assert.equal(evs[0].text, "<sub> & 日本語");
  assert.ok(!evs[0].sourceText.toLowerCase().startsWith("um"));
  assert.match(evs[0].sourceText, /so we use AWS/);
});
