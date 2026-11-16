// Resolve which dictionary directory to use.
// Order: explicit setting > dictionaries/local (if it exists) > dictionaries/example.
import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const isDir = (p) => existsSync(p) && statSync(p).isDirectory();

/** The setting from the environment: DICTIONARY_DIR, or the older DICT_DIR alias. Empty string means unset. */
export function settingFromEnv(env = process.env) {
  return (env.DICTIONARY_DIR || env.DICT_DIR || "").trim();
}

/**
 * @param {{setting?: string, root?: string}} opts
 * @returns {{dir: string, source: "setting"|"local"|"example"}}
 * A relative setting resolves against the repo root. A set but missing directory is an error (no silent fallback).
 */
export function resolveDictionaryDir({ setting = "", root = REPO_ROOT } = {}) {
  const s = (setting ?? "").trim();
  if (s) {
    const dir = isAbsolute(s) ? s : resolve(root, s);
    if (!isDir(dir)) throw new Error(`dictionary directory "${s}" does not exist (resolved to ${dir})`);
    return { dir, source: "setting" };
  }
  const local = join(root, "dictionaries", "local");
  if (isDir(local)) return { dir: local, source: "local" };
  return { dir: join(root, "dictionaries", "example"), source: "example" };
}
