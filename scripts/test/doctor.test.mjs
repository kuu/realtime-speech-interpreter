// scripts/doctor.sh with a stubbed `aws` (node:test). Offline, read-only: the stub records every call and the test checks
// that no write verb was used. Synthetic names and the documentation account only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const DOCTOR = join(ROOT, "scripts", "doctor.sh");
const STUB = join(HERE, "stub-aws.sh");
const EXPECTED = readFileSync(join(HERE, "fixtures", "doctor-default.expected.txt"), "utf8");

function doctor(args, env = {}) {
  const bin = mkdtempSync(join(tmpdir(), "doctor-bin-"));
  copyFileSync(STUB, join(bin, "aws"));
  const log = join(bin, "calls.log");
  const r = spawnSync("bash", [DOCTOR, "-c", "venueCidr=203.0.113.10/32", "-c", "eventFile=none", ...args], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, STUB_AWS_LOG: log, ...env },
  });
  let calls = "";
  try {
    calls = readFileSync(log, "utf8");
  } catch {
    /* no call */
  }
  rmSync(bin, { recursive: true, force: true });
  const out = (r.stdout + r.stderr).split(ROOT).join("<root>");
  const fromConfig = out.slice(out.indexOf("== Resolved configuration"));
  return { status: r.status, out, fromConfig, calls };
}
const EX = ["-c", "dictionaryDir=dictionaries/example"];
const lanes = (l2 = {}) =>
  JSON.stringify([
    { source: "en-US", target: "ja", pollyVoice: "Kazuha" },
    { source: "ja-JP", target: "en", pollyVoice: "Joanna", transcribeVocabulary: "simul-translation-ja", ...l2 },
  ]);
// Every recorded call is "<service> <verb> ..." or "--version"; the verb must be a read.
const readOnly = (calls) => calls.split("\n").filter(Boolean).every((l) => l.startsWith("--version") || /^[a-z0-9]+ (get|list|describe)-/.test(l));

