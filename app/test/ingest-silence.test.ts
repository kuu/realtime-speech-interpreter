import { test } from "node:test";
import assert from "node:assert/strict";
import { frameRmsDb, LevelTracker } from "../src/ingest-silence.js";

const pcm = (v: number, n = 160) => {
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(v, i * 2);
  return b;
};
test("rms in dBFS: zero is the floor, full scale is 0, half scale about -6", () => {
  assert.equal(frameRmsDb(pcm(0)), -120);
  assert.ok(Math.abs(frameRmsDb(pcm(-32768))) < 0.01);
  assert.ok(Math.abs(frameRmsDb(pcm(16384)) + 6.02) < 0.05);
  assert.equal(frameRmsDb(new Uint8Array(0)), -120);
});
test("silentMs accumulates below the threshold and resets on a louder frame", () => {
  const t = new LevelTracker(-60);
  t.observe(pcm(0), 10);
  t.observe(pcm(1), 10);
  assert.equal(t.silentMs, 20);
  t.observe(pcm(8000), 10);
  assert.equal(t.silentMs, 0);
  t.reset();
  assert.equal(t.rmsDb, -120);
});
