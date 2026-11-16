import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const DICT = join(HERE, "..");
export const REPO = join(DICT, "..");
export const BUILD = join(DICT, "build.mjs");
export const HEADER = "en,ja,reading,transcribe_en,translate_en_ja,polly_ja,phrase,display_as,notes,source,transcribe_en_pos,translate_en_ja_pos,polly_ja_pos\n";

export function tmp(prefix = "dict-test-") {
  return mkdtempSync(join(tmpdir(), prefix));
}
export function cleanup(...dirs) {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}
/** Make a dictionary dir containing terms.csv with the given body (header added). */
export function makeDict(body, { header = HEADER } = {}) {
  const dir = tmp();
  writeFileSync(join(dir, "terms.csv"), header + body);
  return dir;
}
export function build(args, { env = {}, input, cwd } = {}) {
  const r = spawnSync(process.execPath, [BUILD, ...args], { encoding: "utf8", env: { ...process.env, DICTIONARY_DIR: "", DICT_DIR: "", ...env }, input, cwd });
  return { status: r.status, out: r.stdout, err: r.stderr, all: r.stdout + r.stderr };
}
export { mkdirSync, writeFileSync };

export const FIX = join(HERE, "fixtures");
/** Write an executable shell script into a fresh bin dir; returns the dir. */
export function stubBin(name, script) {
  const bin = tmp("stub-bin-");
  const f = join(bin, name);
  writeFileSync(f, `#!/bin/sh\n${script}\n`);
  chmodSync(f, 0o755);
  return bin;
}
import { chmodSync } from "node:fs";
