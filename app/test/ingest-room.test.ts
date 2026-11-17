// LiveKit side of the browser input, with fake room objects (node:test).
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { IngestRoom, type IngestDeps, type ParticipantLike, type PublicationLike, type RoomLike } from "../src/ingest-room.js";
import { IngestSession } from "../src/ingest-session.js";

class FakeRoom extends EventEmitter {
  remoteParticipants = new Map<string, ParticipantLike>();
  connected = false;
  failConnects = 0;
  async connect() { if (this.failConnects > 0) { this.failConnects--; throw new Error("connect refused"); } this.connected = true; }
  async disconnect() { this.connected = false; }
}
const pub = (sid: string, subs: string[]): PublicationLike => ({ sid, source: "mic", setSubscribed: (b) => { if (b) subs.push(sid); } });
const participant = (identity: string, pubs: PublicationLike[]): ParticipantLike => ({ identity, trackPublications: new Map(pubs.map((p) => [p.sid, p])) });

function setup(opts: { open?: boolean } = {}) {
  const st = { now: 1_000_000, open: opts.open ?? true, lines: [] as string[] };
  const rooms: FakeRoom[] = [];
  const subs: string[] = [];
  const streams: { track: unknown; closed: boolean; push: (b: Uint8Array) => void; end: () => void }[] = [];
  const removeCalls: number[] = [];
  let removeFail = 0;
  let removeErr: unknown = new Error("boom");
  const sleeps: number[] = [];
  const logf = (...a: unknown[]) => st.lines.push(a.map(String).join(" "));
  const session = new IngestSession({
    frameBytes: 640, sampleRate: 16000, graceMs: 60000, silenceDb: -60, silenceSec: 30, maxQueueMs: 500, levelLogMs: 5000,
    windowOpen: () => st.open, now: () => st.now, log: { info: logf, warn: logf },
  });
  const win = { isOpen: () => st.open } as any;
  const deps: IngestDeps = {
    createRoom: () => { const r = new FakeRoom(); rooms.push(r); return r as unknown as RoomLike; },
    mintToken: async () => "tok",
    url: "ws://127.0.0.1:7880",
    tokenTtlSec: 21600,
    openStream: (track) => {
      const q: Uint8Array[] = []; let wake: (() => void) | null = null; let done = false;
      const s = {
        track, closed: false,
        push: (b: Uint8Array) => { q.push(b); wake?.(); },
        end: () => { done = true; wake?.(); },
      };
      streams.push(s);
      return {
        frames: (async function* () { while (true) { if (q.length) { yield q.shift()!; continue; } if (done || s.closed) return; await new Promise<void>((r) => (wake = r)); } })(),
        close: () => { s.closed = true; wake?.(); },
      };
    },
    removeParticipant: async () => { removeCalls.push(st.now); if (removeFail > 0) { removeFail--; throw removeErr; } },
    isMicrophone: (p) => p.source === "mic",
    sleep: async (ms) => { sleeps.push(ms); },
    log: { info: logf, warn: logf, error: logf },
  };
  const room = new IngestRoom(deps, session, win);
  return { st, rooms, subs, streams, removeCalls, sleeps, session, room, setRemoveFail: (n: number, e?: unknown) => { removeFail = n; if (e) removeErr = e; } };
}
const tick = () => new Promise((r) => setImmediate(r));
const loud = () => { const b = Buffer.alloc(640); for (let i = 0; i < 320; i++) b.writeInt16LE(i % 2 ? 8000 : -8000, i * 2); return b; };

test("subscribes only to the microphone track of browser-publisher, and only inside the window", async () => {
  const t = setup();
  await t.room.start();
  const r = t.rooms[0];
  r.emit("participantConnected", participant("someone-else", [pub("X", t.subs)]));
  r.emit("participantConnected", participant("browser-publisher", [pub("A", t.subs), { sid: "CAM", source: "camera", setSubscribed: () => t.subs.push("CAM") }]));
  assert.deepEqual(t.subs, ["A"]);
  t.st.open = false;
  r.emit("trackPublished", pub("B", t.subs), participant("browser-publisher", []));
  assert.deepEqual(t.subs, ["A"]);
});

