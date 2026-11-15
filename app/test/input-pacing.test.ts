// Unit tests for the INPUT_FILE pacing (node:test). Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { pacingDelayMs } from "../src/input-pacing.js";

const BPMS = 32; // 16 kHz s16le mono = 32 bytes per ms
const FRAME = 3200; // 100 ms

test("sleep mode always waits one frame (old behavior)", () => {
  assert.equal(pacingDelayMs("sleep", 0, FRAME, BPMS, 100, 0), 100);
  assert.equal(pacingDelayMs("sleep", 0, FRAME * 50, BPMS, 100, 99_999), 100);
});

test("absolute mode waits exactly until the next frame is due, never negative", () => {
  // 3 frames sent (300 ms of audio), 120 ms elapsed → 180 ms to wait
  assert.equal(pacingDelayMs("absolute", 1000, FRAME * 3, BPMS, 100, 1120), 180);
  // late: 300 ms of audio sent, 450 ms elapsed → no wait
  assert.equal(pacingDelayMs("absolute", 1000, FRAME * 3, BPMS, 100, 1450), 0);
});

test("absolute mode does not drift with timer overshoot; sleep mode does", () => {
  // Simulate 2400 frames (240 s) where every sleep overshoots by 1 ms.
  const simulate = (mode: "absolute" | "sleep") => {
    let now = 0;
    let sent = 0;
    for (let k = 0; k < 2400; k++) {
      sent += FRAME;
      const d = pacingDelayMs(mode, 0, sent, BPMS, 100, now);
      now += d + 1; // overshoot
    }
    return now - sent / BPMS; // wall time minus audio time
  };
  const abs = simulate("absolute");
  const slp = simulate("sleep");
  assert.ok(Math.abs(abs) <= 100, `absolute drift ${abs} ms`);
  assert.ok(slp >= 2400, `sleep drift ${slp} ms`);
});
