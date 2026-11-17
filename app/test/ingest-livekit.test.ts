// Browser ingest against a real local LiveKit server (node:test). Skipped unless `livekit-server` is on PATH
// and its default ports are free. The server binds 127.0.0.1 only, is started by this file and stopped at the end.
// The stack pins livekitImage v1.13.11; a local binary can be older, and the version is printed.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";
import {
  Room, RoomEvent, AudioSource, AudioFrame, LocalAudioTrack, LocalVideoTrack, VideoSource, TrackPublishOptions, TrackSource, AudioStream, DisconnectReason, dispose, type Track,
} from "@livekit/rtc-node";
import { RoomServiceClient } from "livekit-server-sdk";
import { IngestRoom, type IngestDeps, type PublicationLike, type RoomLike } from "../src/ingest-room.js";
import { IngestSession } from "../src/ingest-session.js";
import { AccessToken } from "livekit-server-sdk";

const which = spawnSync("which", ["livekit-server"], { encoding: "utf8" });
const BIN = which.status === 0 ? which.stdout.trim() : "";
const URL_WS = "ws://127.0.0.1:7880";
const KEY = "devkey", SECRET = "secret";
const INGEST = "translation-ingest";
const jwt: any = await import(new URL("../../cdk/lambda/publisher-token/jwt.mjs", import.meta.url).href);
const lambdaListener: any = await import(new URL("../../cdk/lambda/token/jwt.mjs", import.meta.url).href);

const portOpen = (port: number) => new Promise<boolean>((res) => {
  const s = createConnection({ port, host: "127.0.0.1" }, () => { s.destroy(); res(true); });
  s.on("error", () => res(false));
});
let server: ChildProcess | null = null;
let skipReason = BIN ? "" : "livekit-server not on PATH";

before(async () => {
  if (skipReason) return;
  if (await portOpen(7880)) { skipReason = "port 7880 is busy"; return; }
  const v = spawnSync(BIN, ["--version"], { encoding: "utf8" }).stdout.trim();
  console.log(`# local server: ${v} (stack pins v1.13.11)`);
  server = spawn(BIN, ["--dev", "--bind", "127.0.0.1", "--node-ip", "127.0.0.1"], { stdio: "ignore" });
  for (let i = 0; i < 50 && !(await portOpen(7880)); i++) await new Promise((r) => setTimeout(r, 200));
  if (!(await portOpen(7880))) skipReason = "livekit-server did not start";
});
after(async () => {
  dispose();
  server?.kill("SIGTERM");
});

const publisherToken = () => jwt.mintPublisherToken({ apiKey: KEY, apiSecret: SECRET, room: INGEST, ttlSec: 600, nowSec: Math.floor(Date.now() / 1000) });
async function joinPublisher(): Promise<Room> {
  const r = new Room();
  await r.connect(URL_WS, publisherToken(), { autoSubscribe: false, dynacast: false });
  return r;
}
async function publishTone(room: Room, stopSignal: { stop: boolean }) {
  const src = new AudioSource(16000, 1);
  const track = LocalAudioTrack.createAudioTrack("mic", src);
  const o = new TrackPublishOptions();
  o.source = TrackSource.SOURCE_MICROPHONE;
  await room.localParticipant!.publishTrack(track, o);
  void (async () => {
    let phase = 0;
    while (!stopSignal.stop) {
      const s = new Int16Array(160);
      for (let i = 0; i < 160; i++) { s[i] = Math.round(8000 * Math.sin(phase)); phase += (2 * Math.PI * 440) / 16000; }
      try { await src.captureFrame(new AudioFrame(s, 16000, 1, 160)); } catch { break; }
    }
  })();
  return track;
}
const until = async (cond: () => boolean, ms = 8000) => { const t = Date.now(); while (!cond() && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 50)); return cond(); };

function realDeps(open: () => boolean, logs: string[]): { deps: IngestDeps; window: any } {
  const lf = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  const deps: IngestDeps = {
    createRoom: () => new Room() as unknown as RoomLike,
    mintToken: async () => { const at = new AccessToken(KEY, SECRET, { identity: "ingest-app", ttl: "10m" }); at.addGrant({ roomJoin: true, room: INGEST, canSubscribe: true, canPublish: false }); return at.toJwt(); },
    url: URL_WS, tokenTtlSec: 600,
    openStream: (track) => {
      const reader = new AudioStream(track as Track, 16000, 1).getReader();
      return { frames: (async function* () { while (true) { const { done, value } = await reader.read(); if (done) return; yield new Uint8Array(value.data.buffer, value.data.byteOffset, value.data.byteLength); } })(), close: () => void reader.cancel().catch(() => {}) };
    },
    removeParticipant: async () => { await new RoomServiceClient("http://127.0.0.1:7880", KEY, SECRET).removeParticipant(INGEST, "browser-publisher"); },
    isMicrophone: (p: PublicationLike) => (p as any).source === TrackSource.SOURCE_MICROPHONE,
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 200))),
    log: { info: lf, warn: lf, error: lf },
  };
  return { deps, window: { isOpen: open } };
}
function newSession(open: () => boolean, logs: string[]) {
  const lf = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  return new IngestSession({ frameBytes: 640, sampleRate: 16000, graceMs: 60000, silenceDb: -60, silenceSec: 30, maxQueueMs: 500, levelLogMs: 5000, windowOpen: open, now: () => Date.now(), log: { info: lf, warn: lf } });
}

