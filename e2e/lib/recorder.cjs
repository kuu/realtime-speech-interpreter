#!/usr/bin/env node
// Headless LiveKit SUBSCRIBER used by the E2E harness.
//
//   node recorder.cjs record <app-dir> <wss-url> <room> <out.wav> <maxSec>
//   node recorder.cjs probe  <app-dir> <wss-url> <room>
//
// Credentials: a JSON object {"apiKey":"...","apiSecret":"..."} is read from STDIN (never
// argv/env, never written anywhere). The access token is minted locally, is subscribe-only
// (canPublish=false, canPublishData=false), hidden from other participants, and short-lived.
//
// record: joins the room, subscribes to the published audio track (the app publishes as
//   identity "publisher-app") and writes 16 kHz mono s16le WAV. The file follows the WALL
//   CLOCK from the moment "READY <epochMs>" is printed: gaps with no frames are filled with
//   silence, so sample 0 = READY time. Stops on SIGINT/SIGTERM or after maxSec.
// probe: lists the room's participants and their tracks as JSON (no secrets).
//
// The LiveKit SDKs are loaded from app/node_modules (same versions as the app; no new deps).
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

const [cmd, appDir, wssUrl, roomName, outFile, maxSecArg] = process.argv.slice(2);
if (!cmd || !appDir || !wssUrl || !roomName || (cmd === "record" && !outFile)) {
  console.error("usage: recorder.cjs record <app-dir> <wss-url> <room> <out.wav> <maxSec> | probe <app-dir> <wss-url> <room>");
  process.exit(2);
}
const appRequire = createRequire(path.join(path.resolve(appDir), "package.json"));

const SR = 16000;
const PUBLISHER = "publisher-app";

