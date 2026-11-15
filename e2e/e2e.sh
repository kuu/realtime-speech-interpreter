#!/usr/bin/env bash
# E2E test harness entry point. Works from any cwd: ./e2e/e2e.sh <command> [options]
# Commands: check [--fix] [--yes] | run | local | report | compare | langscan   (see e2e/README.md)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 not found (install Xcode command line tools or Homebrew python)" >&2
  exit 1
fi
export PYTHONDONTWRITEBYTECODE=1
exec python3 "$HERE/lib/e2e.py" "$@"
