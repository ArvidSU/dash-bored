#!/bin/sh

if [ "${DASH_BORED_RELEASE:-0}" = "1" ]; then
  unset DASH_BORED_PROJECT_ROOT
  unset DASH_BORED_CONFIG_PATH
  unset DASH_BORED_VITE_PORT
  unset DASH_BORED_DEV_SERVER_URL
  unset DASH_BORED_INSTANCE
elif [ -f .env.worktree ]; then
  set -a
  . ./.env.worktree
  set +a
fi

exec "$@"
