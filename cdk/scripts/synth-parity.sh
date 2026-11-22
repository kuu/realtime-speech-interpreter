#!/usr/bin/env bash
# Checks that the shipped defaults (LLM engine + talk timing) and the "careful" profile reproduce the previous
# behaviour exactly, by comparing synthesized templates of this tree with the ones of a base ref (default origin/main,
# which still has the previous defaults). Templates are compared after sorting keys and replacing the 64-hex asset
# hashes with <hash>; the only value that may differ is the label in the LATENCY_PRESET environment variable,
# and its exact expected values are asserted.
#   (a) this tree, no flags                         == base with -c translateEngine=llm -c latencyPreset=fast   (labels talk | fast)
#   (b) this tree with -c latencyPreset=careful      == base, no flags                                           (labels careful | default)
#   (c) this tree with -c translateEngine=translate  vs base, no flags: informational, the timing variables differ by design.
# The hashes that changed are listed, so a reviewer sees which assets moved (only the app image should, because
# app/src changed). Read-only for the repository: the base ref is exported with `git archive` into a temp dir that is
# removed on exit (no git worktree, nothing to prune). No AWS call.
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
COMMON=(synth -q -c venueCidr=203.0.113.10/32 -c eventFile=none)
synth() { # <dir> <outdir> [extra -c flags...]
  local dir="$1" out="$2"; shift 2
  (cd "$dir" && npx cdk "${COMMON[@]}" "$@" -o "$out" >/dev/null 2>&1) || { echo "synth failed in $dir with: $*" >&2; exit 1; }
}
synth "$TMP/base/cdk" "$TMP/out-base-default"
synth "$TMP/base/cdk" "$TMP/out-base-llm-fast" -c translateEngine=llm -c latencyPreset=fast
synth "$HERE" "$TMP/out-this-default"
synth "$HERE" "$TMP/out-this-careful" -c latencyPreset=careful
synth "$HERE" "$TMP/out-this-translate" -c translateEngine=translate
T=SimulTranslation.template.json
cat > "$TMP/compare.js" <<'JS'
const fs = require("fs");
const HASH = /[0-9a-f]{64}/g;
const sortKeys = (v) => Array.isArray(v) ? v.map(sortKeys)
  : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v;
// Masks the value of the LATENCY_PRESET env var and returns the labels that were found.
function mask(v, labels) {
  if (Array.isArray(v)) return v.map((x) => mask(x, labels));
  if (v && typeof v === "object") {
    if (v.Name === "LATENCY_PRESET" && typeof v.Value === "string") { labels.push(v.Value); return { ...v, Value: "<label>" }; }
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mask(x, labels)]));
  }
  return v;
}
const load = (p) => { const labels = []; const t = mask(sortKeys(JSON.parse(fs.readFileSync(p, "utf8"))), labels); return { text: JSON.stringify(sortKeys(t), null, 1), labels }; };
const [name, pa, pb, wantA, wantB, info] = process.argv.slice(2);
const A = load(pa), B = load(pb);
const ha = new Set(A.text.match(HASH) ?? []), hb = new Set(B.text.match(HASH) ?? []);
const na = A.text.replace(HASH, "<hash>"), nb = B.text.replace(HASH, "<hash>");
const labelsOk = JSON.stringify(A.labels) === JSON.stringify([wantA]) && JSON.stringify(B.labels) === JSON.stringify([wantB]);
const la = na.split("\n"), lb = nb.split("\n");
const diffs = [];
for (let i = 0; i < Math.max(la.length, lb.length); i++) if (la[i] !== lb[i]) diffs.push(`line ${i + 1}:\n- ${la[i]}\n+ ${lb[i]}`);
if (info === "info") {
  console.log(`${name}: ${diffs.length} differing lines (informational)`);
  process.exit(0);
}
if (!labelsOk) {
  console.error(`${name}: LATENCY_PRESET labels ${JSON.stringify(A.labels)} / ${JSON.stringify(B.labels)}, expected [${wantA}] / [${wantB}]`);
  process.exit(1);
}
if (diffs.length > 0) {
  console.error(`${name}: NOT identical after asset-hash normalization; first difference at ${diffs[0]}`);
  process.exit(1);
}
const gone = [...ha].filter((h) => !hb.has(h)), added = [...hb].filter((h) => !ha.has(h));
console.log(`${name}: identical after asset-hash normalization (labels ${wantA} | ${wantB})`);
console.log(`  asset hashes only in base: ${gone.length}, only in this tree: ${added.length}`);
for (const h of gone) console.log(`  - ${h}`);
for (const h of added) console.log(`  + ${h}`);
JS
# base is the first file, this tree the second; the labels are listed in the same order.
node "$TMP/compare.js" "(a) default == base -c translateEngine=llm -c latencyPreset=fast" "$TMP/out-base-llm-fast/$T" "$TMP/out-this-default/$T" fast talk
node "$TMP/compare.js" "(b) -c latencyPreset=careful == base default" "$TMP/out-base-default/$T" "$TMP/out-this-careful/$T" default careful
node "$TMP/compare.js" "(c) -c translateEngine=translate vs base default" "$TMP/out-base-default/$T" "$TMP/out-this-translate/$T" default talk info
