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
  push(a, cap("翻訳の最初の部分です。"), 0); // finished sentence: nothing to wait for
  push(a, say("質問です", {}), 100);
  push(a, cap("翻訳の続き"), 200); // back to translated: new line again
  const model = a.model(200);
  assert.deepEqual(model.map((l: any) => [l.said, l.text]), [[false, "翻訳の最初の部分です。"], [true, "質問です"], [false, "翻訳の続き"]]);
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

test("as-said: a continuation line of a long utterance has no marker; a new utterance has one", () => {
  const a = createAssembler({ maxLineChars: 10 });
  push(a, say("あいうえおかきくけこ", { resultId: "j1" }), 0); // reaches the max length
  push(a, say("さしすせそ", { resultId: "j2" }), 10); // same utterance, wrapped
  push(a, say("です。", { resultId: "j2" }), 20);
  push(a, say("次の発言", { resultId: "j3" }), 30); // after a sentence end: new utterance
  const m = a.model(30);
  assert.deepEqual(m.map((l: any) => l.shown), ["\u2015 あいうえおかきくけこ", "さしすせそです。", "\u2015 次の発言"]);
  assert.deepEqual(m.map((l: any) => l.said), [true, true, true], "colour class kept on the continuation");
});
test("as-said: a retract of the first wrapped line gives the continuation its marker back", () => {
  const a = createAssembler({ maxLineChars: 10 });
  push(a, say("あいうえおかきくけこ", { resultId: "j1" }), 0);
  push(a, say("さしすせそ", { resultId: "j2" }), 10);
  push(a, unsay("j1"), 20);
  assert.deepEqual(a.model(20).map((l: any) => l.shown), ["\u2015 さしすせそ"]);
});
test("translated line after a wrapped as-said line is not a continuation", () => {
  const a = createAssembler({ maxLineChars: 10 });
  push(a, say("あいうえおかきくけこ", { resultId: "j1" }), 0);
  push(a, cap("翻訳です。"), 10);
  assert.deepEqual(a.model(10).map((l: any) => l.shown), ["\u2015 あいうえおかきくけこ", "翻訳です。"]);
});
test("as-said: a translation line arriving while a question is held does not split it (whole sentence = one line)", () => {
  const a = createAssembler();
  // server order: the translation of the previous answer is played, then the whole question is published
  push(a, cap("はい、可能です。"), 0);
  push(a, say("モバイル回線が弱い会場も安定して視聴できますか？", { resultId: "q1", boundary: true }), 100);
  const m = a.model(100);
  assert.deepEqual(m.map((l: any) => l.shown), ["はい、可能です。", "\u2015 モバイル回線が弱い会場も安定して視聴できますか？"]);
  push(a, cap("次の翻訳です。"), 200);
  assert.equal(a.model(200).filter((l: any) => l.said).length, 1);
});
test("as-said: each sentence event is a new line with its marker; the rest of a sentence released early joins its line", () => {
  const a = createAssembler();
  push(a, say("はい。", { resultId: "q1", boundary: true }), 0);
  push(a, say("では質問です。", { resultId: "q1", boundary: true }), 10);
  assert.deepEqual(a.model(10).map((l: any) => l.shown), ["\u2015 はい。", "\u2015 では質問です。"]);
  push(a, say("モバイル回線が弱い会場", { resultId: "q2" }), 20); // released by the hold time, no sentence end
  a.tick(7000); // the quiet gap would have closed the line
  push(a, say("も安定して視聴できますか？", { resultId: "q2", boundary: true }), 7100);
  assert.deepEqual(a.model(7100).map((l: any) => l.shown).slice(2), ["\u2015 モバイル回線が弱い会場も安定して視聴できますか？"]);
  // but not after a translation line, and not for another result
  push(a, say("途中", { resultId: "q3" }), 7200);
  push(a, cap("翻訳です。"), 7300);
  push(a, say("の続き。", { resultId: "q3", boundary: true }), 7400);
  const t = a.model(7400).map((l: any) => l.shown);
  assert.deepEqual(t.slice(-3), ["\u2015 途中", "翻訳です。", "\u2015 の続き。"]);
});

