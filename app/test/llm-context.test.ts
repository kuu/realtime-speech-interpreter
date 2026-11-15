import { test } from "node:test";
import assert from "node:assert/strict";
import { ContextBuffer } from "../src/llm-context.js";

const e = (n: number, session = 1, srcEndWall = n * 1000) => ({ en: `e${n}`, ja: `j${n}`, session, srcEndWall });

test("keeps the last N in push order", () => {
  const c = new ContextBuffer(3, 60000);
  for (let i = 1; i <= 5; i++) c.push(e(i));
  assert.deepEqual(c.prepare(1, 6000), [
    { en: "e3", ja: "j3" },
    { en: "e4", ja: "j4" },
    { en: "e5", ja: "j5" },
  ]);
});

test("capacity 0 disables context", () => {
  const c = new ContextBuffer(0, 60000);
  c.push(e(1));
  assert.equal(c.size, 0);
  assert.deepEqual(c.prepare(1, 2000), []);
});

test("resets on session change", () => {
  const c = new ContextBuffer(3, 60000);
  c.push(e(1, 1));
  assert.equal(c.prepare(1, 1500).length, 1);
  assert.equal(c.prepare(2, 1500).length, 0);
  assert.equal(c.size, 0);
});

test("resets at a 60 s source gap, not at 59.9 s", () => {
  const c = new ContextBuffer(3, 60000);
  c.push(e(1, 1, 10000));
  assert.equal(c.prepare(1, 10000 + 59900).length, 1);
  assert.equal(c.prepare(1, 10000 + 60000).length, 0);
});

test("resetMs 0 never resets on silence", () => {
  const c = new ContextBuffer(3, 0);
  c.push(e(1, 1, 0));
  assert.equal(c.prepare(1, 10_000_000).length, 1);
});

test("an unpushed (dropped, skipped or failed) chunk leaves the buffer untouched", () => {
  const c = new ContextBuffer(3, 60000);
  c.push(e(1));
  c.prepare(1, 2000); // chunk 2 prepared, then dropped: never pushed
  c.push(e(3));
  assert.deepEqual(c.prepare(1, 4000).map((x) => x.en), ["e1", "e3"]);
});

test("prepare returns copies; mutating the result does not change the buffer", () => {
  const c = new ContextBuffer(3, 60000);
  c.push(e(1));
  const p = c.prepare(1, 2000);
  p[0].en = "changed";
  assert.equal(c.prepare(1, 2000)[0].en, "e1");
});
