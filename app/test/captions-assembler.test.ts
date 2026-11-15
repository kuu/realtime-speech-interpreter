// Tests for the listener page's caption logic (app/web/captions.js) and the page's plain-text rule (node:test).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The page module is plain JS without types; load it by URL so the type checker does not resolve it.
const m: any = await import(new URL("../web/captions.js", import.meta.url).href);
const { parseEvent, parseCaptionEvent, parseSourceOption, createAssembler, createSourceAssembler } = m;

const cap = (text: string, extra: object = {}) =>
  JSON.stringify({ v: 1, type: "caption", id: "1-1", seq: 1, channel: "ja", lang: "ja", text, speaker: null, final: true, ...extra });
const src = (text: string, extra: object = {}) =>
  JSON.stringify({ v: 1, type: "source", op: "append", resultId: "r1", channel: "en", text, boundary: false, ...extra });
const retract = (resultId: string) => JSON.stringify({ v: 1, type: "source", op: "retract", resultId });
const ja = (a: any, text: string, now: number, extra: object = {}) => a.push(parseEvent(cap(text, extra)), now);
const en = (a: any, text: string, now: number, extra: object = {}) => a.push(parseEvent(src(text, extra)), now);
const texts = (model: any[]) => model.map((l) => l.text);

test("parseEvent rejects bad input and never throws", () => {
  for (const bad of [
    "not json", "null", "[]", "{}",
    JSON.stringify({ v: 2, type: "caption", text: "x" }),
    JSON.stringify({ v: 1, type: "other", text: "x" }),
    cap(""), cap("   "), JSON.stringify({ v: 1, type: "caption", text: 5 }),
    cap("x", { final: false }), cap("あ".repeat(601)),
    JSON.stringify({ v: 1, type: "source", op: "append", text: "x" }), // no resultId
    JSON.stringify({ v: 1, type: "source", op: "weird", resultId: "r" }),
    src(""),
  ]) assert.equal(parseEvent(bad), null, bad);
  assert.equal(parseEvent(new Uint8Array([0xff, 0xfe])), null);
});

test("parseEvent accepts unknown extra fields and bytes", () => {
  const ev = parseEvent(new TextEncoder().encode(cap("こんにちは", { speaker: "s1", future: { a: 1 }, channel: "ja" })));
  assert.equal(ev.kind, "caption");
  assert.equal(ev.speaker, "s1");
  assert.equal(parseCaptionEvent(src("x")), null);
  assert.equal(parseEvent(retract("r1")).op, "retract");
});

test("Japanese: chunks of one sentence merge, 。 closes, next starts a new line", () => {
  const a = createAssembler();
  ja(a, "今日は", 0);
  ja(a, "新しいサービスについて話します", 1000);
  assert.deepEqual(texts(a.model(1000)), ["今日は新しいサービスについて話します"]);
  ja(a, "。", 1500);
  ja(a, "次に進みます。", 2000);
  assert.deepEqual(texts(a.model(2000)), ["今日は新しいサービスについて話します。", "次に進みます。"]);
});

test("Japanese: ASCII edges get a space, CJK edges do not", () => {
  const a = createAssembler();
  ja(a, "これは AWS", 0);
  ja(a, "Lambda です", 10);
  assert.deepEqual(texts(a.model(10)), ["これは AWS Lambda です"]);
});

test("Japanese: max 3 lines, oldest dropped; max length closes a line", () => {
  const a = createAssembler();
  for (let i = 1; i <= 4; i++) ja(a, `文${i}です。`, i * 100);
  assert.deepEqual(texts(a.model(500)), ["文2です。", "文3です。", "文4です。"]);
  const b = createAssembler({ maxLineChars: 10 });
  ja(b, "あ".repeat(10), 0);
  ja(b, "い", 10);
  assert.equal(b.model(10).length, 2);
});

test("Japanese: a quiet gap closes an unterminated line", () => {
  const a = createAssembler({ lineGapMs: 6000 });
  ja(a, "続きます", 0);
  a.tick(7000);
  ja(a, "新しい文", 7100);
  assert.deepEqual(texts(a.model(7100)), ["続きます", "新しい文"]);
});