// ---- as-said lines wait for an open translated sentence (SAID_QUEUE_MS) ----
const lines = (a: any, now: number) => a.model(now).map((l: any) => l.shown);
const Q = "\u2015 ";
test("queue: an as-said line is placed after the translated sentence it would interrupt", () => {
  const a = createAssembler();
  push(a, cap("視聴者には低い解像度が見えますが、"), 0); // open
  push(a, say("最後に、日本語の字幕には対応していますか。", { resultId: "q1", boundary: true }), 100);
  assert.deepEqual(lines(a, 100), ["視聴者には低い解像度が見えますが、"], "held, not shown");
  push(a, cap("しかし、流れは止まりません。"), 1500);
  assert.deepEqual(lines(a, 1500), ["視聴者には低い解像度が見えますが、しかし、流れは止まりません。", Q + "最後に、日本語の字幕には対応していますか。"]);
});
test("queue: released by the timeout (SAID_QUEUE_MS from when it was queued) while translated text keeps arriving", () => {
  const a = createAssembler();
  assert.equal(m.SAID_QUEUE_MS, 3000);
  push(a, cap("途中の翻訳、"), 0);
  push(a, say("質問です。", { resultId: "q1", boundary: true }), 100);
  push(a, cap("まだ途中、"), 1500);
  push(a, cap("さらに途中、"), 3000); // the sentence is still open
  a.tick(3099);
  assert.deepEqual(lines(a, 3099), ["途中の翻訳、まだ途中、さらに途中、"], "2.999 s after it was queued");
  a.tick(3100);
  assert.deepEqual(lines(a, 3100), ["途中の翻訳、まだ途中、さらに途中、", Q + "質問です。"]);
});
test("queue: released when the area has had no new translated text for the hold time", () => {
  const a = createAssembler();
  push(a, cap("途中の翻訳、"), 0);
  push(a, say("質問です。", { resultId: "q1", boundary: true }), 1000);
  a.tick(2999);
  assert.deepEqual(lines(a, 2999), ["途中の翻訳、"]);
  a.tick(3000); // 3.0 s since the last translated text (queued only 2.0 s ago)
  assert.deepEqual(lines(a, 3000), ["途中の翻訳、", Q + "質問です。"]);
});
test("queue: a line arriving after a long translation silence is placed at once", () => {
  const a = createAssembler();
  push(a, cap("途中の翻訳、"), 0);
  push(a, say("質問です。", { resultId: "q1", boundary: true }), 3500);
  assert.deepEqual(lines(a, 3500), ["途中の翻訳、", Q + "質問です。"]);
});
test("queue: two questions keep their order (FIFO), and release together after the sentence", () => {
  const a = createAssembler();
  push(a, cap("答えの前半、"), 0);
  push(a, say("一つ目の質問です。", { resultId: "q1", boundary: true }), 100);
  push(a, say("二つ目の質問です。", { resultId: "q2", boundary: true }), 200);
  assert.deepEqual(lines(a, 200), ["答えの前半、"]);
  push(a, cap("答えの後半です。"), 1000);
  assert.deepEqual(lines(a, 1000), ["答えの前半、答えの後半です。", Q + "一つ目の質問です。", Q + "二つ目の質問です。"]);
});
test("queue: a timeout releases the lines up to the expired one, in order; a later one keeps waiting", () => {
  const a = createAssembler();
  push(a, cap("答えの前半、"), 0);
  push(a, cap("さらに、"), 2000);
  push(a, say("一つ目です。", { resultId: "q1", boundary: true }), 2100);
  push(a, say("二つ目です。", { resultId: "q2", boundary: true }), 4000);
  a.tick(5100); // q1 queued 3.0 s ago; q2 only 1.1 s ago; translation text 3.1 s ago -> idle releases all
  assert.deepEqual(lines(a, 5100), ["答えの前半、さらに、", Q + "一つ目です。", Q + "二つ目です。"]);
  const b = createAssembler();
  push(b, cap("答えの前半、"), 0);
  push(b, say("一つ目です。", { resultId: "q1", boundary: true }), 100);
  push(b, cap("さらに、"), 2000);
  push(b, say("二つ目です。", { resultId: "q2", boundary: true }), 2900);
  b.tick(3100); // q1 is 3.0 s old; the translation is 1.1 s old; q2 stays queued
  assert.deepEqual(lines(b, 3100), ["答えの前半、さらに、", Q + "一つ目です。"]);
  b.tick(5000); // q2 is 2.1 s old, translation text 3.0 s ago -> idle
  assert.deepEqual(lines(b, 5000), ["答えの前半、さらに、", Q + "一つ目です。", Q + "二つ目です。"]);
});
test("queue: a retract removes a queued line (and only that one)", () => {
  const a = createAssembler();
  push(a, cap("答えの前半、"), 0);
  push(a, say("誤認識です。", { resultId: "flip", boundary: true }), 100);
  push(a, say("本当の質問です。", { resultId: "q2", boundary: true }), 200);
  push(a, unsay("flip"), 300);
  push(a, cap("答えの後半です。"), 1000);
  assert.deepEqual(lines(a, 1000), ["答えの前半、答えの後半です。", Q + "本当の質問です。"]);
});
test("queue: no queue when the newest translated line is closed, or there is none", () => {
  const a = createAssembler({ maxLines: 20 });
  push(a, say("最初の質問です。", { resultId: "q0", boundary: true }), 0);
  assert.deepEqual(lines(a, 0), [Q + "最初の質問です。"], "no translation yet");
  push(a, cap("答えです。"), 100);
  push(a, say("次の質問ですか？", { resultId: "q1", boundary: true }), 200);
  assert.deepEqual(lines(a, 200), [Q + "最初の質問です。", "答えです。", Q + "次の質問ですか？"]);
  push(a, cap("答えは「はい。」"), 300); // closing bracket after the sentence end: closed
  push(a, say("別の質問です。", { resultId: "q2", boundary: true }), 400);
  assert.equal(lines(a, 400).length, 5, "placed at once");
  push(a, cap("開いた翻訳、"), 500);
  push(a, say("三つ目の質問です。", { resultId: "q3", boundary: true }), 600);
  assert.deepEqual(lines(a, 600).slice(-1), ["開いた翻訳、"], "an open translated line queues it");
});
test("queue: translation lines are never held or reordered", () => {
  const a = createAssembler();
  push(a, cap("前半、"), 0);
  push(a, say("質問です。", { resultId: "q1", boundary: true }), 10);
  push(a, cap("中間、"), 20);
  assert.deepEqual(lines(a, 20), ["前半、中間、"], "shown at once");
  push(a, cap("終わりです。"), 30);
  push(a, cap("次の文です。"), 40);
  assert.deepEqual(lines(a, 40), ["前半、中間、終わりです。", Q + "質問です。", "次の文です。"]);
});
test("queue: the screenshot sequence gives the translated answer whole, then the question", () => {
  const a = createAssembler();
  push(a, cap("視聴者には低い解像度が見えますが、"), 61000);
  push(a, say("最後に、日本語の字幕には対応していますか。", { resultId: "q1", boundary: true }), 63000);
  push(a, cap("しかし、流れは止まりません。"), 64500);
  assert.deepEqual(lines(a, 64500), ["視聴者には低い解像度が見えますが、しかし、流れは止まりません。", Q + "最後に、日本語の字幕には対応していますか。"]);
});
test("queue: ?source=off and the English area are unaffected; showSpeech=false ignores as-said lines", () => {
  const e = createSourceAssembler();
  push(e, JSON.stringify({ v: 1, type: "source", op: "append", resultId: "r1", channel: "en", text: "Hello", boundary: false }), 0);
  assert.equal(e.model(0).length, 1);
  const a = createAssembler({}, false);
  push(a, cap("途中、"), 0);
  assert.equal(push(a, say("質問です。", { boundary: true }), 10), false);
  a.tick(10000);
  assert.equal(a.model(10000).length <= 1, true);
});
