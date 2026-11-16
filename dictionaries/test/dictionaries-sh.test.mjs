import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { REPO, build, cleanup, makeDict, tmp } from "./helpers.mjs";

const SCRIPT = join(REPO, "cdk", "scripts", "dictionaries.sh");
const sha = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");

/** A stub `aws` that records every call; the test fails if it is ever called. */
function stubAws() {
  const bin = tmp("stub-aws-");
  const log = join(bin, "calls.log");
  writeFileSync(join(bin, "aws"), `#!/bin/sh\necho "$@" >> "${log}"\nexit 1\n`);
  chmodSync(join(bin, "aws"), 0o755);
  return { bin, log };
}
function run(args, env = {}) {
  const { bin, log } = stubAws();
  const r = spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DICTIONARY_DIR: "", DICT_DIR: "", ...env },
  });
  const called = existsSync(log);
  cleanup(bin);
  return { status: r.status, out: r.stdout + r.stderr, called };
}

test("--dry-run makes no AWS call and prints the sha256 of the example files", () => {
  const ex = join(REPO, "dictionaries", "example");
  const r = run(["--dry-run", "--dir", ex]);
  assert.equal(r.status, 0, r.out);
  assert.equal(r.called, false);
  assert.match(r.out, /DRY RUN: no AWS call/);
  assert.ok(r.out.includes(`transcribe-vocabulary.txt  ${sha(join(ex, "transcribe-vocabulary.txt"))}`));
  assert.ok(r.out.includes(`translate-terminology.csv  ${sha(join(ex, "translate-terminology.csv"))}`));
  assert.match(r.out, /vocab\/transcribe-vocabulary\.txt/);
  assert.match(r.out, /merge-strategy OVERWRITE/);
});

test("--dir beats DICTIONARY_DIR, which beats the DICT_DIR alias", () => {
  const a = makeDict("HLS,HLS,エイチエルエス,y,y,y,,,,,,,\n");
  const b = makeDict("SRT,SRT,エスアールティー,y,y,y,,,,,,,\n");
  const c = makeDict("DRM,DRM,ディーアールエム,y,y,y,,,,,,,\n");
  for (const d of [a, b, c]) assert.equal(build(["generate", "--dir", d]).status, 0);
  const viaFlag = run(["--dry-run", "--dir", a], { DICTIONARY_DIR: b, DICT_DIR: c });
  assert.match(viaFlag.out, new RegExp(`Using dictionaries: ${a} \\(setting\\)`));
  const viaEnv = run(["--dry-run"], { DICTIONARY_DIR: b, DICT_DIR: c });
  assert.match(viaEnv.out, new RegExp(`Using dictionaries: ${b} \\(setting\\)`));
  const viaAlias = run(["--dry-run"], { DICT_DIR: c });
  assert.match(viaAlias.out, new RegExp(`Using dictionaries: ${c} \\(setting\\)`));
  assert.ok(viaFlag.out.includes(sha(join(a, "translate-terminology.csv"))));
  assert.equal(viaFlag.called || viaEnv.called || viaAlias.called, false);
  cleanup(a, b, c);
});

test("a missing generated file stops the script before any AWS call", () => {
  const d = makeDict("HLS,HLS,エイチエルエス,y,y,y,,,,,,,\n");
  const r = run(["--dry-run", "--dir", d]);
  assert.equal(r.status, 1);
  assert.match(r.out, /missing .*transcribe-vocabulary\.txt/);
  assert.equal(r.called, false);
  cleanup(d);
});

test("a --dir that does not exist is an error", () => {
  const r = run(["--dry-run", "--dir", "/nonexistent/dict-dir"]);
  assert.notEqual(r.status, 0);
  assert.equal(r.called, false);
});
