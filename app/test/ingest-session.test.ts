// Session behaviour of the browser input with an injected clock (node:test).
import { test } from "node:test";
import assert from "node:assert/strict";
import { IngestSession } from "../src/ingest-session.js";

const RATE = 16000;
const FRAME = 640; // 20 ms
function make(over: Partial<{ open: boolean }> = {}) {
  const st = { now: 1_000_000, open: over.open ?? true, lines: [] as string[] };
  const s = new IngestSession({
    frameBytes: FRAME, sampleRate: RATE, graceMs: 60000, silenceDb: -60, silenceSec: 30, maxQueueMs: 500, levelLogMs: 5000,
    windowOpen: () => st.open, now: () => st.now,
    log: { info: (...a) => st.lines.push(a.join(" ")), warn: (...a) => st.lines.push(a.join(" ")) },
  });
  return { s, st };
}
const loud = (ms = 20) => {
  const b = Buffer.alloc((RATE * 2 * ms) / 1000);
  for (let i = 0; i < b.length / 2; i++) b.writeInt16LE(i % 2 ? 8000 : -8000, i * 2);
  return b;
};

test("no frames: no session, nothing is sent (no Transcribe stream is opened)", async () => {
  const { s, st } = make();
  const src = s.nextSession();
  const it = src.frames[Symbol.asyncIterator]();
  const first = it.next();
  for (let i = 0; i < 100; i++) { st.now += 50; s.tick(); }
  let settled = false;
  void first.then(() => (settled = true));
  await new Promise((r) => setImmediate(r));
  assert.equal(settled, false);
  assert.equal(s.open, false);
  assert.equal(s.silentFillMs, 0);
  s.close();
  assert.equal((await first).done, true);
});

test("the first real frame opens the session and is yielded unchanged and without delay", async () => {
  const { s } = make();
  const src = s.nextSession();
  const it = src.frames[Symbol.asyncIterator]();
  const first = it.next();
  s.setPublisherPresent(true);
  const f = loud();
  s.pushFrame(f);
  const got = await first;
  assert.equal(got.done, false);
  assert.deepEqual(Buffer.from(got.value as Uint8Array), f.subarray(0, FRAME));
  assert.equal(s.open, true);
});

test("silence filler: 100 ms silent frame after 100 ms without real audio, only inside an open session and window", () => {
  const { s, st } = make();
  s.tick();
  assert.equal(s.silentFillMs, 0); // no session yet
  s.setPublisherPresent(true);
  s.pushFrame(loud());
  st.now += 50; s.tick();
  assert.equal(s.silentFillMs, 0);
  st.now += 60; s.tick();
  assert.equal(s.silentFillMs, 100);
  st.open = false; // window closed: no more filler
  st.now += 200; s.tick();
  assert.equal(s.silentFillMs, 100);
});

test("a handover inside the grace time stays one session; the session ends after the grace time", async () => {
  const { s, st } = make();
  s.setPublisherPresent(true);
  s.pushFrame(loud());
  s.setPublisherPresent(false);
  st.now += 30000; s.tick();
  assert.equal(s.open, true);
  s.setPublisherPresent(true);
  s.pushFrame(loud());
  assert.equal(s.sessions, 1);
  s.setPublisherPresent(false);
  st.now += 59000; s.tick();
  assert.equal(s.open, true);
  st.now += 2000; s.tick();
  assert.equal(s.open, false);
  s.setPublisherPresent(true);
  s.pushFrame(loud());
  assert.equal(s.sessions, 2);
});

test("a stalled consumer cannot build latency: the queue is trimmed to 500 ms and the drop is counted", () => {
  const { s } = make();
  s.setPublisherPresent(true);
  for (let i = 0; i < 100; i++) s.pushFrame(loud()); // 2 s with no consumer
  assert.ok(s.droppedMs >= 1400 && s.droppedMs <= 1520, String(s.droppedMs));
});

test("frames are ignored while the window is closed", () => {
  const { s } = make({ open: false });
  s.setPublisherPresent(true);
  s.pushFrame(loud());
  assert.equal(s.open, false);
});

test("operator log lines: no publisher every 10 s, level every 5 s, silent warning", () => {
  const { s, st } = make();
  for (let i = 0; i < 220; i++) { st.now += 50; s.tick(); } // 11 s
  assert.ok(st.lines.some((l) => /\[ingest\] no publisher for \d+s/.test(l)));
  st.lines.length = 0;
  s.setPublisherPresent(true);
  const quiet = Buffer.alloc(640);
  for (let i = 0; i < 40 * 50; i++) { st.now += 20; s.pushFrame(quiet); s.tick(); } // 40 s of digital silence
  assert.ok(st.lines.some((l) => /\[ingest\] level rmsDb=-120\.0 silentMs=\d+ droppedMs=\d+/.test(l)));
  assert.ok(st.lines.some((l) => /\[ingest\] silent \d+s rmsDb=-120\.0/.test(l)));
});
