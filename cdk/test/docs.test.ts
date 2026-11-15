import { test } from "node:test";
import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EVENT_KEYS, knownContextKeys, profileNames } from "../lib/event-config";

const root = join(__dirname, "..", "..");
const doc = readFileSync(join(root, "docs", "configuration.md"), "utf8");
const docKeys = new Set([...doc.matchAll(/^\| `([A-Za-z][A-Za-z0-9.]*)` \|/gm)].map((m) => m[1]));

/** Context keys read by the code: ctx("key"), ctxStr("key"), get("key"), getCtx("key"), explicit("key") in lib/. */
function keysReadByCode(): string[] {
  const keys = new Set<string>();
  for (const f of ["config.ts", "event-config.ts"]) {
    const src = readFileSync(join(__dirname, "..", "lib", f), "utf8");
    for (const m of src.matchAll(/\b(?:ctx|ctxStr|ctxNum|ctxPort|get|getCtx|tryGetContext)\("([A-Za-z]+)"/g)) keys.add(m[1]);
  }
  return [...keys];
}

test("every key read by lib/config.ts is documented in docs/configuration.md", () => {
  const missing = keysReadByCode().filter((k) => !docKeys.has(k));
  assert.deepEqual(missing, [], `undocumented keys: ${missing.join(", ")}`);
});

test("every cdk.json context key is documented", () => {
  const missing = knownContextKeys().filter((k) => !docKeys.has(k));
  assert.deepEqual(missing, [], `undocumented keys: ${missing.join(", ")}`);
});

test("every event.json key is documented", () => {
  const missing = EVENT_KEYS.filter((k) => ![...docKeys].some((d) => d === k || d.startsWith(`${k}.`)));
  assert.deepEqual(missing, [], `undocumented event keys: ${missing.join(", ")}`);
});

test("docs list no key that no longer exists", () => {
  const valid = new Set<string>([...knownContextKeys(), ...keysReadByCode(), ...EVENT_KEYS, ...profileNames(), "dictionaries.transcribeVocabulary", "dictionaries.translateTerminology"]);
  const stale = [...docKeys].filter((k) => !valid.has(k));
  assert.deepEqual(stale, [], `documented but unknown: ${stale.join(", ")}`);
});
