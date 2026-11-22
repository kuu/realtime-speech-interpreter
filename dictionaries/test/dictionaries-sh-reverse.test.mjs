// cdk/scripts/dictionaries.sh: the Japanese vocabulary and the one multi-directional terminology (node:test).
// --dry-run makes no call; the real run is exercised against a stub `aws` that records its arguments. Nothing is uploaded.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FIX, REPO, build, cleanup, tmp } from "./helpers.mjs";
const SCRIPT = join(REPO, "cdk", "scripts", "dictionaries.sh");

function stub(script) {
  const bin = tmp("stub-aws-");
  const log = join(bin, "calls.log");
  writeFileSync(join(bin, "aws"), `#!/bin/sh\necho "$@" >> "${log}"\n${script}\n`);
  chmodSync(join(bin, "aws"), 0o755);
  return { bin, log };
}
function run(args, env = {}, script = "exit 1") {
  const { bin, log } = stub(script);
  const r = spawnSync("bash", [SCRIPT, ...args], { encoding: "utf8", input: "", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DICTIONARY_DIR: "", DICT_DIR: "", ...env } });
  const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
  cleanup(bin);
  return { status: r.status, out: r.stdout + r.stderr, called: calls.length > 0, calls };
}
// A stub that answers everything the script asks for. STUB_DIRECTIONALITY: MULTI | UNI | None | missing | error.
const FULL_STUB = `
case "$1 $2" in
  "sts get-caller-identity") echo 123456789012 ;;
  "s3api head-bucket"|"s3api put-public-access-block"|"s3 cp") ;;
  "transcribe get-vocabulary") echo READY ;;
  "transcribe update-vocabulary"|"transcribe create-vocabulary") ;;
  "translate get-terminology")
    case "$STUB_DIRECTIONALITY" in
      missing) echo "An error occurred (ResourceNotFoundException) when calling the GetTerminology operation: nope" >&2; exit 254 ;;
      error) echo "An error occurred (AccessDeniedException) when calling the GetTerminology operation" >&2; exit 254 ;;
      *) echo "$STUB_DIRECTIONALITY" ;;
    esac ;;
  "translate import-terminology"|"translate delete-terminology") ;;
  *) echo "stub aws: unexpected call: $*" >&2; exit 1 ;;
esac
`;
function exampleDir() {
  const d = tmp();
  for (const f of ["terms.csv", "transcribe-vocabulary.txt", "translate-terminology.csv", "polly-readings.csv", "transcribe-vocabulary-ja.txt"]) {
    copyFileSync(join(REPO, "dictionaries", "example", f), join(d, f));
  }
  return d;
}
const real = (d, extra = [], env = {}) => run(["--dir", d, ...extra], { AWS_REGION: "ap-northeast-1", ...env }, FULL_STUB);

test("--dry-run lists the Japanese vocabulary upload and the one MULTI import, and makes no AWS call", () => {
  const d = tmp();
  try {
    copyFileSync(join(FIX, "reverse", "terms.csv"), join(d, "terms.csv"));
    assert.equal(build(["generate", "--dir", d]).status, 0);
    const r = run(["--dry-run", "--dir", d]);
    assert.equal(r.status, 0, r.out);
    assert.equal(r.called, false);
    assert.match(r.out, /vocab\/transcribe-vocabulary-ja\.txt/);
    assert.match(r.out, /--vocabulary-name simul-translation-ja --language-code ja-JP/);
    assert.match(r.out, /import-terminology --name simul-translation --merge-strategy OVERWRITE --terminology-data Format=CSV,Directionality=MULTI/);
    assert.match(r.out, /get-terminology --name simul-translation reads the directionality: .*UNI -> ask, delete-terminology, import again as MULTI/);
    assert.match(r.out, /transcribe-vocabulary-ja\.txt  [0-9a-f]{64}  \d+ bytes  3 entries/);
    assert.doesNotMatch(r.out, /-ja-en|ja-en\.csv/, "no second terminology");
    const named = run(["--dry-run", "--dir", d], { DICT_NAME_JA: "custom-ja" });
    assert.match(named.out, /--vocabulary-name custom-ja --language-code ja-JP/);
  } finally {
    cleanup(d);
  }
});

