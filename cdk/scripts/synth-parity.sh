#!/usr/bin/env bash
# Checks that browser input is off by default: the synthesized template of this tree (no browser setting) must equal
# the template of origin/main, after sorting keys and replacing the 64-hex asset hashes. The hashes that changed are
# listed, so a reviewer sees which assets moved (only the app image should, because app/src changed).
# Read-only for the repository: origin/main is exported with `git archive` into a temp dir. No AWS call.
# Usage: cdk/scripts/synth-parity.sh [base-ref]   (default: origin/main)
set -euo pipefail
BASE="${1:-origin/main}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # .../cdk
ROOT="$(cd "$HERE/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

git -C "$ROOT" rev-parse --verify -q "$BASE" >/dev/null || { echo "unknown ref: $BASE" >&2; exit 2; }
mkdir "$TMP/base"
git -C "$ROOT" archive "$BASE" | tar -x -C "$TMP/base"
ln -s "$HERE/node_modules" "$TMP/base/cdk/node_modules"
[ -f "$HERE/cdk.context.json" ] && cp "$HERE/cdk.context.json" "$TMP/base/cdk/cdk.context.json"

ARGS=(synth -q -c venueCidr=203.0.113.10/32 -c eventFile=none)
(cd "$TMP/base/cdk" && npx cdk "${ARGS[@]}" -o "$TMP/out-base" >/dev/null 2>&1) || { echo "synth of $BASE failed" >&2; exit 1; }
(cd "$HERE" && npx cdk "${ARGS[@]}" -o "$TMP/out-this" >/dev/null 2>&1) || { echo "synth of this tree failed" >&2; exit 1; }

node - "$TMP/out-base/SimulTranslation.template.json" "$TMP/out-this/SimulTranslation.template.json" <<'JS'
const fs = require("fs");
const HASH = /[0-9a-f]{64}/g;
const sortKeys = (v) => Array.isArray(v) ? v.map(sortKeys)
  : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v;
const load = (p) => JSON.stringify(sortKeys(JSON.parse(fs.readFileSync(p, "utf8"))), null, 1);
const [a, b] = [load(process.argv[2]), load(process.argv[3])];
const ha = new Set(a.match(HASH) ?? []), hb = new Set(b.match(HASH) ?? []);
const na = a.replace(HASH, "<hash>"), nb = b.replace(HASH, "<hash>");
if (na !== nb) {
  const la = na.split("\n"), lb = nb.split("\n");
  for (let i = 0; i < Math.max(la.length, lb.length); i++) if (la[i] !== lb[i]) { console.error(`first difference at line ${i + 1}:\n- ${la[i]}\n+ ${lb[i]}`); break; }
  console.error("NOT identical after asset-hash normalization");
  process.exit(1);
}
const gone = [...ha].filter((h) => !hb.has(h)), added = [...hb].filter((h) => !ha.has(h));
console.log("identical after asset-hash normalization");
console.log(`asset hashes only in base: ${gone.length}, only in this tree: ${added.length}`);
for (const h of gone) console.log(`  - ${h}`);
for (const h of added) console.log(`  + ${h}`);
JS
