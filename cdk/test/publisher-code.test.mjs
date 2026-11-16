import { test } from "node:test";
import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../scripts/publisher-code.mjs", import.meta.url));
const ALPHABET = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{12}$/;
const FUTURE = "2099-01-01T00:00:00Z";

/** A stub `aws` first on PATH: records argv and stdin of every call to a log; answers canned stack outputs. */
function setup({ livekitUrl = "wss://livekit.example.invalid", failPut = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pubcode-"));
  const log = join(dir, "calls.jsonl");
  const outputs = [
    ["PublisherCodeSecretArn", "arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:code-abc"],
    ["PublisherNotAfterParameter", "/simul-translation/publisher-not-after"],
    ["PublisherUrl", "https://d111.example.invalid/publish"],
    ["PublisherIngestRoom", "translation-ingest"],
    ["LiveKitUrl", livekitUrl],
    ["LiveKitApiSecretArn", "arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:lk-abc"],
  ].map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue }));
  const bin = join(dir, "bin");
  writeFileSync(join(dir, "stub.cjs"), `
const fs = require("fs");
const args = process.argv.slice(2);
let stdin = "";
try { stdin = fs.readFileSync(0, "utf8"); } catch {}
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, stdin }) + "\\n");
const [svc, op] = args;
if (svc === "cloudformation" && op === "describe-stacks") process.stdout.write(${JSON.stringify(JSON.stringify(outputs))});
else if (svc === "secretsmanager" && op === "get-secret-value") process.stdout.write(JSON.stringify({ apiKey: "devkey", apiSecret: "s".repeat(32) }));
else if (svc === "secretsmanager" && op === "put-secret-value" && ${failPut}) { process.stderr.write("AccessDenied\\n"); process.exit(254); }
`);
  require_mkdir(bin);
  writeFileSync(join(bin, "aws"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(dir, "stub.cjs"))} "$@"\n`);
  chmodSync(join(bin, "aws"), 0o755);
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, AWS_REGION: "ap-northeast-1" } });
  return { dir, calls, run, done: () => rmSync(dir, { recursive: true, force: true }) };
}
import { mkdirSync } from "node:fs";
function require_mkdir(p) { mkdirSync(p, { recursive: true }); }
const codeFrom = (stdout) => stdout.match(/event code:\s+([A-Z0-9-]+)/)[1].replace(/-/g, "");

test("--dry-run makes no aws call and prints placeholders", () => {
  const s = setup();
  try {
    const r = s.run(["--ends-at", FUTURE, "--dry-run", "--disconnect"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(s.calls().length, 0);
    assert.match(r.stdout, /<site>/);
    assert.match(r.stdout, /<code not generated in dry run>/);
  } finally { s.done(); }
});

test("--ends-at: rejected forms exit 2 and make no aws call", () => {
  const s = setup();
  try {
    for (const v of ["2099-01-01T09:00:00+09:00", "2099-01-01T00:00:00", "2099-01-01T00:00:00z", "2099-01-01", "2099-01-01T00:00:00.000Z", "garbage", "2020-01-01T00:00:00Z", "2099-02-30T00:00:00Z"]) {
      const r = s.run(["--ends-at", v]);
      assert.equal(r.status, 2, v);
      assert.match(r.stderr, /YYYY-MM-DDTHH:MM:SSZ/);
    }
    assert.equal(s.run([]).status, 2);
    assert.equal(s.run(["--ends-at", FUTURE, "--bogus"]).status, 2);
    assert.equal(s.calls().length, 0);
  } finally { s.done(); }
});

test("real run: code in stdin only, end time written, URL and code printed, nothing leaks", () => {
  const s = setup();
  try {
    const r = s.run(["--ends-at", FUTURE]);
    assert.equal(r.status, 0, r.stderr);
    const code = codeFrom(r.stdout);
    assert.match(code, ALPHABET);
    assert.match(r.stdout, /https:\/\/d111\.example\.invalid\/publish/);
    assert.match(r.stdout, /event code:\s+[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}/);
    const calls = s.calls();
    const put = calls.find((c) => c.args[1] === "put-secret-value");
    assert.equal(JSON.parse(put.stdin).code, code);
    assert.ok(put.args.includes("file:///dev/stdin"));
    const param = calls.find((c) => c.args[1] === "put-parameter");
    assert.equal(param.args[param.args.indexOf("--value") + 1], FUTURE);
    assert.ok(param.args.includes("--overwrite"));
    for (const c of calls) assert.ok(!JSON.stringify(c.args).includes(code), "code in argv");
    assert.ok(!r.stderr.includes(code));
    for (const f of readdirSync(s.dir, { recursive: true })) {
      const p = join(s.dir, f);
      if (/calls\.jsonl$/.test(f)) continue; // the stub's own call log holds stdin by design
      try { assert.ok(!readFileSync(p, "utf8").includes(code), `code in file ${f}`); } catch (e) { if (e.code !== "EISDIR") throw e; }
    }
  } finally { s.done(); }
});

test("two runs give two different codes (rotation)", () => {
  const s = setup();
  try {
    const a = codeFrom(s.run(["--ends-at", FUTURE]).stdout);
    const b = codeFrom(s.run(["--ends-at", FUTURE]).stdout);
    assert.notEqual(a, b);
  } finally { s.done(); }
});

test("a storage failure exits 1 and prints no code", () => {
  const s = setup({ failPut: true });
  try {
    const r = s.run(["--ends-at", FUTURE]);
    assert.equal(r.status, 1);
    assert.ok(!/event code/.test(r.stdout));
  } finally { s.done(); }
});

function liveKitServer(respond) {
  return new Promise((resolve) => {
    const seen = [];
    const srv = createServer((req, res) => {
      let b = "";
      req.on("data", (d) => (b += d));
      req.on("end", () => { seen.push({ url: req.url, auth: req.headers.authorization, body: b }); const [st, out] = respond(); res.writeHead(st); res.end(out); });
    });
    srv.listen(0, "127.0.0.1", () => resolve({ srv, seen, port: srv.address().port }));
  });
}
const claims = (auth) => JSON.parse(Buffer.from(auth.replace("Bearer ", "").split(".")[1], "base64url").toString());

test("--disconnect sends RemoveParticipant with a roomAdmin token to the ingest room", async () => {
  const { srv, seen, port } = await liveKitServer(() => [200, "{}"]);
  const s = setup({ livekitUrl: `ws://127.0.0.1:${port}` });
  try {
    const r = await new Promise((res) => {
      const { spawn } = require_child();
      const p = spawn(process.execPath, [SCRIPT, "--ends-at", FUTURE, "--disconnect"], { env: { ...process.env, PATH: `${join(s.dir, "bin")}:${process.env.PATH}`, AWS_REGION: "ap-northeast-1" } });
      let out = "", err = "";
      p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
      p.on("close", (code) => res({ status: code, stdout: out, stderr: err }));
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, "/twirp/livekit.RoomService/RemoveParticipant");
    assert.deepEqual(JSON.parse(seen[0].body), { room: "translation-ingest", identity: "browser-publisher" });
    const c = claims(seen[0].auth);
    assert.equal(c.video.roomAdmin, true);
    assert.equal(c.video.room, "translation-ingest");
    assert.equal(c.iss, "devkey");
  } finally { srv.close(); s.done(); }
});

