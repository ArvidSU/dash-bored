# Handoff: inherent-complexity refactor

As of 2026-10-02, `main` and `origin/main` are at `46889dc`. `bun run qa:fast`
passes (542 tests) and `bun run dash-bored -- validate .` passes.

Read `AGENTS.md` first. It covers verification, dashboard edits, and the
UI-proof workflow. `docs/IDEA.md` is the product authority.
`ARCHITECTURE.md` indexes the architecture pages, which must stay current.

## Goal

Make the app only as complex as its job. That means one owner per concept,
deriving state instead of syncing copies, deleting before adding, and keeping
behaviour the same. Every step must pass `bun run qa:fast`. Changes visible in
the app also need the live check described in `AGENTS.md`.

## Done

| Step | Result |
| --- | --- |
| L1, L2 | One action store and one keyed view-state store. |
| L3 | `App.tsx` is a composition root (387 lines) over one hook per concern; see `docs/architecture/renderer.md`. |
| L7 | `tree.ts` is split into resolve, links, and validate. `src/migrations/` owns every legacy rewrite. Components and themes share one `PackageStore`. |
| L6 | Host state reaches the renderer only by push. Mutations answer with an ack or a typed result. The RPC has merged commands (`processCommand`, `agentTaskCommand`, `launchAgent`, `setTrust`). `src/main/index.ts` is wiring only. See `docs/architecture/runtime.md`. |
| L5 (part) | `useSourceComponent` in `src/renderer/lib/use-dashboard-source.ts` owns source loading, capability checks, and the `refresh` action. |
| Small items | One `childEdges` helper (`src/shared/child-edges.ts`). One reference walker: a trailing `*` makes each item a reference (`referenceLocations`). The config-link manifest is shared. The todo ID backfill lives in `src/migrations/`. |

## Open work

The backlog lives in `props.todos` of node `id: yaml-todo` in
`.dash-bored/dash-bored.yaml`. Find the node by ID, not by tree position.
Add deferred work there.

1. **L4: one tree and one editor** (`todo-031`, gated on `todo-028`). The
   host resolves drafts, so the preview is the resolved draft. `NodePath` is
   the only locator. Delete `composition-preview.ts`, the `DashboardEditor`
   fallback, and the remaining `sameLocator` copies. Move move up/down to the
   frame menu through `siblingMoveTarget`. Gate: native proof of drag, move,
   and Save/Cancel in the dev app. Two open questions:
   - Are drafts resolved in the host (one round-trip per edit) or by a pure
     shared resolver?
   - What replaces the editor fallback? Draft diagnostics shown in place is
     the likely answer.

   The answer to the first question also decides
   `todo-dashboard-editor-service`. `todo-legacy-action-target-leaf` becomes
   moot once `DashboardEditor` is deleted.
2. **The rest of L5** waits for the schema-v4 migration
   (`todo-atoms-schema-migration`). `tabs` becomes a single-child selection
   container. `card` and `conditional` retire, and conditional visibility
   moves to edge metadata.
3. **S16** replaces the list and todo-list filter-reset effects with `key=`.
   It needs the semantics decided first (`todo-029`). The working proposal:
   keep a selected tag that still exists, otherwise reset to all, and keep
   todo editing and focus state.
4. **`todo-package-pipeline`** needs decisions on rules users can see before
   the component and theme pipelines merge.
5. **`todo-flaky-timeouts-under-load`**: under heavy load, the file-watcher
   test in `tests/core/runtime.test.ts` and one hook in
   `tests/renderer/ui-interaction.test.ts` exceed bun's 5 s timeout. Both
   pass alone.

## Contracts to preserve

- **Push before ack.** A mutation pushes what it changed before it resolves.
  This relies on Electrobun's FIFO host queue on macOS.
- **Process results.** The component `processes` API still returns
  `ProcessSnapshot` as the command result, but the renderer store takes
  process state only from pushes.
- **Node-free renderer.** Renderer code stays Node-free. Shared helpers go in
  `src/shared/`, and migration leaves the renderer imports must be Node-free
  too.

## Working notes

- **Live check.** `bun run dev` starts the dev app. Then use
  `bun run dash-bored -- app status | actions <filter> | run <ref> | screenshot --focus <id> --output <png>`,
  and restore the original focus and selected tab afterwards.
- **Commits.** Before committing, run `git status --short` and
  `git diff --cached --check`.
- **Plan doc.** A live plan is kept at
  https://claude.ai/code/artifact/b334bffd-a35b-4e9e-8e37-b4c33935c15a; this
  file replaces it for agents without access to it.
