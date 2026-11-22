// Listener page, English channel: assemblers per language, role routing, layout with swapped font sizes (node:test).
import { test } from "node:test";
import assert from "node:assert/strict";
const m: any = await import(new URL("../web/captions.js", import.meta.url).href);
const { parseEvent, createAssembler, createSourceAssembler, computeLayout, SAID_MARKER } = m;

const cap = (text: string, extra: object = {}) =>
  JSON.stringify({ v: 1, type: "caption", id: "en:1-1", seq: 1, ch: "en", channel: "en", lang: "en", text, speaker: null, final: true, ...extra });
const src = (text: string, extra: object = {}) =>
  JSON.stringify({ v: 1, type: "source", op: "append", ch: "en", resultId: "r1", channel: "ja", lang: "ja", text, boundary: false, ...extra });
const speech = (text: string, extra: object = {}) =>
  JSON.stringify({ v: 1, type: "speech", op: "append", ch: "en", resultId: "s1", channel: "en", lang: "en", asSaid: true, text, boundary: true, ...extra });
const shown = (a: any, now: number) => a.model(now).map((l: any) => l.shown);

test("the English translation assembler joins words with a space and closes lines at an English sentence end", () => {
  const a = createAssembler({}, true, "en");
  a.push(parseEvent(cap("We are")), 1000);
  a.push(parseEvent(cap("happy to be here.")), 1100);
  a.push(parseEvent(cap("Next topic")), 1200);
  assert.deepEqual(shown(a, 1300), ["We are happy to be here.", "Next topic"]);
});
test("the English translation assembler ignores Japanese-channel events; the default assembler ignores English ones", () => {
  const en = createAssembler({}, true, "en");
  const ja = createAssembler();
  assert.equal(en.push(parseEvent(cap("こんにちは。", { channel: "ja", lang: "ja" })), 1), false);
  assert.equal(ja.push(parseEvent(cap("Hello.")), 1), false);
  assert.equal(ja.push(parseEvent(cap("こんにちは。", { channel: "ja", lang: "ja" })), 1), true);
});
test("English as-said: marker in front, .said, a change of kind starts a new line", () => {
  const a = createAssembler({}, true, "en");
  a.push(parseEvent(cap("Welcome everyone.")), 1000);
  a.push(parseEvent(speech("Thank you.")), 1100);
  const m1 = a.model(1200);
  assert.deepEqual(m1.map((l: any) => l.shown), ["Welcome everyone.", `${SAID_MARKER}Thank you.`]);
  assert.deepEqual(m1.map((l: any) => l.said), [false, true]);
});
test("English as-said waits for an open translated sentence (up to 3 s), as on the Japanese channel", () => {
  const a = createAssembler({}, true, "en");
  a.push(parseEvent(cap("We will show")), 1000); // open sentence
  a.push(parseEvent(speech("Yes.")), 1100);
  assert.deepEqual(shown(a, 1200), ["We will show"], "queued");
  a.push(parseEvent(cap("the demo.")), 1300);
  assert.deepEqual(shown(a, 1400), ["We will show the demo.", `${SAID_MARKER}Yes.`]);
});
test("a retract removes the as-said English of that result", () => {
  const a = createAssembler({}, true, "en");
  a.push(parseEvent(speech("Maybe.")), 1000);
  assert.equal(shown(a, 1100).length, 1);
  a.push(parseEvent(JSON.stringify({ v: 1, type: "speech", op: "retract", ch: "en", resultId: "s1", channel: "en", lang: "en", asSaid: true })), 1200);
  assert.deepEqual(shown(a, 1300), []);
});
test("the Japanese source assembler joins without spaces and closes at 。", () => {
  const a = createSourceAssembler({}, "ja");
  a.push(parseEvent(src("今日は")), 1000);
  a.push(parseEvent(src("晴れです。次は")), 1100);
  assert.deepEqual(shown(a, 1200), ["今日は晴れです。", "次は"]);
  assert.equal(a.push(parseEvent(src("Hello.", { channel: "en" })), 1300), false);
});
test("a retract removes Japanese source words of that result; the English source assembler is unchanged by the lang default", () => {
  const a = createSourceAssembler({}, "ja");
  a.push(parseEvent(src("今日は")), 1000);
  a.push(parseEvent(JSON.stringify({ v: 1, type: "source", op: "retract", resultId: "r1" })), 1100);
  assert.deepEqual(shown(a, 1200), []);
  const e = createSourceAssembler();
  e.push(parseEvent(JSON.stringify({ v: 1, type: "source", op: "append", resultId: "r", channel: "en", text: "Hello there.", boundary: true })), 1);
  assert.deepEqual(shown(e, 2), ["Hello there."]);
});
test("a long Japanese source line is cut at 、 (or the limit), not left in one piece", () => {
  const a = createSourceAssembler({}, "ja");
  const long = "これは長い文の最初の部分です、" + "あ".repeat(70) + "です。";
  a.push(parseEvent(src(long)), 1000);
  const lines = shown(a, 1100);
  assert.ok(lines.length >= 2, lines.join("|"));
  assert.equal(lines.join(""), long);
});
test("layout: five viewports, swapped font sizes on the English channel keep both areas inside the screen", () => {
  const vps = [[390, 844], [390, 664], [844, 390], [1366, 768], [1920, 1080]];
  for (const [w, h] of vps) {
    for (const english of [false, true]) {
      // large translation font and small source font; on the English channel the large one is the lower (English) element
      const big = Math.min(2.6 * 16, Math.max(1.05 * 16, Math.min(0.022 * w + 9.6, 0.042 * h)));
      const small = Math.min(1.7 * 16, Math.max(0.85 * 16, Math.min(0.014 * w + 8, 0.028 * h)));
      const L = computeLayout({ svh: h, safeBottom: 0, hintBottom: 220, jaFont: english ? small : big, enFont: english ? big : small });
      assert.ok(L.enLines >= 1 && L.enLines <= 3, `${w}x${h} en lines ${L.enLines}`);
      assert.ok(L.jaLines >= 0 && L.jaLines <= 8);
      assert.ok(L.enTop + L.enHeight <= h, `${w}x${h} english area below the screen`);
      assert.ok(L.jaHeight === 0 || L.jaTop >= 220, `${w}x${h} japanese area over the hint`);
      assert.ok(L.jaHeight === 0 || L.jaTop + L.jaHeight <= L.enTop, `${w}x${h} areas overlap`);
    }
  }
});
test("?source=off still parses (the source element is hidden on both channels)", () => {
  assert.equal(m.parseSourceOption("?ch=en&source=off"), false);
  assert.equal(m.parseSourceOption("?ch=en"), true);
});