test("--disconnect failure exits 1 but still prints the new code", async () => {
  const { srv, port } = await liveKitServer(() => [500, "boom"]);
  const s = setup({ livekitUrl: `ws://127.0.0.1:${port}` });
  try {
    const r = await new Promise((res) => {
      const p = require_child().spawn(process.execPath, [SCRIPT, "--ends-at", FUTURE, "--disconnect"], { env: { ...process.env, PATH: `${join(s.dir, "bin")}:${process.env.PATH}`, AWS_REGION: "ap-northeast-1" } });
      let out = "", err = "";
      p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
      p.on("close", (code) => res({ status: code, stdout: out, stderr: err }));
    });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /event code:/);
    assert.match(r.stderr, /could not remove/);
    assert.ok(!r.stderr.includes(codeFrom(r.stdout)));
  } finally { srv.close(); s.done(); }
});

test("--disconnect with a participant that is not found counts as success", async () => {
  const { srv, port } = await liveKitServer(() => [404, '{"code":"not_found"}']);
  const s = setup({ livekitUrl: `ws://127.0.0.1:${port}` });
  try {
    const r = await new Promise((res) => {
      const p = require_child().spawn(process.execPath, [SCRIPT, "--ends-at", FUTURE, "--disconnect"], { env: { ...process.env, PATH: `${join(s.dir, "bin")}:${process.env.PATH}`, AWS_REGION: "ap-northeast-1" } });
      let out = "";
      p.stdout.on("data", (d) => (out += d));
      p.on("close", (code) => res({ status: code, stdout: out }));
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /none connected/);
  } finally { srv.close(); s.done(); }
});
import * as cp from "node:child_process";
function require_child() { return cp; }
void appendFileSync;
