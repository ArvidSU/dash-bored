#!/bin/sh
# Check prerequisites without acquiring Electrobun's development lock.
for required in .hutch/devkit/tsconfig.json .hutch/devkit/api/config/electrobun-vite.ts; do
  if [ ! -f "$required" ]; then
    echo "Missing $required. Run bun run worktree:setup (new worktree) or bun run setup when no desktop watcher owns the Electrobun lock. This check does not run prepare or stop watchers." >&2
    exit 1
  fi
done

exec "$@"