test("fade bookkeeping: live, old, fading, removed; idle model is empty", () => {
  const a = createAssembler({ lineTtlMs: 1000, fadeMs: 200 });
  ja(a, "一つ目。", 0);
  ja(a, "二つ目。", 500);
  assert.deepEqual(a.model(600).map((l: any) => l.state), ["old", "live"]);
  assert.deepEqual(a.model(1100).map((l: any) => l.state), ["fading", "live"]);
  a.tick(1250);
  assert.deepEqual(texts(a.model(1250)), ["二つ目。"]);
  a.tick(2000);
  assert.deepEqual(a.model(2000), []);
});

test("Japanese assembler ignores source events and other channels", () => {
  const a = createAssembler();
  assert.equal(a.push(parseEvent(src("hello")), 0), false);
  assert.equal(a.push(parseEvent(cap("x", { channel: "en" })), 0), false);
  assert.deepEqual(a.model(0), []);
});

test("English: appends join with spaces, punctuation attaches, boundary closes the line", () => {
  const a = createSourceAssembler();
  en(a, "so today", 0);
  en(a, "we are", 100);
  en(a, ", building", 200);
  assert.deepEqual(texts(a.model(200)), ["so today we are, building"]);
  en(a, "it.", 300, { boundary: true });
  en(a, "next one", 400);
  assert.deepEqual(texts(a.model(400)), ["so today we are, building it.", "next one"]);
});

test("English: a batch with two sentences splits into two lines; max 3 lines roll", () => {
  const a = createSourceAssembler();
  en(a, "One two. Three four. Five six. Seven", 0);
  assert.deepEqual(texts(a.model(0)), ["Three four.", "Five six.", "Seven"]);
});

test("English: max length closes a line; quiet gap closes a line", () => {
  const a = createSourceAssembler({ maxLineChars: 12 });
  en(a, "aaaa bbbb cccc", 0);
  en(a, "dddd", 10);
  assert.equal(a.model(10).length, 2);
  const b = createSourceAssembler({ lineGapMs: 1000 });
  en(b, "hello", 0);
  b.tick(1500);
  en(b, "again", 1600);
  assert.deepEqual(texts(b.model(1600)), ["hello", "again"]);
});

test("English: retract removes that result's words, drops empty lines, unknown id is a no-op", () => {
  const a = createSourceAssembler();
  en(a, "good words", 0, { resultId: "r1" });
  en(a, "and more", 10, { resultId: "r2" });
  a.push(parseEvent(retract("zzz")), 20);
  assert.deepEqual(texts(a.model(20)), ["good words and more"]);
  a.push(parseEvent(retract("r2")), 30);
  assert.deepEqual(texts(a.model(30)), ["good words"]);
  a.push(parseEvent(retract("r1")), 40);
  assert.deepEqual(a.model(40), []);
});

test("?source option: English is on unless source=off", () => {
  assert.equal(parseSourceOption(""), true);
  assert.equal(parseSourceOption("?source=off"), false);
  assert.equal(parseSourceOption("?x=1&source=off"), false);
  assert.equal(parseSourceOption("?source=OFF"), false);
  assert.equal(parseSourceOption("?source=en"), true);
  assert.equal(parseSourceOption("?source=ja"), true);
  assert.equal(parseSourceOption("?x=1"), true);
});

test("plain text: markup, ampersands and quotes come out of the model unchanged", () => {
  const nasty = `<script>alert(1)</script> & "q" <b>x</b>`;
  const a = createAssembler();
  ja(a, nasty, 0);
  assert.equal(a.model(0)[0].text, nasty);
  const e = createSourceAssembler();
  en(e, nasty, 0);
  assert.equal(e.model(0)[0].text, nasty);
});

test("the page never uses innerHTML-style sinks", () => {
  for (const f of ["../web/subscriber.js", "../web/index.html", "../web/captions.js"]) {
    const text = readFileSync(new URL(f, import.meta.url), "utf8");
    for (const bad of ["innerHTML", "insertAdjacentHTML", "outerHTML", "document.write", "eval(", "new Function"]) {
      assert.ok(!text.includes(bad), `${f} contains ${bad}`);
    }
  }
});

test("the page reads captions only after Listen: no connection code runs at load", () => {
  const text = readFileSync(new URL("../web/subscriber.js", import.meta.url), "utf8");
  const click = text.indexOf('listenBtn.addEventListener("click"');
  assert.ok(click > 0);
  assert.ok(!text.slice(click).includes("DOMContentLoaded"));
  assert.ok(text.indexOf("room.connect(") > click, "connect is inside the click handler");
  assert.ok(text.indexOf("new Room()") > click, "Room is created inside the click handler");
});
