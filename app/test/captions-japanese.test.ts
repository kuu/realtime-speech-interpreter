// Listener page: Japanese speech shown as said (marker, colour class, lines, retract) and the fixed layout (node:test).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const m: any = await import(new URL("../web/captions.js", import.meta.url).href);
const { parseEvent, createAssembler, createSourceAssembler, computeLayout, SAID_MARKER, LAYOUT } = m;
const cap = (text: string, extra: object = {}) =>
  JSON.stringify({ v: 1, type: "caption", id: "1-1", seq: 1, channel: "ja", lang: "ja", text, speaker: null, final: true, ...extra });
const say = (text: string, extra: object = {}) =>
  JSON.stringify({ v: 1, type: "speech", op: "append", resultId: "j1", channel: "ja", lang: "ja", asSaid: true, text, boundary: false, speaker: null, ...extra });
const unsay = (resultId: string) => JSON.stringify({ v: 1, type: "speech", op: "retract", resultId, channel: "ja", lang: "ja", asSaid: true });
const push = (a: any, raw: string, now: number) => a.push(parseEvent(raw), now);
test("marker is the full-width dash U+2015 plus a space and is display-only", () => {
  assert.equal(SAID_MARKER, "\u2015 ");
  const a = createAssembler();
  push(a, say("ご質問をどうぞ。", { boundary: true }), 0);
  const [l] = a.model(0);
  assert.equal(l.said, true);
  assert.equal(l.text, "ご質問をどうぞ。", "the line text has no marker");
  assert.equal(l.shown, "\u2015 ご質問をどうぞ。");
  push(a, cap("こんにちは。"), 10);
  assert.equal(a.model(10)[1].said, false);
  assert.equal(a.model(10)[1].shown, "こんにちは。", "translations have no marker");
});
test("speech events: other languages, missing asSaid and bad input are ignored; unknown events never throw", () => {
  for (const bad of [
    say("x", { asSaid: false }), say("x", { asSaid: undefined }), say("x", { channel: "en" }), say(""),
    say("x", { resultId: "" }), JSON.stringify({ v: 1, type: "speech", op: "weird", resultId: "r", asSaid: true, channel: "ja" }),
    JSON.stringify({ v: 2, type: "speech", op: "append", resultId: "r", asSaid: true, channel: "ja", text: "x" }),
  ]) assert.equal(parseEvent(bad), null, bad);
  assert.ok(parseEvent(say("あ", { future: 1 })), "unknown extra fields are fine");
});
test("old pages ignore the new event type: the English assembler and caption path see no speech", () => {
  const en = createSourceAssembler();
  assert.equal(en.push(parseEvent(say("質問です。")), 0), false);
  assert.deepEqual(en.model(0), []);
  // A page that predates `speech` ignores any unknown `type` (parseEvent returns null for it, here the pre-change rule):
  assert.equal(parseEvent(JSON.stringify({ v: 1, type: "somethingnew", text: "x" })), null);
});
test("a change between translated and as-said Japanese always starts a new line, both ways", () => {
  const a = createAssembler();
  push(a, cap("翻訳の最初の部分、"), 0); // unfinished sentence
  push(a, say("質問です", {}), 100);
  push(a, cap("翻訳の続き"), 200); // back to translated: new line again
  const model = a.model(200);
  assert.deepEqual(model.map((l: any) => [l.said, l.text]), [[false, "翻訳の最初の部分、"], [true, "質問です"], [false, "翻訳の続き"]]);
});
test("as-said: sentence grouping inside one source; results merge until 。？！ closes the line", () => {
  const a = createAssembler();
  push(a, say("今日は"), 0);
  push(a, say("皆さん、", { resultId: "j1" }), 100);
  push(a, say("ありがとうございます。", { resultId: "j1", boundary: true }), 200);
  push(a, say("次の質問です"), 300);
  const t = a.model(300).map((l: any) => l.text);
  assert.deepEqual(t, ["今日は皆さん、ありがとうございます。", "次の質問です"]);
});
test("as-said and translated lines interleave in arrival order", () => {
  const a = createAssembler();
  push(a, say("質問です。", { boundary: true }), 0);
  push(a, cap("答えです。"), 10);
  push(a, say("もう一つ。", { boundary: true }), 20);
  assert.deepEqual(a.model(20).map((l: any) => [l.said, l.text]), [[true, "質問です。"], [false, "答えです。"], [true, "もう一つ。"]]);
});
test("retract removes the as-said words of that result, drops empty lines, keeps others; unknown id is a no-op", () => {
  const a = createAssembler();
  push(a, say("誤認識です。", { resultId: "flip1", boundary: true }), 0);
  push(a, say("本物の質問", { resultId: "real1" }), 10);
  push(a, unsay("unknown"), 20);
  assert.equal(a.model(20).length, 2);
  push(a, unsay("flip1"), 30);
  assert.deepEqual(a.model(30).map((l: any) => l.text), ["本物の質問"]);
  push(a, unsay("real1"), 40);
  assert.deepEqual(a.model(40), []);
});
test("flip then translation: no duplicate (retract first, then only the translation is shown)", () => {
  const a = createAssembler();
  push(a, say("あ そう です ね"), 0);
  push(a, unsay("j1"), 100);
  push(a, cap("そうですね。"), 200);
  assert.deepEqual(a.model(200).map((l: any) => [l.said, l.text]), [[false, "そうですね。"]]);
});
test("as-said lines fade and expire like the others", () => {
  const a = createAssembler();
  push(a, say("質問です。", { boundary: true }), 0);
  assert.equal(a.model(1000)[0].state, "live");
  assert.equal(a.model(12_100)[0].state, "fading");
  a.tick(12_700);
  assert.deepEqual(a.model(12_700), []);
});
test("?source=off does not affect as-said Japanese (it lives in the Japanese area)", () => {
  const a = createAssembler(); // the page creates the Japanese assembler regardless of ?source
  push(a, say("質問です。", { boundary: true }), 0);
  assert.equal(a.model(0).length, 1);
  const html = readFileSync(new URL("../web/subscriber.js", import.meta.url), "utf8");
  assert.match(html, /blocks = \[\s*\{ el: document.getElementById\("captions-ja"\)/);
});
test("plain text: markup in as-said text comes out unchanged", () => {
  const a = createAssembler();
  push(a, say('<img src=x onerror=alert(1)> & "q"', { boundary: false }), 0);
  assert.equal(a.model(0)[0].text, '<img src=x onerror=alert(1)> & "q"');
});
// ---- layout ----
const px = (svh: number, font: [number, number], hintBottom: number, safe = 0) =>
  computeLayout({ svh, safeBottom: safe, hintBottom, jaFont: font[0], enFont: font[1] });
function inside(L: any, svh: number, hintBottom: number, safe = 0) {
  assert.ok(L.jaTop >= hintBottom, `Japanese area starts below the hint (${L.jaTop} >= ${hintBottom})`);
  assert.ok(L.jaTop + L.jaHeight <= L.enTop, "no overlap between the two areas");
  assert.ok(L.enTop + L.enHeight <= svh - safe, "English area above the safe area and inside the viewport");
}
test("layout: iPhone-like sizes give whole lines, a gap, and nothing overlaps", () => {
  for (const [svh, hint] of [[664, 330], [744, 330], [844, 330]] as const) {
    const L = px(svh, [18.2, 13.9], hint, 0);
    inside(L, svh, hint);
    assert.equal(L.enLines, 3);
    assert.ok(L.jaLines >= 4 && L.jaLines <= LAYOUT.maxJaLines, `ja lines ${L.jaLines}`);
    assert.ok(L.enTop - (L.jaTop + L.jaHeight) >= LAYOUT.gapMin, "clear gap");
    assert.ok(Math.abs(L.jaHeight / (18.2 * 1.5) - L.jaLines) < 1e-9, "whole lines");
  }
});
test("layout: depends only on svh, so a toolbar change (innerHeight) cannot move it", () => {
  const a = px(664, [18.2, 13.9], 330);
  const b = px(664, [18.2, 13.9], 330);
  assert.deepEqual(a, b);
});
test("layout: safe-area inset lifts the English area; landscape phone keeps the hint and shrinks the lines", () => {
  const a = px(844, [18.2, 13.9], 330, 0);
  const b = px(844, [18.2, 13.9], 330, 34);
  assert.equal(a.enTop - b.enTop, 34);
  const land = px(390, [16.8, 13.6], 250);
  inside(land, 390, 250);
  assert.ok(land.enLines >= 1 && land.jaLines >= 0);
});
test("layout: large screens stay within the line caps", () => {
  for (const [svh, hint, f] of [[768, 330, [21, 15]], [1080, 330, [41.6, 22]]] as const) {
    const L = px(svh, [f[0], f[1]], hint);
    inside(L, svh, hint);
    assert.ok(L.jaLines <= LAYOUT.maxJaLines && L.enLines <= LAYOUT.maxEnLines);
  }
});
test("page: positions come from svh with a 100vh fallback, never dvh; the hint is never hidden", () => {
  const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
  const js = readFileSync(new URL("../web/subscriber.js", import.meta.url), "utf8");
  assert.ok(!/\ddvh/.test(html) && !/\ddvh/.test(js), "no dvh");
  assert.match(html, /100svh/);
  assert.ok(!/\.hint\s*\{\s*display:\s*none/.test(html) && !/max-height[^}]*\.hint/.test(html), "hint stays visible");
  assert.ok(!/innerHeight/.test(js.replace(/Math\.min\(h, window\.innerHeight\)/, "")), "innerHeight only as the no-svh fallback");
});
