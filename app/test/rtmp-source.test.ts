// RTMP source: ffmpeg arguments, key redaction, key gate, and loopback runs (node:test). Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { rtmpListenerArgs, buildRtmpUrl, redact, assertRtmpConfig, KeyGate } from "../src/rtmp-source.js";
import { listenerArgs } from "../src/srt-source.js";

const KEY = "AbCd1234AbCd1234AbCd1234AbCd1234";
const RURL = buildRtmpUrl("0.0.0.0", 1935, KEY);
const ROOT = new URL("..", import.meta.url).pathname;

test("url carries the key in the path", () => {
  assert.equal(RURL, `rtmp://0.0.0.0:1935/live/${KEY}`);
});

test("args: -listen 1 and -analyzeduration before -i, decode part identical to SRT", () => {
  const a = rtmpListenerArgs(RURL, 500, 1, 16000);
  const i = a.indexOf("-i");
  assert.deepEqual(a.slice(i - 4, i), ["-analyzeduration", "500000", "-listen", "1"]);
  assert.equal(a[i + 1], RURL);
  assert.deepEqual(a.slice(i + 2), listenerArgs("x", 0, 1, 16000).slice(listenerArgs("x", 0, 1, 16000).indexOf("-i") + 2));
  assert.deepEqual(a.slice(a.indexOf("-loglevel"), a.indexOf("-loglevel") + 2), ["-loglevel", "info"]);
  assert.ok(!a.includes("-fflags") && !a.includes("-flags"), "no extra buffering flags");
});

test("analyzeMs 0 omits -analyzeduration", () => {
  assert.ok(!rtmpListenerArgs(RURL, 0, 1, 16000).includes("-analyzeduration"));
});

test("redact removes the key from urls and ffmpeg lines", () => {
  assert.ok(!redact(`Input #0, from '${RURL}'`, KEY).includes(KEY));
  assert.equal(redact(RURL, KEY), "rtmp://0.0.0.0:1935/live/***");
  assert.equal(redact("nothing", ""), "nothing");
});

test("a missing or malformed key refuses to start", () => {
  assert.throws(() => assertRtmpConfig(""), /RTMP_STREAM_KEY/);
  assert.throws(() => assertRtmpConfig("short"), /16-128/);
  assert.throws(() => assertRtmpConfig("has/slash/in/it/0123456789"), /16-128/);
  assert.doesNotThrow(() => assertRtmpConfig(KEY));
});

test("gate: PCM before the Input line is held, then flushed in order", () => {
  const out: string[] = [];
  const g = new KeyGate((c) => out.push(c.toString()), () => assert.fail("no reject"), 1000);
  g.stdout(Buffer.from("a"));
  g.stdout(Buffer.from("b"));
  assert.deepEqual(out, []);
  g.stderr("Input #0, flv, from 'x':\n");
  assert.deepEqual(out, ["a", "b"]);
  g.stdout(Buffer.from("c"));
  assert.deepEqual(out, ["a", "b", "c"]);
  g.dispose();
});

test("gate: a mismatch line before the Input line rejects and discards the held PCM", () => {
  const out: string[] = [];
  let rejected = 0;
  const g = new KeyGate((c) => out.push(c.toString()), () => rejected++, 1000);
  g.stdout(Buffer.from("a"));
  g.stderr("[rtmp @ 0x1] Unexpected stream WRONG, expecting KEY\n");
  g.stderr("Input #0, flv, from 'x':\n");
  g.stdout(Buffer.from("b"));
  assert.deepEqual(out, []);
  assert.equal(rejected, 1);
  assert.equal(g.status, "rejected");
});

test("gate: a wrong app name rejects too", () => {
  let rejected = 0;
  const g = new KeyGate(() => {}, () => rejected++, 1000);
  g.stderr("[rtmp @ 0x1] App field don't match up: other <-> live\n");
  assert.equal(rejected, 1);
});