function readStdin() {
  return new Promise((resolve, reject) => {
    const parts = [];
    process.stdin.on("data", (d) => parts.push(d));
    process.stdin.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

async function credentials() {
  const raw = await readStdin();
  let c;
  try {
    c = JSON.parse(raw);
  } catch {
    throw new Error("credentials on stdin are not valid JSON");
  }
  if (!c || typeof c.apiKey !== "string" || typeof c.apiSecret !== "string" || !c.apiKey || !c.apiSecret) {
    throw new Error("credentials on stdin must contain apiKey and apiSecret");
  }
  return c;
}

// ---------------------------------------------------------------- probe
async function probe() {
  const { RoomServiceClient } = appRequire("livekit-server-sdk");
  const { apiKey, apiSecret } = await credentials();
  const httpUrl = wssUrl.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
  const svc = new RoomServiceClient(httpUrl, apiKey, apiSecret);
  let rooms;
  try {
    rooms = await svc.listRooms([roomName]);
  } catch (err) {
    console.log(JSON.stringify({ ok: false, error: `listRooms failed: ${err && err.message}` }));
    return;
  }
  if (!rooms.length) {
    console.log(JSON.stringify({ ok: true, roomExists: false, participants: [] }));
    return;
  }
  const ps = await svc.listParticipants(roomName);
  console.log(
    JSON.stringify({
      ok: true,
      roomExists: true,
      participants: ps.map((p) => ({
        identity: p.identity,
        tracks: (p.tracks || []).map((t) => ({ type: t.type, muted: !!t.muted, name: t.name })),
      })),
    }),
  );
}

// ---------------------------------------------------------------- record
class WavWriter {
  constructor(file) {
    this.fd = fs.openSync(file, "w");
    this.samples = 0;
    fs.writeSync(this.fd, Buffer.alloc(44)); // header patched in close()
  }
  write(int16) {
    const b = Buffer.from(int16.buffer, int16.byteOffset, int16.length * 2);
    fs.writeSync(this.fd, b);
    this.samples += int16.length;
  }
  silence(n) {
    const chunk = 16000;
    while (n > 0) {
      const k = Math.min(n, chunk);
      this.write(new Int16Array(k));
      n -= k;
    }
  }
  close() {
    const dataBytes = this.samples * 2;
    const h = Buffer.alloc(44);
    h.write("RIFF", 0);
    h.writeUInt32LE(36 + dataBytes, 4);
    h.write("WAVE", 8);
    h.write("fmt ", 12);
    h.writeUInt32LE(16, 16);
    h.writeUInt16LE(1, 20); // PCM
    h.writeUInt16LE(1, 22); // mono
    h.writeUInt32LE(SR, 24);
    h.writeUInt32LE(SR * 2, 28);
    h.writeUInt16LE(2, 32);
    h.writeUInt16LE(16, 34);
    h.write("data", 36);
    h.writeUInt32LE(dataBytes, 40);
    fs.writeSync(this.fd, h, 0, 44, 0);
    fs.closeSync(this.fd);
  }
}

async function record() {
  const rtc = appRequire("@livekit/rtc-node");
  const { AccessToken } = appRequire("livekit-server-sdk");
  const { Room, RoomEvent, AudioStream, TrackKind, dispose } = rtc;
  const { apiKey, apiSecret } = await credentials();
  const maxSec = Math.max(10, Number(maxSecArg || 3600));

  const at = new AccessToken(apiKey, apiSecret, {
    identity: `e2e-recorder-${Date.now()}`,
    ttl: "10m", // join window only; short-lived
  });
  at.addGrant({
    roomJoin: true,
    room: roomName,
    canSubscribe: true,
    canPublish: false,
    canPublishData: false,
    canUpdateOwnMetadata: false,
    hidden: true,
  });
  const token = await at.toJwt();

  const wav = new WavWriter(outFile);
  let recStart = 0;
  let frames = 0;
  let loudFrames = 0;
  let stopping = false;
  const readers = new Set();

  // Keep the file on the wall clock: pad with silence when no frames arrived for a while.
  const padTo = (extraSamples) => {
    const expected = Math.floor(((Date.now() - recStart) * SR) / 1000);
    const gap = expected - extraSamples - wav.samples;
    if (gap > SR * 0.3) wav.silence(gap);
  };

  const readTrack = async (track, who) => {
    console.log(`TRACK ${who} ${Date.now()}`);
    const stream = new AudioStream(track, { sampleRate: SR, numChannels: 1 });
    readers.add(stream);
    try {
      for await (const frame of stream) {
        if (stopping) break;
        if (!recStart) continue;
        padTo(frame.samplesPerChannel);
        wav.write(frame.data);
        frames++;
        let peak = 0;
        for (let i = 0; i < frame.data.length; i++) {
          const v = Math.abs(frame.data[i]);
          if (v > peak) peak = v;
        }
        if (peak > 300) loudFrames++;
      }
    } catch (err) {
      if (!stopping) console.error(`recorder: audio stream error: ${err && err.message}`);
    } finally {
      readers.delete(stream);
    }
  };

  const room = new Room();
  let active = null; // one track at a time (the app publishes exactly one)
  room.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
    if (track.kind !== TrackKind.KIND_AUDIO) return;
    if (active && participant.identity !== PUBLISHER) return;
    active = track;
    void readTrack(track, participant.identity);
  });
  room.on(RoomEvent.TrackUnsubscribed, (_track, _pub, participant) => {
    console.log(`UNTRACK ${participant.identity} ${Date.now()}`);
    active = null;
  });
  room.on(RoomEvent.Disconnected, (reason) => {
    if (!stopping) console.error(`recorder: disconnected from room (reason=${reason})`);
  });

  await room.connect(wssUrl, token, { autoSubscribe: true, dynacast: false });
  recStart = Date.now();
  console.log(`READY ${recStart}`);

  const finish = async (why) => {
    if (stopping) return;
    stopping = true;
    padTo(0);
    const durSec = wav.samples / SR;
    wav.close();
    for (const s of readers) {
      try {
        await s.cancel();
      } catch {
        /* ignore */
      }
    }
    try {
      await room.disconnect();
    } catch {
      /* ignore */
    }
    try {
      await dispose();
    } catch {
      /* ignore */
    }
    console.log(`DONE reason=${why} seconds=${durSec.toFixed(2)} frames=${frames} loudFrames=${loudFrames}`);
    process.exit(0);
  };
  process.on("SIGINT", () => void finish("SIGINT"));
  process.on("SIGTERM", () => void finish("SIGTERM"));
  setTimeout(() => void finish("maxSec"), maxSec * 1000);
}

(cmd === "probe" ? probe() : cmd === "record" ? record() : Promise.reject(new Error(`unknown command ${cmd}`))).catch(
  (err) => {
    // Error messages from the SDKs never include the API secret; the token is not printed.
    console.error(`recorder error: ${err && err.message}`);
    process.exit(1);
  },
);
