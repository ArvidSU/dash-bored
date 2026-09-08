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

Start with [the verification workflow](./README.md#choosing-verification) and
only the relevant page in the architecture index. For dashboard edits, use
`bun run dash-bored -- inspect . --summary`, then `--component <reference>`
for the relevant schema; full catalog dumps are rarely needed.

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

## Agent-only UI verification

When Computer Use is available, native app interaction is the second UI-proof
layer. Read the current app state for `dash-bored-dev` (or the worktree's dev
instance) using the available Computer Use API, and verify that the accessible
header config path identifies this checkout, and operate only a harmless,
visible control through its current element locator. Re-read app state
after each click, drag, tab switch, or window interaction because native
accessibility indices can become stale. Capture a native screenshot when visual
placement matters; accessibility state proves control wiring, not pixel layout.
Restore temporary UI state such as the sidebar or selected tab. Do not use a
smoke check to launch commands, edit YAML, change trust, or mutate user data.
If native control injection fails, report the exact missing interaction rather
than claiming native coverage.
