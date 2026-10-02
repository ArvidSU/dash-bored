#!/bin/sh

if [ "${DASH_BORED_RELEASE:-0}" = "1" ]; then
  unset DASH_BORED_PROJECT_ROOT
  unset DASH_BORED_CONFIG_PATH
  unset DASH_BORED_VITE_PORT
  unset DASH_BORED_DEV_SERVER_URL
  unset DASH_BORED_INSTANCE
  unset DASH_BORED_APP_INSTANCE
  unset HUTCH_HOME
elif [ -f .env.worktree ]; then
  set -a
  . ./.env.worktree
  set +a
  # Source-checkout tools target this checkout even when launched by another app.
  DASH_BORED_APP_INSTANCE="dev.dash-bored.${DASH_BORED_INSTANCE}.dev"
  export DASH_BORED_APP_INSTANCE
fi

exec "$@"
