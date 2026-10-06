#!/bin/sh
# Use the app-matched tool without installing anything on PATH.
set -eu
if [ -n "${DASH_BORED_TOOL:-}" ] && [ -x "$DASH_BORED_TOOL" ]; then
  exec "$DASH_BORED_TOOL" "$@"
fi
for launcher in "$HOME/.agents/skills/dash-bored/scripts/dash-bored" "${CODEX_HOME:-$HOME/.codex}/skills/dash-bored/scripts/dash-bored"; do
  if [ -x "$launcher" ]; then exec "$launcher" "$@"; fi
done
echo "dash-bored: install and open the desktop app once to install the dash-bored skill, or set DASH_BORED_TOOL to its bundled tool." >&2
exit 127
