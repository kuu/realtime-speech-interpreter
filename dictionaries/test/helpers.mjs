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
  const r = spawnSync("node", [BUILD, ...args], { encoding: "utf8", env: { ...process.env, DICTIONARY_DIR: "", DICT_DIR: "", ...env }, input, cwd });
  return { status: r.status, out: r.stdout, err: r.stderr, all: r.stdout + r.stderr };
}
export { mkdirSync, writeFileSync };