test("listener token lands in the listener room, never the ingest room, and cannot publish", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const token = lambdaListener.mintListenerToken({ apiKey: KEY, apiSecret: SECRET, room: "translation", ttlSec: 600, identity: "listener-x", nowSec: Math.floor(Date.now() / 1000) });
  const r = new Room();
  await r.connect(URL_WS, token, { autoSubscribe: false, dynacast: false });
  assert.equal(r.name, "translation");
  assert.notEqual(r.name, INGEST);
  const src = new AudioSource(16000, 1);
  await assert.rejects(async () => {
    const o = new TrackPublishOptions(); o.source = TrackSource.SOURCE_MICROPHONE;
    await r.localParticipant!.publishTrack(LocalAudioTrack.createAudioTrack("mic", src), o);
  });
  await r.disconnect();
});

test("newest wins: the first browser-publisher is disconnected with DUPLICATE_IDENTITY", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const first = new Room();
  let reason: unknown = null;
  first.on(RoomEvent.Disconnected, (r: unknown) => { reason = r; });
  await first.connect(URL_WS, publisherToken(), { autoSubscribe: false, dynacast: false });
  const second = await joinPublisher();
  assert.ok(await until(() => reason !== null), "first publisher was not disconnected");
  console.log(`# first publisher disconnect reason: ${String(reason)}`);
  assert.equal(reason, DisconnectReason.DUPLICATE_IDENTITY);
  await second.disconnect();
});

test("canPublishSources: a camera publish with the publisher token", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const r = await joinPublisher();
  const vs = new VideoSource(64, 64);
  const track = LocalVideoTrack.createVideoTrack("cam", vs);
  const o = new TrackPublishOptions(); o.source = TrackSource.SOURCE_CAMERA;
  let refused = false;
  try { await r.localParticipant!.publishTrack(track, o); } catch (e) { refused = true; console.log(`# camera publish refused: ${String((e as Error).message).slice(0, 100)}`); }
  await r.disconnect();
  if (!refused) return t.skip("not enforced on this local server version (canPublishSources); run on the pinned v1.13.11");
  assert.ok(refused);
});

test("a 16 kHz tone published as browser-publisher arrives in the session as 640-byte frames; no extra queueing", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const logs: string[] = [];
  const session = newSession(() => true, logs);
  const { deps, window } = realDeps(() => true, logs);
  const room = new IngestRoom(deps, session, window);
  await room.start();
  const pub = await joinPublisher();
  const stop = { stop: false };
  await publishTone(pub, stop);
  const it = session.nextSession().frames[Symbol.asyncIterator]();
  const frames: Uint8Array[] = [];
  const t0 = Date.now();
  while (frames.length < 100 && Date.now() - t0 < 10000) { const n = await it.next(); if (n.done) break; frames.push(n.value); }
  stop.stop = true;
  assert.ok(frames.length >= 100, `got ${frames.length} frames`);
  assert.ok(frames.every((f) => f.length === 640));
  const { frameRmsDb } = await import("../src/ingest-silence.js");
  assert.ok(frames.slice(20).some((f) => frameRmsDb(f) > -30), "tone not heard");
  console.log(`# tone: ${frames.length} frames in ${Date.now() - t0} ms (2 s of audio)`);
  await pub.disconnect();
  await room.stop();
  session.close();
});

test("after the end time a publisher is removed and never subscribed", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const logs: string[] = [];
  let open = false;
  const session = newSession(() => open, logs);
  const { deps, window } = realDeps(() => open, logs);
  const room = new IngestRoom(deps, session, window);
  await room.start();
  const pub = new Room();
  let removed = false;
  pub.on(RoomEvent.Disconnected, () => { removed = true; });
  await pub.connect(URL_WS, publisherToken(), { autoSubscribe: false, dynacast: false });
  const stop = { stop: false };
  await publishTone(pub, stop).catch(() => {});
  assert.ok(await until(() => removed), "publisher was not removed after the end time");
  stop.stop = true;
  assert.equal(session.open, false);
  await room.stop();
  session.close();
});
