# Handoff: inherent-complexity refactor

As of 2026-10-03, this continuation is on `codex/handoff-l4-s16`, based on
`382cc9a` (`main` and the local `origin/main` ref). L4 and S16 are integrated
in the working tree; the atoms consolidation and package-pipeline work remained deferred at that handoff.

October 5 update: contract 4 extracts all 17 components to the pinned external
core repository. It retains legacy forms; atoms retirement needs a future
contract. The source hook below now lives in that component repository, and
package storage now uses private Git repositories owned by dash-bored.

Final verification: `caffeinate -is bun run qa:fast` passed 550 tests across
75 files, typecheck, renderer build, and agent-tool build.
`bun run dash-bored -- validate .` and `git diff --check` passed. Earlier runs
were interrupted by macOS sleep; the temporary keep-awake assertion ended with
the successful command. See README's verification workflow.

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
| L3 | `App.tsx` is a composition root over one hook per concern; see `docs/architecture/renderer.md`. |
| L7 | `tree.ts` is split into resolve, links, and validate. `src/migrations/` owns every legacy rewrite. Components and themes share one `PackageStore`. |
| L6 | Host state reaches the renderer only by push. Mutations answer with an ack or a typed result. The RPC has merged commands (`processCommand`, `agentTaskCommand`, `launchAgent`, `setTrust`). `src/main/index.ts` is wiring only. See `docs/architecture/runtime.md`. |
| L5 (part) | `useSourceComponent` in `src/renderer/lib/use-dashboard-source.ts` owns source loading, capability checks, and the `refresh` action. |
| L4 | `ProjectRuntime` resolves drafts with the saved-config resolver and returns the tree, diagnostics, trust decision, and approved local modules. `composition-preview.ts` and the `DashboardEditor` fallback are deleted. `ComponentDialog` and the draft toolbar share the one session. The host supplies typed `sourceNodePath`; the editor no longer parses YAML path strings. Frame menus use `siblingMoveTarget` and the existing operation planner. |
| S16 | The narrow `TagFilter` boundary is keyed by source provider identity. Valid tags survive observations; removed tags and disabled filtering reset permanently to All. Todo row state, edit buffers, and focus survive tag updates. |
| Timeout follow-up | The observable watcher check allows 20 s for the reload and has a 30 s test budget; renderer-suite cleanup has 30 s. The check still polls the observed snapshot rather than sleeping for a fixed interval. |
| Small items | One `childEdges` helper (`src/shared/child-edges.ts`). One reference walker: a trailing `*` makes each item a reference (`referenceLocations`). The config-link manifest is shared. The todo ID backfill lives in `src/migrations/`. |

L4 decisions: resolve in the host, show invalid-draft diagnostics in place, and
keep editor operations in `ProjectRuntime`, which already owns reachability,
trust, the queue, and publication. A separate editor service would add callbacks
for those same owners. The extracted props dialog still needs schema-v3 legacy
action checks; they now share the Node-free `src/migrations/action-target.ts`
leaf with migration and validation.

Linked sessions retain the exact config-link occurrence ID. Root replacement
keeps that namespace, and a multiply linked file cannot be previewed by file
path alone. Late validation/source responses cannot replace a newer session.
Save blocks further edits and navigation until its RPC finishes. Prop callbacks
look up the current node by ID before using its typed locator.

## Open work

The backlog lives in `props.todos` of node `id: yaml-todo` in
`.dash-bored/dash-bored.yaml`. Find the node by ID, not by tree position.
Add deferred work there.

1. **The rest of L5** waits for a future atoms contract migration
   (`todo-atoms-schema-migration`). `tabs` becomes a single-child selection
   container. `card` and `conditional` retire, and conditional visibility
   moves to edge metadata.
2. **`todo-package-pipeline`** needs decisions on rules users can see before
   the component and theme pipelines merge.

The native L4 gate (`todo-028`) is closed: in this checkout's isolated dev app,
Computer Use dragged a generated frame handle, moved a sibling up and down,
saved and checked the written YAML order, and cancelled a move back to the
saved order. A disposable dashboard under `.hutch/l4-proof` held the mutations;
its temporary registry entry was removed afterward. Native Work tag filtering
also worked and was restored to All. The project dashboard now dogfoods these
workflows in `composition-workflow` under Develop; its control-channel
screenshot was inspected, and the original focus and Changes tab restored.

## Contracts to preserve

- **Push before ack.** A mutation pushes what it changed before it resolves.
  This relies on Electrobun's FIFO host queue on macOS.
- **Process results.** The component `processes` API still returns
  `ProcessSnapshot` as the command result, but the renderer store takes
  process state only from pushes.
- **Node-free renderer.** Renderer code stays Node-free. Shared helpers go in
  `src/shared/`, and migration leaves the renderer imports must be Node-free
  too.
- **Draft capabilities.** Draft modules compile only for a trusted permission
  union. Privileged calls still resolve against the saved host tree until Save.

## Working notes

- **Live check.** Use `dev:start`, `dev:restart`, and `dev:status` for this
  checkout's isolated, agent-owned dev app. Then use
  `bun run dash-bored -- app status | actions <filter> | run <ref> | screenshot --focus <id> --output <png>`,
  and restore the original focus and selected tab afterwards.
- **Commits.** Before committing, run `git status --short` and
  `git diff --cached --check`.
- **Plan doc.** A live plan is kept at
  https://claude.ai/code/artifact/b334bffd-a35b-4e9e-8e37-b4c33935c15a; this
  file replaces it for agents without access to it.
