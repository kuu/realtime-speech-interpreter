// cdk/scripts/dictionaries.sh with the reverse-direction files: --dry-run only, stubbed aws, nothing uploaded (node:test).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FIX, REPO, build, cleanup, tmp } from "./helpers.mjs";

const SCRIPT = join(REPO, "cdk", "scripts", "dictionaries.sh");
function run(args, env = {}) {
  const bin = tmp("stub-aws-");
  const log = join(bin, "calls.log");
  writeFileSync(join(bin, "aws"), `#!/bin/sh\necho "$@" >> "${log}"\nexit 1\n`);
  chmodSync(join(bin, "aws"), 0o755);
  const r = spawnSync("bash", [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DICTIONARY_DIR: "", DICT_DIR: "", ...env } });
  const called = existsSync(log);
  cleanup(bin);
  return { status: r.status, out: r.stdout + r.stderr, called };
}
test("--dry-run lists the two reverse uploads when the files exist, and still makes no AWS call", () => {
  const d = tmp();
  try {
    copyFileSync(join(FIX, "reverse", "terms.csv"), join(d, "terms.csv"));
    assert.equal(build(["generate", "--dir", d]).status, 0);
    const r = run(["--dry-run", "--dir", d]);
    assert.equal(r.status, 0, r.out);
    assert.equal(r.called, false);
    assert.match(r.out, /vocab\/transcribe-vocabulary-ja\.txt/);
    assert.match(r.out, /--vocabulary-name simul-translation-ja --language-code ja-JP/);
    assert.match(r.out, /import-terminology --name simul-translation-ja-en --merge-strategy OVERWRITE --terminology-data Format=CSV/);
    assert.match(r.out, /transcribe-vocabulary-ja\.txt  [0-9a-f]{64}  \d+ bytes  3 entries/);
    assert.match(r.out, /translate-terminology-ja-en\.csv  [0-9a-f]{64}  \d+ bytes/);
    const named = run(["--dry-run", "--dir", d], { DICT_NAME_JA: "custom-ja", DICT_NAME_JA_EN: "custom-ja-en" });
    assert.match(named.out, /--vocabulary-name custom-ja --language-code ja-JP/);
    assert.match(named.out, /import-terminology --name custom-ja-en /);
  } finally {
    cleanup(d);
  }
});
test("--dry-run of the example dictionary prints no reverse line (output unchanged)", () => {
  const r = run(["--dry-run", "--dir", join(REPO, "dictionaries", "example")]);
  assert.equal(r.status, 0, r.out);
  assert.doesNotMatch(r.out, /ja-JP|-ja-en|ja\.txt|ja-en\.csv/);
});
test("the script uploads the reverse files only in the real run, as ja-JP and uni-directional CSV (static check of the commands)", () => {
  const src = require_text(SCRIPT);
  assert.match(src, /sync_vocabulary "\$DICT_NAME_JA" ja-JP "\$VOCAB_JA_FILE" transcribe-vocabulary-ja\.txt/);
  assert.match(src, /import-terminology --name "\$DICT_NAME_JA_EN" --merge-strategy OVERWRITE/);
  assert.doesNotMatch(src, /Directionality=MULTI/);
});
import { readFileSync } from "node:fs";
function require_text(f) {
  return readFileSync(f, "utf8");
}
