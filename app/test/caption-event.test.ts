// Unit tests for the caption event builders (node:test).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCaptionEvent,
  buildSourceAppend,
  buildSourceRetract,
  encodeCaptionEvent,
  MAX_CAPTION_TEXT,
  CAPTION_TOPIC,
} from "../src/caption-event.js";

const base = { session: 2, chunkSeq: 7, seq: 42, text: "こんにちは。", sourceText: "Hello.", startAt: 1760000000000, durationMs: 1200 };

test("caption event has exactly the v1 shape and defaults", () => {
  const ev = buildCaptionEvent(base);
  assert.deepEqual(ev, {
    v: 1, type: "caption", id: "2-7", seq: 42, session: 2, channel: "ja", lang: "ja", text: "こんにちは。",
    sourceLang: "en", sourceText: "Hello.", speaker: null, final: true, startAt: 1760000000000, durationMs: 1200,
  });
  assert.equal(CAPTION_TOPIC, "captions");
});

test("extensibility: speaker and channel pass through, no other key changes", () => {
  const a = buildCaptionEvent(base);
  const b = buildCaptionEvent({ ...base, speaker: "spk_1", channel: "en", lang: "en", sourceLang: "ja" });
  assert.deepEqual(Object.keys(a), Object.keys(b));
  assert.equal(b.speaker, "spk_1");
  assert.equal(b.channel, "en");
});

test("text is truncated at 600 code points without splitting a surrogate pair", () => {
  const text = "😀".repeat(MAX_CAPTION_TEXT + 50);
  const ev = buildCaptionEvent({ ...base, text });
  assert.equal(Array.from(ev.text).length, MAX_CAPTION_TEXT);
  assert.ok(!/[\ud800-\udbff]$/.test(ev.text));
});

test("plain-text safety: markup, ampersands and quotes round-trip unchanged", () => {
  const nasty = `<script>alert(1)</script> & "quotes" 'x' <sub alias="x">y</sub> &amp;`;
  const ev = buildCaptionEvent({ ...base, text: nasty, sourceText: nasty });
  const back = JSON.parse(new TextDecoder().decode(encodeCaptionEvent(ev)));
  assert.equal(back.text, nasty);
  assert.equal(back.sourceText, nasty);
  const src = buildSourceAppend({ session: 1, n: 1, seq: 1, resultId: "ab", text: nasty, boundary: false, audioEnd: 1 });
  assert.equal(JSON.parse(new TextDecoder().decode(encodeCaptionEvent(src))).text, nasty);
});

test("source events: append and retract shapes", () => {
  const a = buildSourceAppend({ session: 1, n: 3, seq: 9, resultId: "1a2b3c4d", text: "so today", boundary: false, audioEnd: 12.3 });
  assert.deepEqual(a, {
    v: 1, type: "source", op: "append", id: "1-3", seq: 9, session: 1, resultId: "1a2b3c4d", channel: "en", lang: "en",
    text: "so today", stable: true, boundary: false, speaker: null, audioEnd: 12.3,
  });
  assert.deepEqual(buildSourceRetract({ session: 1, seq: 10, resultId: "1a2b3c4d" }), {
    v: 1, type: "source", op: "retract", seq: 10, session: 1, resultId: "1a2b3c4d", channel: "en", lang: "en",
  });
});
