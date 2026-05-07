#!/usr/bin/env bash
set -euo pipefail

# Resolve the repo root relative to this script's own location so the script
# works regardless of the caller's current working directory.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# --- Argument validation -------------------------------------------------------

if [ "$#" -eq 0 ]; then
  echo "Usage: bash scripts/dev-worktree.sh <worktree-name>" >&2
  exit 2
fi

if [ "$#" -gt 1 ]; then
  echo "Error: too many arguments; expected exactly one worktree name" >&2
  echo "Usage: bash scripts/dev-worktree.sh <worktree-name>" >&2
  exit 2
fi

WORKTREE_NAME="$1"

# Worktrees live under .worktrees/<name>/ — the project's standard git worktree
# location. Paths outside that directory are not supported.
WORKTREE_DIR="$REPO_ROOT/.worktrees/$WORKTREE_NAME"

# --- Directory existence check -------------------------------------------------

if [ ! -d "$WORKTREE_DIR" ]; then
  echo "Error: worktree '$WORKTREE_NAME' not found at $WORKTREE_DIR" >&2
  echo "Hint: run \`git worktree list\` to see existing worktrees." >&2
  exit 1
fi

# --- Port pre-check ------------------------------------------------------------
# Run BEFORE pnpm install so a port conflict exits immediately rather than
# wasting time on a doomed install run.

if command -v lsof >/dev/null 2>&1; then
  PORT_PIDS="$(lsof -nP -iTCP:1420 -sTCP:LISTEN -t || true)"
  if [ -n "$PORT_PIDS" ]; then
    echo "Error: port 1420 is already in use." >&2
    echo "Another instance of \`pnpm tauri dev\` (or another process) is bound to it." >&2
    echo "Run \`lsof -i :1420\` to see which process is using it." >&2
    exit 1
  fi
else
  echo "Warning: lsof not found, skipping port pre-check" >&2
fi

# --- Install and launch --------------------------------------------------------

echo "→ Installing dependencies in $WORKTREE_DIR"
cd "$WORKTREE_DIR"
pnpm install --prefer-offline

echo "→ Starting \`pnpm tauri dev\` in $WORKTREE_NAME"
exec pnpm tauri dev