test("gate fails closed: PCM with no Input line within the bound is rejected", async () => {
  const out: string[] = [];
  let rejected = 0;
  const g = new KeyGate((c) => out.push(c.toString()), () => rejected++, 50);
  g.stdout(Buffer.from("a"));
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(rejected, 1);
  assert.deepEqual(out, []);
});

// Runs startRtmpListener against the fake ffmpeg, which prints PCM on stdout BEFORE its stderr lines.
function runFake(mode: string, runMs = 1200): { bytes: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ["--import", "tsx", "test/fixtures/rtmp-run.ts"], {
    cwd: ROOT, encoding: "utf8",
    env: { ...process.env, FFMPEG_PATH: `${ROOT}test/fixtures/fake-ffmpeg.sh`, FAKE_MODE: mode, RTMP_STREAM_KEY: KEY, RTMP_HOST: "127.0.0.1", RUN_MS: String(runMs), LOG_LEVEL: "debug" },
  });
  const m = /BYTES (\d+)/.exec(r.stdout);
  return { bytes: m ? Number(m[1]) : -1, stdout: r.stdout, stderr: r.stderr };
}

test("fake ffmpeg with stdout before stderr: right key passes everything", () => {
  const r = runFake("ok");
  assert.equal(r.bytes, "PCMPCMPCMPCM".length + "MOREMOREMORE".length);
});

test("fake ffmpeg with stdout before stderr: wrong key forwards nothing, logs the rejection, not the name or key", () => {
  const r = runFake("wrong");
  assert.equal(r.bytes, 0);
  assert.match(r.stdout + r.stderr, /\[rtmp\] rejected publish with a wrong key/);
  assert.match(r.stdout, /ENDED 1/);
  assert.ok(!(r.stdout + r.stderr).includes("SECRETNAME"));
  assert.ok(!(r.stdout + r.stderr).includes(KEY));
});

test("fake ffmpeg that never says Input: fail closed", () => {
  const r = runFake("silent", 2600); // GATE_MS is 2000
  assert.equal(r.bytes, 0);
  assert.match(r.stdout + r.stderr, /rejected publish/);
});

// ---- real ffmpeg on loopback -------------------------------------------------------------------
const HAS_FFMPEG = spawnSync("ffmpeg", ["-hide_banner", "-protocols"], { encoding: "utf8" }).stdout?.includes("rtmp") ?? false;
const PORT = 19400 + (process.pid % 400);

async function realRun(path: string): Promise<{ bytes: number; out: string }> {
  const env = { ...process.env, RTMP_STREAM_KEY: KEY, RTMP_HOST: "127.0.0.1", RTMP_PORT: String(PORT), RUN_MS: "4500", LOG_LEVEL: "debug" };
  const app = spawn(process.execPath, ["--import", "tsx", "test/fixtures/rtmp-run.ts"], { cwd: ROOT, env });
  let out = "";
  app.stdout.on("data", (d) => (out += d));
  app.stderr.on("data", (d) => (out += d));
  await new Promise((r) => setTimeout(r, 1800));
  spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-re", "-f", "lavfi", "-i", "sine=frequency=440:duration=1.5", "-c:a", "aac", "-f", "flv", `rtmp://127.0.0.1:${PORT}/${path}`], { timeout: 8000 });
  await new Promise((r) => app.on("close", r));
  const m = /BYTES (\d+)/.exec(out);
  return { bytes: m ? Number(m[1]) : -1, out };
}

test("real ffmpeg: right key passes audio; wrong key and wrong app are rejected", { skip: !HAS_FFMPEG && "ffmpeg without rtmp" }, async () => {
  const ok = await realRun(`live/${KEY}`);
  assert.ok(ok.bytes > 20000, `expected PCM, got ${ok.bytes}`);
  assert.ok(!ok.out.includes(KEY));
  const wrongKey = await realRun("live/WRONGKEYWRONGKEYWRONGKEY");
  assert.equal(wrongKey.bytes, 0);
  assert.match(wrongKey.out, /rejected publish/);
  const wrongApp = await realRun(`other/${KEY}`);
  assert.equal(wrongApp.bytes, 0);
  assert.match(wrongApp.out, /rejected publish/);
});
