// Japanese speech shown as said (issue #12, first step): language gate tap, publisher events, audio path untouched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Segmenter, type Chunk, type SegmenterOptions, type TxItem, type TxResult } from "../src/segmenter.js";
import { LanguageGate, JA_SETTLE_ITEMS, type JapaneseSpeechTap, type LanguageGateOptions } from "../src/language-gate.js";
import { CaptionPublisher, JA_CARRY_MS, JA_HOLD_MAX_MS } from "../src/caption-publisher.js";
import { ChunkPlayer, type QueuedChunk } from "../src/chunk-player.js";
import { buildSpeechAppend, buildSpeechRetract } from "../src/caption-event.js";
import type { AudioSink } from "../src/audio-sink.js";
import type { TranslationEngine } from "../src/translate-engine.js";
const MERGE: SegmenterOptions = {
  mode: "clause", minWords: 8, maxWords: 22, maxMs: 0, pauseMs: 900,
  conjunctions: ["because", "but", "although", "though", "while", "which"],
  mergeShort: true, sentenceMinWords: 8, mergePauseMs: 1500, mergeMaxHoldMs: 6000,
};
const JA_FILLERS = ["ええと", "えーと", "あの", "つまり、", "まあ"];
const GATE: LanguageGateOptions = { source: "en-US", settleWords: 5, shortWords: 4, shortMinConf: 0.6, jaFillers: JA_FILLERS };
const items = (text: string, stableCount = Infinity, base = 0): TxItem[] =>
  text.split(/\s+/).filter(Boolean).map((c, i) => {
    const punct = /^[.,?!;:、。？！]$/.test(c);
    return { Content: c, Type: punct ? "punctuation" : "pronunciation", Stable: i < stableCount, StartTime: base + i * 0.4, EndTime: base + i * 0.4 + 0.3 };
  });
const bases = new Map<string, number>();
const baseOf = (id: string) => { if (!bases.has(id)) bases.set(id, bases.size * 100); return bases.get(id) as number; };
const partial = (id: string, lang: string, text: string, stable: number, base = baseOf(id)): TxResult =>
  ({ ResultId: id, IsPartial: true, LanguageCode: lang, Alternatives: [{ Transcript: text, Items: items(text, stable, base) }] });
const final = (id: string, lang: string, text: string, base = baseOf(id)): TxResult =>
  ({ ResultId: id, IsPartial: false, LanguageCode: lang, StartTime: base, EndTime: base + 5, Alternatives: [{ Transcript: text, Items: items(text, 0, base) }] });
