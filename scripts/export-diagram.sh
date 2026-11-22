#!/usr/bin/env bash
# Re-exports a draw.io SVG (default docs/architecture.drawio.svg, also docs/overview.drawio.svg) from itself with the draw.io command line, keeps the embedded
# diagram as plain (uncompressed) XML so git diffs are readable, and scrubs the machine metadata.
#
#   scripts/export-diagram.sh [FILE.drawio.svg]     (default: docs/architecture.drawio.svg)
#
# Needs draw.io Desktop: macOS `brew install --cask drawio`, Linux the `drawio` package
# (https://github.com/jgraph/drawio-desktop/releases). Set DRAWIO=/path/to/binary to override.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FILE="${1:-$ROOT/docs/architecture.drawio.svg}"
case "$FILE" in *.drawio.svg) ;; *) echo "error: $FILE must end in .drawio.svg" >&2; exit 2;; esac
[ -f "$FILE" ] || { echo "error: $FILE not found" >&2; exit 2; }

DRAWIO_BIN="${DRAWIO:-}"
if [ -z "$DRAWIO_BIN" ]; then
  for c in /Applications/draw.io.app/Contents/MacOS/draw.io "$(command -v drawio || true)" "$(command -v draw.io || true)"; do
    if [ -n "$c" ] && [ -x "$c" ]; then DRAWIO_BIN="$c"; break; fi
  done
fi
if [ -z "$DRAWIO_BIN" ]; then
  echo "error: draw.io Desktop not found." >&2
  echo "  macOS: brew install --cask drawio" >&2
  echo "  Linux: install the drawio package from https://github.com/jgraph/drawio-desktop/releases (or set DRAWIO=/path/to/drawio)" >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
OUT="$TMP/out.drawio.svg"
# --theme light: a white background (readable in GitHub dark mode). --embed-svg-fonts false: no font data (keeps the file small).
"$DRAWIO_BIN" --export --format svg --embed-diagram --uncompressed --theme light --embed-svg-fonts false \
  --output "$OUT" "$FILE" >/dev/null
[ -s "$OUT" ] || { echo "error: draw.io produced no output" >&2; exit 1; }
cp "$OUT" "$FILE"
"$ROOT/scripts/scrub-drawio.sh" "$FILE"
echo "exported $FILE ($(wc -c < "$FILE" | tr -d ' ') bytes)"
