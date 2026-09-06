#!/usr/bin/env bash
# Show the most recently touched files, newest first.
# Combines uncommitted working-tree changes with recent commit history so you
# can quickly see "what was I just working on".
#
# Usage: scripts/recent.sh [N]   (default N=20)
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

limit="${1:-20}"

echo "== Uncommitted changes =="
if git status --porcelain | grep -q .; then
  git status --short
else
  echo "(working tree clean)"
fi

echo
echo "== Recently committed files (last $limit touched) =="
git log --name-only --pretty=format: -n 200 \
  | awk 'NF && !seen[$0]++ && n < limit { print; n++ }' limit="$limit"