interface Rec { kind: "speech" | "retract"; id: string; text?: string; final?: boolean; punct?: boolean[] }
function make(opts: LanguageGateOptions = GATE, withTap = true) {
  const rec: Rec[] = [];
  const tap: JapaneseSpeechTap = {
    onSpeech: (b) => rec.push({ kind: "speech", id: b.resultId, text: b.tokens.map((t) => t.content).join(""), final: b.final, punct: b.tokens.map((t) => t.punct) }),
    onRetract: (id) => rec.push({ kind: "retract", id }),
  };
  bases.clear();
  const chunks: Chunk[] = [];
  const seg = new Segmenter(MERGE, (c) => chunks.push(c));
  let segCalls = 0;
  const origOnResult = seg.onResult.bind(seg);
  seg.onResult = (r: TxResult, now: number) => { segCalls++; origOnResult(r, now); };
  const gate = new LanguageGate(opts, seg, () => 0, withTap ? tap : undefined);
  return { gate, rec, chunks, segCalls: () => segCalls };
}
const quiet = <T>(fn: () => T): T => {
  const orig = console.log;
  console.log = () => {};
  try { return fn(); } finally { console.log = orig; }
};
test(`Japanese partial is published only when stable and settled (${JA_SETTLE_ITEMS} stable words), then only the new words`, () => {
  const { gate, rec } = make();
  const t = "今日 は 皆さん ありがとう ござい ます 。";
  quiet(() => {
    gate.onResult(partial("j1", "ja-JP", "今日 は 皆さん", 2), 0); // 2 stable < 3
    assert.equal(rec.length, 0);
    gate.onResult(partial("j1", "ja-JP", "今日 は 皆さん ありがとう", 3), 100); // 3 stable: publish them (not the unstable 4th)
    assert.deepEqual(rec.map((r) => r.text), ["今日は皆さん"]);
    gate.onResult(partial("j1", "ja-JP", "今日 は 皆さん ありがとう ござい", 4), 200);
    gate.onResult(partial("j1", "ja-JP", "今日 は 皆さん ありがとう ござい ます 。", 7), 300);
    assert.deepEqual(rec.map((r) => r.text), ["今日は皆さん", "ありがとう", "ございます。"]);
    gate.onResult(final("j1", "ja-JP", t), 400); // nothing left to add
  });
  assert.equal(rec.length, 3);
  assert.deepEqual(rec[2].punct, [false, false, true]);
});
test("Japanese final that never settled (short answer) is published at the final, with final=true", () => {
  const { gate, rec } = make();
  quiet(() => {
    gate.onResult(partial("j2", "ja-JP", "はい", 0), 0);
    assert.equal(rec.length, 0);
    gate.onResult(final("j2", "ja-JP", "はい 。"), 100);
  });
  assert.deepEqual(rec.map((r) => [r.text, r.final]), [["はい。", true]]);
});
test("a next result that repeats audio already shown, and a re-tokenised final, never repeat words", () => {
  const { gate, rec } = make();
  quiet(() => {
    gate.onResult(partial("p1", "ja-JP", "二点 お 伺い し たい です", 6), 0);
    // final re-tokenised: different items, same audio span (times of the partial's 6 items)
    const f = final("p1", "ja-JP", "二点お伺い したい です 。");
    f.Alternatives![0].Items = [
      { Content: "二点お伺い", Type: "pronunciation", StartTime: baseOf("p1"), EndTime: baseOf("p1") + 0.9 },
      { Content: "したい", Type: "pronunciation", StartTime: baseOf("p1") + 1.0, EndTime: baseOf("p1") + 1.4 },
      { Content: "です", Type: "pronunciation", StartTime: baseOf("p1") + 1.6, EndTime: baseOf("p1") + 1.9 },
      { Content: "。", Type: "punctuation", StartTime: baseOf("p1") + 2.0, EndTime: baseOf("p1") + 2.4 },
    ];
    gate.onResult(f, 100);
    // the next result repeats the same audio (same item times) plus new words
    const r2 = partial("p2", "ja-JP", "二点 お 伺い し たい です 以上 です よ", 9);
    r2.Alternatives![0].Items = r2.Alternatives![0].Items!.map((it, i) => ({ ...it, StartTime: baseOf("p1") + i * 0.4, EndTime: baseOf("p1") + i * 0.4 + 0.3 }));
    gate.onResult(r2, 200);
  });
  const shown = rec.filter((r) => r.kind === "speech").map((r) => r.text).join("");
  assert.equal((shown.match(/二点/g) ?? []).length, 1, shown);
  assert.ok(shown.includes("以上です"), shown);
});
test("a result tagged Japanese with no Japanese character is not shown (English mis-tagged for a moment)", () => {
  const { gate, rec } = make();
  quiet(() => {
    gate.onResult(partial("m1", "ja-JP", "we see a bug pv enand", 6), 0);
    gate.onResult(final("m1", "ja-JP", "we see a bug pv enand"), 100);
  });
  assert.equal(rec.length, 0);
});
test("Japanese never produces a chunk", () => {
  const { gate, rec, chunks } = make();
  quiet(() => {
    gate.onResult(partial("j3", "ja-JP", "それ では 質問 を どうぞ", 4), 0);
    gate.onResult(final("j3", "ja-JP", "それ では 質問 を どうぞ 。"), 100);
    gate.endOfStream("eof", 200);
  });
  assert.ok(rec.length > 0);
  assert.equal(chunks.length, 0);
});
test("Japanese results never call Segmenter.onResult (endOfStream only)", () => {
  const { gate, segCalls } = make();
  quiet(() => {
    gate.onResult(partial("j4", "ja-JP", "それ では 質問 を どうぞ", 4), 0);
    gate.onResult(final("j4", "ja-JP", "それ では 質問 を どうぞ 。"), 100);
  });
  assert.equal(segCalls(), 0);
});
test("flip ja -> en: the Japanese words are retracted once and the English is translated normally (no duplicate)", () => {
  const { gate, rec, chunks } = make();
  quiet(() => {
    gate.onResult(partial("f1", "ja-JP", "あ そう です ね はい", 4), 0);
    assert.equal(rec.filter((r) => r.kind === "speech").length, 1);
    const en = "so we are building a new service for live video , and it runs in the cloud .";
    for (let n = 6; n <= 18; n++) {
      const w = en.split(" ").slice(0, n).join(" ");
      gate.onResult(partial("f1", "en-US", w, Math.max(0, n - 2)), 100 + n * 10);
    }
    gate.onResult(final("f1", "en-US", en), 1000);
    gate.endOfStream("eof", 1100);
  });
  assert.deepEqual(rec.map((r) => r.kind), ["speech", "retract"]);
  assert.ok(chunks.length > 0);
  assert.ok(chunks.every((c) => !/[ぁ-んァ-ン]/.test(c.english)), "no Japanese in the text sent on");
});
test("flip en -> ja: a result forwarded as English is never also shown as Japanese", () => {
  const { gate, rec } = make();
  quiet(() => {
    const w = "so we are building a new service";
    gate.onResult(partial("f2", "en-US", w, 6), 0); // passes (settled)
    gate.onResult(partial("f2", "ja-JP", "そう です ね 今日 は", 5), 100);
    gate.onResult(final("f2", "ja-JP", "そう です ね 今日 は 。"), 200);
  });
  assert.equal(rec.filter((r) => r.kind === "speech").length, 0);
});
test("final in another language than Japanese or English publishes nothing", () => {
  const { gate, rec } = make();
  quiet(() => {
    gate.onResult(partial("d1", "de-DE", "guten tag meine damen und herren", 6), 0);
    gate.onResult(final("d1", "de-DE", "guten tag meine damen und herren ."), 100);
  });
  assert.equal(rec.length, 0);
});
test("a ja result that becomes de-DE after publishing is retracted", () => {
  const { gate, rec } = make();
  quiet(() => {
    gate.onResult(partial("d2", "ja-JP", "あ そう です ね はい", 4), 0);
    gate.onResult(final("d2", "de-DE", "guten tag"), 100);
  });
  assert.deepEqual(rec.map((r) => r.kind), ["speech", "retract"]);
});
test("endOfStream publishes the rest of an open Japanese partial", () => {
  const { gate, rec } = make();
  quiet(() => {
    gate.onResult(partial("e1", "ja-JP", "ご 質問 は あり ます か", 3), 0);
    gate.endOfStream("eof", 100);
  });
  assert.deepEqual(rec.map((r) => r.text), ["ご質問は", "ありますか"]);
  assert.equal(rec[1].final, true);
});
test("Japanese fillers: hidden only when safe (before 、/。 or closing the result); demonstratives stay", () => {
  const { gate, rec } = make();
  quiet(() => {
    gate.onResult(final("k1", "ja-JP", "ええと 、 今日 は あの 、 天気 です 。"), 0);
    gate.onResult(final("k2", "ja-JP", "あの 人 は 先生 です 。"), 0);
    gate.onResult(final("k3", "ja-JP", "つまり 、 これ は 大事 です 。 これ は つまり 、 例 です 。"), 0);
    gate.onResult(final("k4", "ja-JP", "質問 が あり ます えー と あの"), 0);
  });
  assert.equal(rec[0].text, "今日は天気です。");
  assert.equal(rec[1].text, "あの人は先生です。");
  assert.equal(rec[2].text, "これは大事です。これはつまり、例です。"); // sentence-initial つまり、 only
  assert.equal(rec[3].text, "質問がありますえーと"); // closing あの hidden; えー と is not a pattern
});
test("a filler held back at the end of the stable prefix is decided when the next item arrives", () => {
  const { gate, rec } = make();
  quiet(() => {
    gate.onResult(partial("h1", "ja-JP", "皆さん 今日 は あの", 4), 0); // あの is last: held back
    assert.deepEqual(rec.map((r) => r.text), ["皆さん今日は"]);
    gate.onResult(partial("h1", "ja-JP", "皆さん 今日 は あの 人 が", 5), 100); // followed by a word: kept
  });
  assert.deepEqual(rec.map((r) => r.text), ["皆さん今日は", "あの人"]);
});
test("no tap = today's gate: identical chunks and log lines with and without the tap on mixed input", () => {
  const lines = (withTap: boolean) => {
    const out: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => out.push(a.map(String).join(" ").replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, "T"));
    try {
      const { gate, chunks } = make(GATE, withTap);
      const en = "we are building a new service for live video , and it runs in the cloud every day for many customers .";
      for (let n = 1; n <= 20; n++) gate.onResult(partial("a", "en-US", en.split(" ").slice(0, n).join(" "), Math.max(0, n - 2)), n * 100);
      gate.onResult(final("a", "en-US", en), 3000);
      gate.onResult(partial("b", "ja-JP", "質問 が あり ます", 4), 3100);
      gate.onResult(final("b", "ja-JP", "質問 が あり ます 。"), 3200);
      gate.endOfStream("eof", 3300);
      return [...out, ...chunks.map((c) => `${c.english}|${c.reason}`)];
    } finally {
      console.log = orig;
    }
  };
  assert.deepEqual(lines(true), lines(false));
});
// ---- publisher ----
function fakeTransport() {
  const sent: any[] = [];
  return { sent, transport: { async publishData(p: Uint8Array, topic: string) { sent.push({ topic, ev: JSON.parse(new TextDecoder().decode(p)) }); } } };
}
const tk = (content: string, punct = false) => ({ content, punct });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tt = (content: string, start: number, end: number, punct = false) => ({ content, punct, start, end });
test("publisher: speech events carry lang ja, asSaid, channel ja, speaker null, stable, seq order; a sentence goes out whole at its end", async () => {
  const f = fakeTransport();
  const p = new CaptionPublisher(f.transport, true, 20);
  const tap = p.japaneseTapFor(1, () => Date.now())!;
  tap.onSpeech({ resultId: "abcdef0123", tokens: [tk("今日"), tk("は")], final: false, audioEnd: 1 });
  await wait(30);
  assert.equal(f.sent.length, 0, "no sentence end yet: held");
  tap.onSpeech({ resultId: "abcdef0123", tokens: [tk("皆さん"), tk("。", true)], final: false, audioEnd: 2 });
  tap.onSpeech({ resultId: "abcdef0123", tokens: [tk("次")], final: false, audioEnd: 3 });
  tap.onRetract("abcdef0123"); // "次" was never published; the sentence was
  await wait(60);
  const evs = f.sent.map((s) => s.ev);
  assert.deepEqual(evs.map((e) => [e.type, e.op]), [["speech", "append"], ["speech", "retract"]]);
  assert.equal(evs[0].text, "今日は皆さん。");
  assert.equal(evs[0].boundary, true);
  for (const e of evs) {
    assert.equal(e.v, 1); assert.equal(e.lang, "ja"); assert.equal(e.channel, "ja"); assert.equal(e.asSaid, true);
    assert.equal(e.resultId, "abcdef01");
  }
  assert.equal(evs[0].speaker, null);
  assert.equal(evs[0].stable, true);
  assert.deepEqual(evs.map((e) => e.seq), [1, 2]);
  assert.equal(p.stats.speech, 2, "packets sent, like source (retract included)");
  assert.equal(p.stats.speechRetracted, 1);
});
test("sentence hold: several sentences in one batch are published one event each; the rest waits", async () => {
  const f = fakeTransport();
  const p = new CaptionPublisher(f.transport, true, 20);
  const tap = p.japaneseTapFor(1, () => Date.now())!;
  tap.onSpeech({ resultId: "r1xxxxxx", tokens: [tk("はい"), tk("。", true), tk("では"), tk("質問"), tk("です"), tk("か"), tk("？", true), tk("次"), tk("は")], final: false, audioEnd: 3 });
  await wait(20);
  assert.deepEqual(f.sent.map((s) => [s.ev.text, s.ev.boundary]), [["はい。", true], ["では質問ですか？", true]]);
  tap.onSpeech({ resultId: "r1xxxxxx", tokens: [tk("どう"), tk("？", true)], final: true, audioEnd: 4 });
  await wait(20);
  assert.deepEqual(f.sent.map((s) => s.ev.text), ["はい。", "では質問ですか？", "次はどう？"]);
  assert.deepEqual(f.sent.map((s) => s.ev.final), [false, false, true]);
});
test("sentence hold: a result that ends mid-sentence waits for the next result to continue it; otherwise the rest goes out after the carry time", async () => {
  const f = fakeTransport();
  const p = new CaptionPublisher(f.transport, true, 20, true, 5000, 50);
  const tap = p.japaneseTapFor(1, () => Date.now())!;
  // Transcribe finalises the first result in the middle of the question; the next result continues it
  tap.onSpeech({ resultId: "a1xxxxxx", tokens: [tk("ライブ"), tk("配信"), tk("は")], final: true, audioEnd: 1 });
  tap.onResultEnd!("a1xxxxxx");
  await wait(20);
  assert.equal(f.sent.length, 0, "held for the continuation");
  tap.onSpeech({ resultId: "b1xxxxxx", tokens: [tk("どう"), tk("です"), tk("か"), tk("？", true)], final: false, audioEnd: 2 });
  await wait(20);
  assert.deepEqual(f.sent.map((s) => [s.ev.text, s.ev.resultId]), [["ライブ配信はどうですか？", "b1xxxxxx"]]);
  // nothing continues: the rest is published as it is after the carry time
  tap.onSpeech({ resultId: "c1xxxxxx", tokens: [tk("終わり"), tk("の")], final: true, audioEnd: 3 });
  tap.onResultEnd!("c1xxxxxx");
  await wait(20);
  assert.equal(f.sent.length, 1);
  await wait(80);
  assert.deepEqual(f.sent.map((s) => s.ev.text), ["ライブ配信はどうですか？", "終わりの"]);
  assert.equal(f.sent[1].ev.final, true);
});
test("sentence hold: default timers are 1 s carry and 5 s maximum hold", async () => {
  assert.equal(JA_CARRY_MS, 1000);
  assert.equal(JA_HOLD_MAX_MS, 5000);
  const f = fakeTransport();
  const p = new CaptionPublisher(f.transport, true, 20); // defaults
  const tap = p.japaneseTapFor(1, () => Date.now())!;
  tap.onSpeech({ resultId: "m1xxxxxx", tokens: [tk("途中"), tk("の")], final: true, audioEnd: 1 });
  tap.onResultEnd!("m1xxxxxx");
  await wait(900);
  assert.equal(f.sent.length, 0, "still held before 1 s");
  await wait(250);
  assert.deepEqual(f.sent.map((s) => s.ev.text), ["途中の"], "released by the 1 s carry");
  p.close();
});
test("sentence hold: the end of the stream and close() release what is held", async () => {
  const f = fakeTransport();
  const p = new CaptionPublisher(f.transport, true, 20);
  const tap = p.japaneseTapFor(1, () => Date.now())!;
  tap.onSpeech({ resultId: "c1xxxxxx", tokens: [tk("途中")], final: false, audioEnd: 3 });
  tap.onStreamEnd!();
  tap.onSpeech({ resultId: "d1xxxxxx", tokens: [tk("最後")], final: false, audioEnd: 4 });
  p.close();
  await wait(20);
  assert.deepEqual(f.sent.map((s) => s.ev.text), ["途中", "最後"]);
});
test("sentence hold: a sentence with no end is published after the hold time (counted from its first word)", async () => {
  const f = fakeTransport();
  const p = new CaptionPublisher(f.transport, true, 20, true, 60);
  const tap = p.japaneseTapFor(1, () => Date.now())!;
  tap.onSpeech({ resultId: "t1xxxxxx", tokens: [tk("モバイル"), tk("回線")], final: false, audioEnd: 1 });
  await wait(30);
  tap.onSpeech({ resultId: "t1xxxxxx", tokens: [tk("が"), tk("弱い")], final: false, audioEnd: 2 }); // does not restart the timer
  assert.equal(f.sent.length, 0);
  await wait(60);
  assert.deepEqual(f.sent.map((s) => [s.ev.text, s.ev.boundary]), [["モバイル回線が弱い", false]]);
  tap.onSpeech({ resultId: "t1xxxxxx", tokens: [tk("会場"), tk("も"), tk("。", true)], final: false, audioEnd: 3 });
  assert.equal(f.sent.length, 2);
});
test("sentence hold: flip before anything was published sends nothing; flip after publishing retracts once", async () => {
  const f = fakeTransport();
  const p = new CaptionPublisher(f.transport, true, 20);
  const tap = p.japaneseTapFor(1, () => Date.now())!;
  tap.onSpeech({ resultId: "x1xxxxxx", tokens: [tk("あ"), tk("そう")], final: false, audioEnd: 1 });
  tap.onRetract("x1xxxxxx");
  p.close();
  await wait(20);
  assert.equal(f.sent.length, 0);
  tap.onSpeech({ resultId: "y1xxxxxx", tokens: [tk("はい"), tk("。", true), tk("そう")], final: false, audioEnd: 1 });
  tap.onRetract("y1xxxxxx");
  tap.onRetract("y1xxxxxx");
  p.close();
  await wait(20);
  assert.deepEqual(f.sent.map((s) => [s.ev.op, s.ev.text]), [["append", "はい。"], ["retract", undefined]]);
});
test("sentence hold: the first-word and last-word delays are measured from the audio times", () => {
  const f = fakeTransport();
  const p = new CaptionPublisher(f.transport, true, 20);
  const t0 = Date.now() - 10_000;
  const tap = p.japaneseTapFor(1, () => t0)!;
  tap.onSpeech({ resultId: "z1xxxxxx", tokens: [tt("質問", 2, 3), tt("です", 3, 4), tt("。", 4, 4.2, true)], final: false, audioEnd: 4.2 });
  assert.equal(p.stats.speechLagN, 1);
  assert.ok(Math.abs(p.stats.speechLagSum - 5800) < 300, String(p.stats.speechLagSum)); // 10 s - 4.2 s from the last word
});
test("publisher: English and Japanese buffers never mix (a switch flushes)", async () => {
  const f = fakeTransport();
  const p = new CaptionPublisher(f.transport, true, 10_000);
  const en = p.tapFor(1, () => Date.now())!;
  const ja = p.japaneseTapFor(1, () => Date.now())!;
  en.onWords({ resultId: "e1111111", tokens: [{ content: "hello", punct: false, filler: false }], audioStart: 0, audioEnd: 1, now: 0 });
  ja.onSpeech({ resultId: "j1111111", tokens: [tk("質問")], final: false, audioEnd: 2 });
  p.close(); // held Japanese words are released at shutdown
  await wait(20);
  assert.deepEqual(f.sent.map((s) => [s.ev.type, s.ev.text]), [["source", "hello"], ["speech", "質問"]]);
});
test("CAPTIONS_JA_SPEECH=off: no Japanese tap, English tap and captions unchanged, startup line says off", async () => {
  const f = fakeTransport();
  const p = new CaptionPublisher(f.transport, true, 5, false);
  assert.equal(p.japaneseTapFor(1, () => 0), undefined);
  assert.ok(p.tapFor(1, () => 0));
  assert.match(p.startupLine(), /jaSpeech=off/);
  assert.match(new CaptionPublisher(f.transport, true).startupLine(), /jaSpeech=on/);
  // captions=off: nothing at all, even with the Japanese option on
  assert.equal(new CaptionPublisher(f.transport, false, 5, true).japaneseTapFor(1, () => 0), undefined);
  assert.equal(new CaptionPublisher({}, true).japaneseTapFor(1, () => 0), undefined, "no data channel");
});
test("event builders: schema v1 additive shape", () => {
  const a = buildSpeechAppend({ session: 2, n: 3, seq: 9, resultId: "abcd", text: "x".repeat(700), boundary: false, final: true, audioEnd: 1.5 });
  assert.equal(a.type, "speech"); assert.equal(a.id, "2-s3"); assert.equal(Array.from(a.text).length, 600);
  const r = buildSpeechRetract({ session: 2, seq: 10, resultId: "abcd" });
  assert.deepEqual([r.type, r.op, r.asSaid, r.lang, r.channel], ["speech", "retract", true, "ja", "ja"]);
});
// ---- audio path: Japanese speech never reaches Translate / the LLM / Polly ----
class Sink implements AudioSink {
  data: any[] = [];
  async connect() {}
  async pushPcm(b: Buffer) { return b.length; }
  queuedMs() { return 0; }
  async waitForPlayout() {}
  async disconnect() {}
  async publishData(payload: Uint8Array, topic: string) { this.data.push({ topic, ev: JSON.parse(new TextDecoder().decode(payload)) }); }
}
test("audio path: Translate/LLM and Polly see only the English text; Japanese speech is only a caption event", async () => {
  const sink = new Sink();
  const pub = new CaptionPublisher(sink, true, 5);
  const translated: string[] = [];
  const spoken: string[] = [];
  const eng: TranslationEngine = {
    name: "translate", contextChunks: 0, contextResetMs: 0, skipBacklogMs: 0,
    async translate(a: any) { translated.push(a.text ?? a.english ?? JSON.stringify(a)); return { text: "翻訳された文です。", engine: "translate" }; },
    summaryLine: () => null, startupLine: () => null, dispose() {},
  };
  const player = new ChunkPlayer(sink, eng, pub, (async (text: string) => { spoken.push(text); return { pcm: Buffer.alloc(3200), rate: 100, hits: 0 }; }) as any);
  const chunks: Chunk[] = [];
  const seg = new Segmenter(MERGE, (c) => { chunks.push(c); player.enqueue({ ...c, t0: Date.now() - 1000, session: 1 } as QueuedChunk); }, pub.tapFor(1, () => Date.now()));
  const gate = new LanguageGate(GATE, seg, () => Date.now() - 1000, pub.japaneseTapFor(1, () => Date.now() - 1000));
  quiet(() => {
    gate.onResult(partial("q1", "ja-JP", "これ は 日本語 の 質問 です", 5), 0);
    gate.onResult(final("q1", "ja-JP", "これ は 日本語 の 質問 です か 。"), 100);
    const en = "we are building a new service for live video , and it runs in the cloud every day for many customers .";
    for (let n = 1; n <= 20; n++) gate.onResult(partial("q2", "en-US", en.split(" ").slice(0, n).join(" "), Math.max(0, n - 2)), 200 + n * 50);
    gate.onResult(final("q2", "en-US", en), 2000);
    gate.endOfStream("eof", 2100);
  });
  await player.drain();
  await wait(100);
  pub.close();
  await wait(30);
  assert.ok(translated.length > 0 && spoken.length > 0);
  for (const t of [...translated, ...spoken]) assert.ok(!t.includes("日本語") && !t.includes("質問"), `Japanese speech leaked: ${t}`);
  assert.ok(translated.every((t) => /[A-Za-z]/.test(t)));
  const speech = sink.data.filter((d) => d.ev.type === "speech").map((d) => d.ev.text).join("");
  assert.equal(speech, "これは日本語の質問ですか。");
});
test("end to end: a translation line between the batches of a question does not split it (one as-said line)", async () => {
  const f = fakeTransport();
  const pub = new CaptionPublisher(f.transport, true, 5);
  const seg = new Segmenter(MERGE, () => {});
  const gate = new LanguageGate(GATE, seg, () => Date.now(), pub.japaneseTapFor(1, () => Date.now()));
  const asm: any = (await import(new URL("../web/captions.js", import.meta.url).href)).createAssembler();
  const parse: any = (await import(new URL("../web/captions.js", import.meta.url).href)).parseEvent;
  let fed = 0;
  const feed = async (now: number) => {
    await wait(10);
    for (; fed < f.sent.length; fed++) asm.push(parse(JSON.stringify(f.sent[fed].ev)), now);
  };
  quiet(() => {
    gate.onResult(partial("q9", "ja-JP", "モバイル 回線 が 弱い 会場", 5), 0); // stable words, no sentence end
  });
  await feed(0);
  assert.equal(f.sent.length, 0, "held");
  pub.sendCaption({ session: 1, chunkSeq: 1, text: "はい、可能です。", sourceText: "Yes.", startAt: Date.now(), durationMs: 1000 }); // voice-synced translation arrives
  await feed(100);
  quiet(() => {
    gate.onResult(partial("q9", "ja-JP", "モバイル 回線 が 弱い 会場 も 安定 して 視聴 できます か ？", 12), 200);
    gate.onResult(final("q9", "ja-JP", "モバイル 回線 が 弱い 会場 も 安定 して 視聴 できます か ？"), 300);
  });
  await feed(300);
  const said = asm.model(300).filter((l: any) => l.said);
  assert.deepEqual(said.map((l: any) => l.text), ["モバイル回線が弱い会場も安定して視聴できますか？"]);
  assert.deepEqual(asm.model(300).map((l: any) => l.said), [false, true]);
  assert.equal(f.sent.filter((s) => s.ev.type === "speech").length, 1);
});
