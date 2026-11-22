import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCaptionEvent, buildSourceAppend, buildSourceRetract, buildSpeechAppend, buildSpeechRetract, encodeCaptionEvent,
  type CaptionLane,
} from "../src/caption-event.js";
import { CaptionPublisher } from "../src/caption-publisher.js";

const EN: CaptionLane = { ch: "en", lang: "en", sourceLang: "ja" };
const base = { session: 2, chunkSeq: 7, seq: 42, text: "Hello.", sourceText: "こんにちは。", startAt: 1760000000000, durationMs: 1200 };

test("lane 1 bytes are golden: no ch field, no id prefix", () => {
  const golden =
    '{"v":1,"type":"caption","id":"2-7","seq":42,"session":2,"channel":"ja","lang":"ja","text":"こんにちは。","sourceLang":"en","sourceText":"Hello.","speaker":null,"final":true,"startAt":1760000000000,"durationMs":1200}';
  const ev = buildCaptionEvent({ ...base, text: "こんにちは。", sourceText: "Hello." });
  assert.equal(new TextDecoder().decode(encodeCaptionEvent(ev)), golden);
  // the first lane of a deploy with swapped languages keeps the legacy shape too (no ch, no prefix)
  const first = buildCaptionEvent({ ...base, lane: { ch: "en", lang: "en", sourceLang: "ja", first: true } });
  assert.equal("ch" in first, false);
  assert.equal(first.id, "2-7");
  assert.equal(first.lang, "en");
});
test("lane 2 caption: ch, id prefix, languages", () => {
  const ev = buildCaptionEvent({ ...base, lane: EN });
  assert.equal(ev.id, "en:2-7");
  assert.equal((ev as any).ch, "en");
  assert.equal(ev.channel, "en");
  assert.equal(ev.lang, "en");
  assert.equal(ev.sourceLang, "ja");
  assert.equal(ev.text, "Hello.");
  assert.equal(ev.sourceText, "こんにちは。");
});
test("lane 2 source and as-said events: Japanese source words, English speech as said", () => {
  const src = buildSourceAppend({ session: 1, n: 3, seq: 5, resultId: "abc", text: "今日は", boundary: false, audioEnd: 1, lane: EN });
  assert.equal(src.id, "en:1-3");
  assert.equal(src.lang, "ja");
  assert.equal((src as any).ch, "en");
  const sr = buildSourceRetract({ session: 1, seq: 6, resultId: "abc", lane: EN });
  assert.equal(sr.lang, "ja");
  assert.equal((sr as any).ch, "en");
  const sp = buildSpeechAppend({ session: 1, n: 2, seq: 7, resultId: "abc", text: "Hello.", boundary: true, final: true, audioEnd: 1, lane: EN });
  assert.equal(sp.id, "en:1-s2");
  assert.equal(sp.lang, "en");
  assert.equal(sp.asSaid, true);
  const spr = buildSpeechRetract({ session: 1, seq: 8, resultId: "abc", lane: EN });
  assert.equal(spr.lang, "en");
});
test("lane 1 source and speech events are unchanged", () => {
  assert.deepEqual(buildSourceAppend({ session: 1, n: 3, seq: 5, resultId: "abc", text: "Hi", boundary: false, audioEnd: 1 }), {
    v: 1, type: "source", op: "append", id: "1-3", seq: 5, session: 1, resultId: "abc", channel: "en", lang: "en", text: "Hi",
    stable: true, boundary: false, speaker: null, audioEnd: 1,
  });
  assert.equal(buildSpeechAppend({ session: 1, n: 2, seq: 7, resultId: "abc", text: "はい。", boundary: true, final: true, audioEnd: 1 }).id, "1-s2");
});

function transport() {
  const sent: { topic: string; ev: any }[] = [];
  return { sent, publishData: async (p: Uint8Array, topic: string) => void sent.push({ topic, ev: JSON.parse(new TextDecoder().decode(p)) }) };
}
test("publisher: lane 2 uses its own topic, and the topic of lane 1 stays 'captions'", async () => {
  const t1 = transport();
  const t2 = transport();
  new CaptionPublisher(t1, true).sendCaption({ session: 1, chunkSeq: 1, text: "はい", sourceText: "Yes", startAt: 0, durationMs: 1 });
  new CaptionPublisher(t2, true, undefined, true, undefined, undefined, EN, "captions-en").sendCaption({ session: 1, chunkSeq: 1, text: "Yes", sourceText: "はい", startAt: 0, durationMs: 1 });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(t1.sent[0].topic, "captions");
  assert.equal(t2.sent[0].topic, "captions-en");
  assert.equal(t2.sent[0].ev.ch, "en");
  assert.equal(t1.sent[0].ev.ch, undefined);
});
test("publisher: Japanese source words are joined without spaces; English as-said words with spaces, per sentence", async () => {
  const t = transport();
  const pub = new CaptionPublisher(t, true, 10, true, undefined, undefined, EN, "captions-en");
  const src = pub.tapFor(1, () => Date.now())!;
  src.onWords({ resultId: "r1abcdef", tokens: [{ content: "今日", punct: false, filler: false }, { content: "は", punct: false, filler: false }, { content: "晴れ", punct: false, filler: false }, { content: "です", punct: false, filler: false }, { content: "。", punct: true, filler: false }], audioStart: 0, audioEnd: 1, now: Date.now() });
  const said = pub.japaneseTapFor(1, () => Date.now())!;
  said.onSpeech({ resultId: "r2abcdef", tokens: [{ content: "we", punct: false }, { content: "are", punct: false }, { content: "here", punct: false }, { content: ".", punct: true }], final: true, audioEnd: 2 });
  await new Promise((r) => setTimeout(r, 20));
  const source = t.sent.find((x) => x.ev.type === "source");
  const speech = t.sent.find((x) => x.ev.type === "speech");
  assert.equal(source?.ev.text, "今日は晴れです。");
  assert.equal(source?.ev.lang, "ja");
  assert.equal(speech?.ev.text, "we are here.");
  assert.equal(speech?.ev.boundary, true);
  assert.equal(speech?.ev.lang, "en");
  pub.close();
});
test("publisher: with captionsJapaneseSpeech off, lane 2 sends no as-said events", () => {
  const pub = new CaptionPublisher(transport(), true, 10, false, undefined, undefined, EN, "captions-en");
  assert.equal(pub.japaneseTapFor(1, () => 0), undefined);
});