test("--dry-run of the example dictionary lists the derived Japanese vocabulary and no second terminology", () => {
  const r = run(["--dry-run", "--dir", join(REPO, "dictionaries", "example")]);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /transcribe-vocabulary-ja\.txt  [0-9a-f]{64}/);
  assert.doesNotMatch(r.out, /-ja-en|ja-en\.csv/);
});

test("real run, terminology missing: one import with Directionality=MULTI, the exact arguments", () => {
  const d = exampleDir();
  try {
    const r = real(d, [], { STUB_DIRECTIONALITY: "missing" });
    assert.equal(r.status, 0, r.out);
    const imp = r.calls.filter((c) => c.startsWith("translate import-terminology"));
    assert.equal(imp.length, 1, "one terminology, one import");
    assert.match(imp[0], /^translate import-terminology --name simul-translation --merge-strategy OVERWRITE --terminology-data Format=CSV,Directionality=MULTI --data-file fileb:\/\/.*translate-terminology\.csv --region ap-northeast-1$/);
    assert.equal(r.calls.some((c) => c.startsWith("translate delete-terminology")), false);
    assert.match(r.calls.find((c) => c.startsWith("translate get-terminology")), /--name simul-translation --terminology-data-format CSV --query TerminologyProperties\.Directionality/);
    assert.ok(r.calls.some((c) => /transcribe (create|update)-vocabulary --vocabulary-name simul-translation-ja --language-code ja-JP/.test(c)));
    assert.match(r.out, /transcribeVocabulary=simul-translation-ja is optional/);
  } finally {
    cleanup(d);
  }
});

test("real run, already MULTI: imported over with OVERWRITE, nothing deleted", () => {
  const d = exampleDir();
  try {
    const r = real(d, [], { STUB_DIRECTIONALITY: "MULTI" });
    assert.equal(r.status, 0, r.out);
    assert.equal(r.calls.filter((c) => c.startsWith("translate import-terminology")).length, 1);
    assert.equal(r.calls.some((c) => c.startsWith("translate delete-terminology")), false);
  } finally {
    cleanup(d);
  }
});

test("real run, existing UNI terminology: refused without a terminal and without --yes (no delete, no import)", () => {
  const d = exampleDir();
  try {
    for (const dir of ["UNI", "None"]) {
      const r = real(d, [], { STUB_DIRECTIONALITY: dir });
      assert.notEqual(r.status, 0, r.out);
      assert.match(r.out, /uni-directional/);
      assert.match(r.out, /Run again with --yes/);
      assert.equal(r.calls.some((c) => /^translate (delete|import)-terminology/.test(c)), false, r.calls.join("\n"));
    }
  } finally {
    cleanup(d);
  }
});

test("real run, existing UNI terminology with --yes: deleted first, then imported as MULTI", () => {
  const d = exampleDir();
  try {
    const r = real(d, ["--yes"], { STUB_DIRECTIONALITY: "UNI" });
    assert.equal(r.status, 0, r.out);
    const verbs = r.calls.filter((c) => /^translate (get|delete|import)-terminology/.test(c)).map((c) => c.split(" ")[1]);
    assert.deepEqual(verbs, ["get-terminology", "delete-terminology", "import-terminology"]);
    assert.match(r.calls.find((c) => c.startsWith("translate delete-terminology")), /^translate delete-terminology --name simul-translation --region ap-northeast-1$/);
    assert.match(r.calls.find((c) => c.startsWith("translate import-terminology")), /Format=CSV,Directionality=MULTI/);
  } finally {
    cleanup(d);
  }
});

test("real run: an error other than 'not found' while reading the directionality stops before any write", () => {
  const d = exampleDir();
  try {
    const r = real(d, ["--yes"], { STUB_DIRECTIONALITY: "error" });
    assert.notEqual(r.status, 0);
    assert.match(r.out, /cannot read the Translate terminology simul-translation/);
    assert.equal(r.calls.some((c) => /^translate (delete|import)-terminology/.test(c)), false);
  } finally {
    cleanup(d);
  }
});

test("the script has no second terminology and no ja-en names left", () => {
  const src = readFileSync(SCRIPT, "utf8");
  assert.doesNotMatch(src, /JA_EN|ja-en|translate-terminology-ja-en/);
  assert.match(src, /sync_vocabulary "\$DICT_NAME_JA" ja-JP "\$VOCAB_JA_FILE" transcribe-vocabulary-ja\.txt/);
  assert.match(src, /Format=CSV,Directionality=MULTI/);
});
