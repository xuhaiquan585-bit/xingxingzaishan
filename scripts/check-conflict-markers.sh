#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PATTERN='^(<<<<<<<|=======|>>>>>>>)'
TARGETS=(README.md docs src tests .gitignore package.json)

if rg -n "$PATTERN" "${TARGETS[@]}"; then
  echo "\n❌ Detected merge conflict markers. Please clean them before commit/merge."
  exit 1
fi

echo "✅ No merge conflict markers found."
