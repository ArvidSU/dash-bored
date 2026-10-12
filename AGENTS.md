[docs/IDEA.md](./docs/IDEA.md) guides implementation. If plans, prompts, code,
or documentation conflict with it, stop and resolve the conflict by either
updating docs/IDEA.md to reflect a new or updated direction or adjusting the
plan, prompt, code, or documentation.

[ARCHITECTURE.md](./ARCHITECTURE.md) is the architecture index; keep the linked
pages under docs/architecture/ up to date with the actual implementation.

Dog food this project and its features by adding components with sane configurations in the project dashboard.
If a work package defers features or amendments, add them to the `props.todos`
of node `id: yaml-todo` in [the project dashboard](./.dash-bored/dash-bored.yaml).
Find it by ID; positional tree paths change when the dashboard is rearranged.

## Start here

- Pick checks from [Choosing verification](./README.md#choosing-verification),
  and read only the architecture page that ARCHITECTURE.md routes your change
  to.
- In a new worktree (including `.claude/worktrees/*`), run
  `bun run worktree:setup` before any `:fast` check. Without it they fail with
  `Missing .hutch/devkit/tsconfig.json`.
- For dashboard edits, run `bun run dash-bored -- inspect . --summary`, then
  `--component <reference>` for the relevant schema; full catalog dumps are
  rarely needed. Finish with `bun run dash-bored -- validate .`.
- Releases follow [Cut a release](./docs/release-qa.md#cut-a-release); never
  publish the draft.

Dev builds are agent-owned: use the checkout's `dev:start`, `dev:restart`,
`dev:status`, and `dev:stop` without asking the user. Restart after
main-process or agent-tool changes. Prefer your own worktree instance for
parallel work. See README for isolation and automatic dev trust.

## Shared checkout

The user and other agents may be editing this checkout at the same time.

- Stage explicit paths only. Do not use `git add -A`, `git add .`, `git stash`,
  or checkout/reset commands on files you did not change.
- Never stop or kill processes that belong to another checkout; `dev:stop` only
  touches this one.
- Re-read a file before patching it; docs are hard-wrapped, so patches against
  remembered text fail.

Before committing structural moves, inspect `git status --short` and
`git diff --cached --name-status`: replacement directories can still be
untracked even when working-tree tests pass. Stage the intended replacements
and review `git diff --cached --check` without including unrelated work.

## Documentation ownership

Keep `AGENTS.md` intentionally small and agent-specific. Product intent belongs
in `docs/IDEA.md`; implementation decisions, contracts, and invariants belong
in `ARCHITECTURE.md` and its linked pages; user-facing setup, commands, and
workflows belong in `README.md`. Do not duplicate any of those here. Before adding an AGENTS note,
first update the canonical document when needed, then add only a short,
verified agent-execution quirk that cannot reasonably live there.

Never name a file `agents.md` or `claude.md` (any case) below the root: macOS
paths are case-insensitive, so coding agents load it as a nested instruction
file whenever they read a sibling.

## Agent-only UI verification

For any change visible in the app, prove it in the running dev instance
through its control channel before handing off; you do not need the user to
focus the window. Check that `bun run dash-bored -- app status` reports this
checkout's `configPath` (pass `--instance` when several run), navigate with
`app actions <filter>` and `app run <reference>`, then
`app screenshot --focus <node-id> --output <scratch>.png` and view the PNG.
Restore the original `focusedNodeId` and selected tab afterwards. Right after
a start or restart, `app` commands can report that no app is running, fail to
connect, or say the app is still loading; wait until `dev:status` shows
`"starting":false` with a PID and retry. Fall back to `ui:fixture` only when no
dev instance is running.

When Computer Use is available, native app interaction is the second UI-proof
layer. Every checkout's dev app is named `dash-bored-dev`, so target this
checkout's app by the identifier from `bun run dev:status` or by its bundle
path `build/dev-macos-arm64/dash-bored-dev.app`, and verify that the accessible
header config path identifies this checkout. Operate only a harmless,
visible control through its current element locator. Re-read app state
after each click, drag, tab switch, or window interaction because native
accessibility indices can become stale. Capture a native screenshot when visual
placement matters; accessibility state proves control wiring, not pixel layout.
Restore temporary UI state such as the sidebar or selected tab. Do not use a
smoke check to launch commands, edit YAML, change trust, or mutate user data.
If native control injection fails, report the exact missing interaction rather
than claiming native coverage.