test("the default deploy prints exactly today's lines (stored from the previous doctor.sh)", () => {
  const r = doctor(EX);
  assert.equal(r.status, 0, r.out);
  assert.equal(r.fromConfig, EXPECTED);
  assert.doesNotMatch(r.out, /== Channels/);
  assert.doesNotMatch(r.calls, /polly|get-terminology/);
});
test("a one-lane default deploy given as `channels` prints the same lines", () => {
  const r = doctor([...EX, "-c", `channels=${JSON.stringify([{ source: "en-US", target: "ja", pollyVoice: "Kazuha" }])}`]);
  assert.equal(r.fromConfig, EXPECTED);
});
test("--skip-aws runs only the local checks and still ends with a summary", () => {
  const r = doctor([...EX, "--skip-aws"]);
  assert.match(r.out, /WARN  AWS checks skipped \(--skip-aws\)/);
  assert.match(r.out, /Summary: \d+ pass, \d+ warn, 0 fail/);
  assert.equal(r.calls, "");
});
test("two lanes with everything in place: per-lane pass lines for vocabulary, terminology and both Polly voices; read-only calls", () => {
  const r = doctor([...EX, "-c", `channels=${lanes()}`]);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /== Channels/);
  assert.match(r.out, /PASS  lane 1: en-US to ja, voice Kazuha, engine translate, vocabulary 'simul-translation', terminology 'simul-translation'/);
  assert.match(r.out, /PASS  lane 2: ja-JP to en, voice Joanna, engine translate, vocabulary 'simul-translation-ja', terminology 'simul-translation'/);
  assert.match(r.out, /PASS  lane 2: Transcribe vocabulary 'simul-translation-ja' is READY \(ja-JP\)/);
  assert.match(r.out, /PASS  lane 2: Translate terminology 'simul-translation' is multi-directional \(usable for ja to en\)/);
  assert.match(r.out, /PASS  lane 2: Polly voice Joanna exists for en-US with the neural engine in ap-northeast-1/);
  assert.match(r.out, /PASS  lane 1: Polly voice Kazuha exists for ja-JP/);
  assert.match(r.out, /Summary: \d+ pass, \d+ warn, 0 fail/);
  assert.match(r.calls, /polly describe-voices --engine neural --language-code en-US/);
  assert.match(r.calls, /translate get-terminology --name simul-translation /);
  assert.ok(readOnly(r.calls), `a write call was recorded:\n${r.calls}`);
});
test("two lanes: wrong vocabulary language, wrong terminology direction, missing Polly voice are failures with a fix", () => {
  const r = doctor([...EX, "-c", `channels=${lanes()}`], { STUB_VOCAB_JA: "READY en-US", STUB_TERM: "en ja UNI", STUB_POLLY_EN: "" });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /FAIL  lane 2: Transcribe vocabulary 'simul-translation-ja' has language en-US, the lane's source is ja-JP/);
  assert.match(r.out, /FAIL  lane 2: Translate terminology 'simul-translation' is uni-directional en to ja, the lane needs ja to en/);
  assert.match(r.out, /FAIL  lane 2: Polly voice 'Joanna' not found for en-US with the neural engine/);
  assert.match(r.out, /fix: .*describe-voices/);
});
test("two lanes: a vocabulary or terminology that does not exist fails; a multi-directional terminology passes", () => {
  const r = doctor([...EX, "-c", `channels=${lanes({ transcribeVocabulary: "missing-vocab", translateTerminology: "missing-term" })}`]);
  assert.match(r.out, /FAIL  lane 2: Transcribe vocabulary 'missing-vocab' not found/);
  assert.match(r.out, /FAIL  lane 2: Translate terminology 'missing-term' not found/);
  const m = doctor([...EX, "-c", `channels=${lanes()}`], { STUB_TERM: "en ja MULTI" });
  assert.match(m.out, /PASS  lane 2: Translate terminology 'simul-translation' is multi-directional/);
  const unset = doctor([...EX, "-c", `channels=${lanes()}`], { STUB_TERM: "en ja None" });
  assert.match(unset.out, /FAIL  lane 2: Translate terminology 'simul-translation' is uni-directional en to ja/, "an unset directionality behaves as UNI");
});
test("a Japanese lane without a vocabulary warns; with a generated Japanese vocabulary file in the folder the warning names it", () => {
  const dir = mkdtempSync(join(tmpdir(), "doctor-dict-"));
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "polly-readings.csv"), "term,reading\n");
    const noVoc = doctor(["--skip-aws", "-c", `dictionaryDir=${dir}`, "-c", `channels=${lanes({ transcribeVocabulary: "" })}`]);
    assert.match(noVoc.out, /WARN  lane 2 \(ja-JP to en\) has no Transcribe vocabulary: product names spoken in Japanese may be misrecognised/);
    writeFileSync(join(dir, "transcribe-vocabulary-ja.txt"), "Phrase\tSoundsLike\tIPA\tDisplayAs\n");
    const withFile = doctor(["--skip-aws", "-c", `dictionaryDir=${dir}`, "-c", `channels=${lanes({ transcribeVocabulary: "" })}`]);
    assert.match(withFile.out, /has no Transcribe vocabulary, but .* has transcribe-vocabulary-ja\.txt \(generated from the readings in terms\.csv\)/);
    assert.match(withFile.out, /fix: set "transcribeVocabulary" on that channel/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("a single ja-JP to en lane gets the per-lane checks too", () => {
  const one = JSON.stringify([{ source: "ja-JP", target: "en", pollyVoice: "Joanna" }]);
  const r = doctor([...EX, "-c", `channels=${one}`]);
  assert.match(r.out, /PASS  lane 1: ja-JP to en, voice Joanna, engine translate, vocabulary 'none', terminology 'simul-translation'/);
  assert.match(r.out, /WARN  lane 1 \(ja-JP to en\) has no Transcribe vocabulary/);
  assert.match(r.out, /PASS  lane 1: Polly voice Joanna exists for en-US/);
});
