#!/bin/sh

if [ -f .env.worktree ]; then
  set -a
  . ./.env.worktree
  set +a
fi

exec "$@"
