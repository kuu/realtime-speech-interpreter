import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
// Which dictionary folder feeds the app image (and dictionaries.sh).
// Order: explicit setting > dictionaries/local (if it exists) > dictionaries/example.
// Same rules as dictionaries/lib/dir.mjs (a test checks both agree). A CommonJS module cannot import the .mjs.
export type DictionarySource = "setting" | "local" | "example";
export const REPO_ROOT = resolve(__dirname, "..", "..");
const isDir = (p: string): boolean => existsSync(p) && statSync(p).isDirectory();
export function resolveDictionaryDir(setting: string, root: string = REPO_ROOT): { dir: string; source: DictionarySource } {
  const s = (setting ?? "").trim();
  if (s) {
    const dir = isAbsolute(s) ? s : resolve(root, s);
    if (!isDir(dir)) throw new Error(`dictionaryDir "${s}" does not exist (resolved to ${dir})`);
    return { dir, source: "setting" };
  }
  const local = join(root, "dictionaries", "local");
  if (isDir(local)) return { dir: local, source: "local" };
  return { dir: join(root, "dictionaries", "example"), source: "example" };
}
/** Resolve and check that the generated Polly readings exist; they are copied into the app image. */
export function resolveDictionary(setting: string, root: string = REPO_ROOT): { dir: string; source: DictionarySource; readingsFile: string } {
  const r = resolveDictionaryDir(setting || (process.env.DICTIONARY_DIR ?? process.env.DICT_DIR ?? ""), root);
  const readingsFile = join(r.dir, "polly-readings.csv");
  if (!existsSync(readingsFile)) {
    throw new Error(`${readingsFile} not found. Run: node dictionaries/build.mjs generate --dir ${r.dir}`);
  }
  return { ...r, readingsFile };
}
/** sha256 of the readings file. Goes into the image asset hash so a changed dictionary builds a new image. */
export function readingsHash(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}
