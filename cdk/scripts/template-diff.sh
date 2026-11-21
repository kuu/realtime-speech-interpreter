#!/usr/bin/env bash
# Shows what a setting adds to the template: synthesizes this tree twice (the default, and the default plus the given
# -c flags) and lists the resources added, removed and changed (logical ID and type), and the outputs added or removed.
# Asset hashes are normalized first, so a changed asset alone is not reported. For review only: it never fails on a
# difference. No AWS call.
# Usage: cdk/scripts/template-diff.sh -c inputSource=rtmps [-c key=value ...]
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # .../cdk
[ $# -gt 0 ] || { echo "usage: $0 -c key=value [-c key=value ...]" >&2; exit 2; }
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
BASE=(synth -q -c venueCidr=203.0.113.10/32 -c eventFile=none)
(cd "$HERE" && npx cdk "${BASE[@]}" -o "$TMP/a" >/dev/null 2>&1) || { echo "synth of the default failed" >&2; exit 1; }
(cd "$HERE" && npx cdk "${BASE[@]}" "$@" -o "$TMP/b" >/dev/null 2>&1) || { echo "synth with $* failed" >&2; exit 1; }
node - "$TMP/a/SimulTranslation.template.json" "$TMP/b/SimulTranslation.template.json" "$*" <<'JS'
const fs = require("fs");
const HASH = /[0-9a-f]{64}/g;
const sortKeys = (v) => Array.isArray(v) ? v.map(sortKeys)
  : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v;
const load = (p) => JSON.parse(JSON.stringify(sortKeys(JSON.parse(fs.readFileSync(p, "utf8")))).replace(HASH, "<hash>"));
const [a, b] = [load(process.argv[2]), load(process.argv[3])];
const ra = a.Resources ?? {}, rb = b.Resources ?? {};
const line = (sign, id, r) => console.log(`  ${sign} ${id} (${r.Type})`);
console.log(`template diff: default -> default + ${process.argv[4]}`);
console.log("resources added:");
for (const id of Object.keys(rb).filter((k) => !(k in ra))) line("+", id, rb[id]);
console.log("resources removed:");
for (const id of Object.keys(ra).filter((k) => !(k in rb))) line("-", id, ra[id]);
console.log("resources changed:");
for (const id of Object.keys(ra).filter((k) => k in rb)) {
  if (JSON.stringify(ra[id]) === JSON.stringify(rb[id])) continue;
  const props = new Set([...Object.keys(ra[id].Properties ?? {}), ...Object.keys(rb[id].Properties ?? {})]);
  const changed = [...props].filter((p) => JSON.stringify(ra[id].Properties?.[p]) !== JSON.stringify(rb[id].Properties?.[p]));
  console.log(`  ~ ${id} (${ra[id].Type}): ${changed.join(", ") || "attributes"}`);
}
const oa = Object.keys(a.Outputs ?? {}), ob = Object.keys(b.Outputs ?? {});
console.log(`outputs added: ${ob.filter((k) => !oa.includes(k)).join(", ") || "none"}`);
console.log(`outputs removed: ${oa.filter((k) => !ob.includes(k)).join(", ") || "none"}`);
JS