test("a publisher already present when the app joins is picked up", async () => {
  const t = setup();
  const pre = pub("P", t.subs);
  const orig = t.room as any;
  // make the first created room already hold a publisher
  const origCreate = (orig.d as IngestDeps).createRoom;
  (orig.d as IngestDeps).createRoom = () => { const r = origCreate() as unknown as FakeRoom; r.remoteParticipants.set("browser-publisher", participant("browser-publisher", [pre])); return r as unknown as RoomLike; };
  await t.room.start();
  assert.deepEqual(t.subs, ["P"]);
  assert.ok(t.st.lines.some((l) => l.includes("[ingest] publisher already present")));
});

test("audio frames go straight into the session; joined and left are logged", async () => {
  const t = setup();
  await t.room.start();
  const r = t.rooms[0];
  const p = participant("browser-publisher", [pub("A", t.subs)]);
  r.emit("trackSubscribed", { id: "t1" }, p.trackPublications.get("A"), p);
  assert.ok(t.st.lines.some((l) => l.includes("publisher joined identity=browser-publisher trackSid=A")));
  const src = t.session.nextSession();
  const it = src.frames[Symbol.asyncIterator]();
  const next = it.next();
  t.streams[0].push(loud());
  const got = await next;
  assert.equal(got.done, false);
  assert.equal((got.value as Uint8Array).length, 640);
  r.emit("trackUnsubscribed", {}, p.trackPublications.get("A"), p);
  assert.ok(t.st.lines.some((l) => l.includes("publisher left")));
});

test("newest wins: a second track replaces the first, never two feeds, in either event order", async () => {
  const t = setup();
  await t.room.start();
  const r = t.rooms[0];
  const old = participant("browser-publisher", [pub("OLD", t.subs)]);
  const neu = participant("browser-publisher", [pub("NEW", t.subs)]);
  r.emit("trackSubscribed", {}, old.trackPublications.get("OLD"), old);
  r.emit("trackSubscribed", {}, neu.trackPublications.get("NEW"), neu); // new track before the old disconnect
  assert.equal(t.streams[0].closed, true);
  assert.equal(t.streams[1].closed, false);
  r.emit("participantDisconnected", old); // old one leaves afterwards: current stays
  assert.equal(t.streams[1].closed, false);
  assert.equal(t.session.handovers, 1);
  assert.ok(t.st.lines.some((l) => l.includes("publisher replaced")));
  r.emit("participantDisconnected", neu);
  assert.equal(t.streams[1].closed, true);
});

test("after the end time a publisher is removed, never subscribed; failures retry every 10 s", async () => {
  const t = setup({ open: false });
  await t.room.start();
  const r = t.rooms[0];
  t.setRemoveFail(2);
  r.emit("participantConnected", participant("browser-publisher", [pub("A", t.subs)]));
  await tick(); await tick(); await tick();
  assert.deepEqual(t.subs, []);
  assert.equal(t.removeCalls.length, 3);
  assert.deepEqual(t.sleeps, [10000, 10000]);
  assert.ok(t.st.lines.some((l) => l.includes("remove publisher failed, retry")));
});

test("removal treats not found as done", async () => {
  const t = setup({ open: false });
  await t.room.start();
  t.setRemoveFail(5, Object.assign(new Error("participant not found"), { status: 404 }));
  await t.room.removeUntilGone();
  assert.equal(t.removeCalls.length, 1);
});

test("join failures retry with doubling backoff capped at 30 s; connection loss rejoins", async () => {
  const t = setup();
  const origCreate = (t.room as any).d.createRoom as () => FakeRoom;
  let n = 0;
  (t.room as any).d.createRoom = () => { const r = origCreate(); if (n++ < 7) r.failConnects = 1; return r as unknown as RoomLike; };
  await t.room.start();
  assert.deepEqual(t.sleeps, [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  assert.ok(t.st.lines.some((l) => l.includes("join failed, retry in 1s")));
  const before = t.rooms.length;
  t.rooms[t.rooms.length - 1].emit("disconnected");
  await tick(); await tick();
  assert.equal(t.rooms.length, before + 1);
  assert.ok(t.st.lines.some((l) => l.includes("app connection lost, rejoining")));
  assert.ok(t.st.lines.some((l) => l.includes("app reconnected")));
});
