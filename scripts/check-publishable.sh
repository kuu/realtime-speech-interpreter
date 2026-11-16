#!/usr/bin/env bash
# Publish gate. Runs scripts/check-publishable.mjs on the working tree (and git history), then packs exactly
# the files git would publish (tracked plus untracked non-ignored, existing on disk) into a tarball, unpacks it
# into a temp directory and scans that copy again with the shared patterns.
#
#   ./scripts/check-publishable.sh              # tree + history + tarball
#   ./scripts/check-publishable.sh --no-history # skip the git history scan (e.g. before `git init` in a fresh copy)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
ARGS=("$@")
echo "== working tree"
node scripts/check-publishable.mjs ${ARGS[@]+"${ARGS[@]}"}
echo "== tarball of the publishable tree"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
LIST="$TMP/files.lst"
if git rev-parse --git-dir >/dev/null 2>&1; then
  git ls-files -co --exclude-standard -z | while IFS= read -r -d '' f; do if [ -f "$f" ]; then printf "%s\0" "$f"; fi; done > "$LIST"
else
  find . -type f -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*' -not -path '*/cdk.out/*' -not -path './e2e/runs/*' -not -path './samples/out/*' -not -path './dictionaries/local/*' -not -name cdk.context.json -not -name .DS_Store -print0 | sed -z 's|^\./||' > "$LIST"
fi
tar --null -T "$LIST" -cf "$TMP/tree.tar"
mkdir "$TMP/x"
tar -xf "$TMP/tree.tar" -C "$TMP/x"
echo "files in tarball: $(tr -cd '\0' < "$LIST" | wc -c | tr -d ' ')"
cp scripts/forbidden-patterns.local.txt "$TMP/x/scripts/" 2>/dev/null || true
(cd "$TMP/x" && node scripts/check-publishable.mjs --no-history)
echo "PASS: working tree and tarball are clean"
