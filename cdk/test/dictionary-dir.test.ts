import { test } from "node:test";
import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as cdk from "aws-cdk-lib";
import { loadConfig } from "../lib/config";
import { REPO_ROOT, resolveDictionary, resolveDictionaryDir } from "../lib/dictionary-dir";
import { SimulTranslationStack } from "../lib/simul-translation-stack";
import { makeContext } from "./helpers";

const base = { venueCidr: "203.0.113.10/32", eventFile: "none" };
const EXAMPLE_READINGS = join(REPO_ROOT, "dictionaries", "example", "polly-readings.csv");

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}
function fakeRoot(withLocal: boolean): string {
  const root = tmpDir("cdk-dict-root-");
  mkdirSync(join(root, "dictionaries", "example"), { recursive: true });
  if (withLocal) mkdirSync(join(root, "dictionaries", "local"));
  return root;
}
/** A dictionary folder whose readings differ from the example by one added row. */
function customDictionary(): string {
  const dir = tmpDir("cdk-dict-custom-");
  writeFileSync(join(dir, "polly-readings.csv"), readFileSync(EXAMPLE_READINGS, "utf8") + "Foo,フー\n");
  return dir;
}
function imageAssetHashes(ctx: Record<string, unknown>): string[] {
  const out = tmpDir("cdk-dict-out-");
  try {
    const app = new cdk.App({ context: makeContext(ctx), outdir: out });
    new SimulTranslationStack(app, "SimulTranslation");
    app.synth();
    const assets = JSON.parse(readFileSync(join(out, "SimulTranslation.assets.json"), "utf8")) as { dockerImages?: Record<string, unknown> };
    return Object.keys(assets.dockerImages ?? {});
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

test("resolution order: setting > local > example", () => {
  const withLocal = fakeRoot(true);
  const noLocal = fakeRoot(false);
  const other = tmpDir("cdk-dict-other-");
  assert.equal(resolveDictionaryDir("", noLocal).source, "example");
  assert.equal(resolveDictionaryDir("", withLocal).source, "local");
  assert.deepEqual(resolveDictionaryDir(other, withLocal), { dir: other, source: "setting" });
  assert.throws(() => resolveDictionaryDir("/nonexistent/dict-dir", withLocal), /does not exist/);
  for (const d of [withLocal, noLocal, other]) rmSync(d, { recursive: true, force: true });
});

test("a dictionary folder without polly-readings.csv is an error that names the fix", () => {
  const dir = tmpDir("cdk-dict-empty-");
  assert.throws(() => resolveDictionary(dir), /build\.mjs generate/);
  rmSync(dir, { recursive: true, force: true });
});

test("with no local folder the example is used and the config reports it", () => {
  const cfg = loadConfig(new cdk.App({ context: makeContext(base) }));
  assert.equal(cfg.dictionaryDirSource, "example");
  assert.equal(cfg.dictionaryDir, join(REPO_ROOT, "dictionaries", "example"));
});

test("event.json dictionaries.dir maps to dictionaryDir", () => {
  const dict = customDictionary();
  const dir = tmpDir("cdk-dict-event-");
  const f = join(dir, "event.json");
  writeFileSync(f, JSON.stringify({ venueCidr: "203.0.113.10/32", dictionaries: { dir: dict } }));
  const cfg = loadConfig(new cdk.App({ context: makeContext({ eventFile: f }) }));
  assert.equal(cfg.dictionaryDir, dict);
  assert.equal(cfg.dictionaryDirSource, "setting");
  rmSync(dir, { recursive: true, force: true });
  rmSync(dict, { recursive: true, force: true });
});

test("-c dictionaryDir wins and a different readings file gives a different image asset hash", () => {
  const dict = customDictionary();
  const example = imageAssetHashes(base);
  const custom = imageAssetHashes({ ...base, dictionaryDir: dict });
  const again = imageAssetHashes({ ...base, dictionaryDir: dict });
  assert.equal(example.length, 1);
  assert.notDeepEqual(custom, example);
  assert.deepEqual(again, custom, "the hash is stable for the same content");
  rmSync(dict, { recursive: true, force: true });
});

test("the CDK resolver and dictionaries/build.mjs where give the same answer", () => {
  const withLocal = fakeRoot(true);
  const noLocal = fakeRoot(false);
  const other = tmpDir("cdk-dict-other-");
  const cases: Array<[string, string, string]> = [
    ["", withLocal, "local"],
    ["", noLocal, "example"],
    [other, withLocal, "setting"],
  ];
  for (const [setting, root, source] of cases) {
    const args = [join(REPO_ROOT, "dictionaries", "build.mjs"), "where", "--root", root, ...(setting ? ["--dir", setting] : [])];
    const r = spawnSync("node", args, { encoding: "utf8", env: { ...process.env, DICTIONARY_DIR: "", DICT_DIR: "" } });
    const ts = resolveDictionaryDir(setting, root);
    assert.equal(r.stdout.trim(), `${ts.dir}\t${ts.source}`);
    assert.equal(ts.source, source);
  }
  for (const d of [withLocal, noLocal, other]) rmSync(d, { recursive: true, force: true });
});
