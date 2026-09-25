# Release QA fixture

A tiny service project. Build a useful dashboard for a maintainer: show this
README, provide explicit test and build actions, and show the service health.
Do not auto-run the service or build. Keep paths portable and do not invent
commands. Use the installed dash-bored skill and discovery CLI.

- `bun run test` checks the service response.
- `bun run build` writes a build marker to `build.txt`.
- `bun run start` serves HTTP on port 3000; `/health` returns `{"ok":true}`.
