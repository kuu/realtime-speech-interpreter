// Guards the key check against ffmpeg upgrades: the gate depends on ffmpeg's log text. Runs the ffmpeg of
// a built app image (the Debian ffmpeg of app/Dockerfile). Opt-in: RTMP_IMAGE=<image tag> npm test.
// Build the image first: docker build -t simul-app:test app. The container port is published on 127.0.0.1 only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";

const IMAGE = process.env.RTMP_IMAGE;
const KEY = "AbCd1234AbCd1234AbCd1234AbCd1234";
const PORT = 19800;

async function run(path: string): Promise<string> {
  const name = `rtmp-img-test-${process.pid}`;
  const c = spawn("docker", ["run", "--rm", "--name", name, "-p", `127.0.0.1:${PORT}:1935`, "--entrypoint", "ffmpeg", IMAGE!,
    "-hide_banner", "-loglevel", "info", "-listen", "1", "-i", `rtmp://0.0.0.0:1935/live/${KEY}`, "-vn", "-f", "null", "-"]);
  let err = "";
  c.stderr.on("data", (d) => (err += d));
  await new Promise((r) => setTimeout(r, 3000));
  spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-re", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", "aac", "-f", "flv", `rtmp://127.0.0.1:${PORT}/${path}`], { timeout: 8000 });
  await new Promise((r) => setTimeout(r, 800));
  spawnSync("docker", ["rm", "-f", name]);
  return err;
}

test("image ffmpeg: right key opens the input without a mismatch line", { skip: !IMAGE && "set RTMP_IMAGE" }, async () => {
  const err = await run(`live/${KEY}`);
  assert.match(err, /^Input #0/m);
  assert.doesNotMatch(err, /Unexpected stream|App field don't match/);
});

test("image ffmpeg: wrong key prints the mismatch line before Input #0", { skip: !IMAGE && "set RTMP_IMAGE" }, async () => {
  const err = await run("live/WRONGKEYWRONGKEYWRONGKEY");
  assert.match(err, /Unexpected stream/);
  assert.ok(err.indexOf("Unexpected stream") < err.indexOf("Input #0"));
});

test("image ffmpeg: wrong app prints the mismatch line before Input #0", { skip: !IMAGE && "set RTMP_IMAGE" }, async () => {
  const err = await run(`other/${KEY}`);
  assert.match(err, /App field don't match/);
  assert.ok(err.indexOf("App field") < err.indexOf("Input #0"));
});
