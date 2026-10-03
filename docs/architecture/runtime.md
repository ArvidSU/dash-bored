# dash-bored - Architecture: Runtime and boundaries

## Status and architectural rules

This document describes the greenfield composition architecture. It is the
source of truth for the system shape; [Product vision](../IDEA.md) is the source
of truth for product intent. The redesign is intentionally breaking: the
contracts below replace the former v1 slot/layout/component-special-case model.

dash-bored is a local-first composition runtime. A project owns recursive YAML
composition topology and optional project-specific components. The desktop
application owns tiling, frames, manipulation, focus/collapse, drafts,
validation, and persistence; it resolves components and renders them inside
that topology without containing project-specific integrations itself.

The implementation deliberately has three boundaries:

1. The agent tool creates and inspects project configuration.
2. The Electrobun main process owns files, trust, compilation, processes,
   network access, and application lifecycle.
3. The React renderer owns presentation and can reach privileged behavior only
   through typed Electrobun RPC.

`ProjectRuntime` owns dashboard source reachability, draft resolution and
validation, revision checks, and atomic saving within its operation queue.
`validateDashboardDraft` returns the resolved draft tree and trusted compiled
modules without publishing a snapshot or writing YAML. Linked drafts carry the
exact boundary occurrence ID; the host preserves that namespace even when the
draft root changes. Compilation follows the draft permission union's trust
decision. Capability calls continue to use the saved host tree until Save.
These operations remain with the runtime because a separate editor service
would need callbacks for the same queue, trust, and definition publication.

Desktop builds also carry a standalone agent tool compiled from the same source
(`Contents/Resources/app/tools/dash-bored`) and an embedded agent-skill payload.
There is no user-facing CLI; the skill's `scripts/dash-bored` launcher resolves
the tool for agents. This is distribution of the first boundary, not a fourth
runtime authority: tool validation uses the same core loader, and the skill
tells agents to discover the live component catalog from that tool.

App-wide setting defaults live in `src/shared/app-settings.ts` so the main
process and renderer start from the same values. Consumers clone its mutable
collections before updating settings; the main process still normalizes and
persists the authoritative settings record.

Development startup creates a checkout-specific `.env.worktree`, Vite port,
application identity, and `.hutch/home`. Toolchain caches are copied with
copy-on-write when supported; Hutch's mutable state and locks are never shared.
The identity isolates settings, trust, the registry, and the agent-control
socket. Development automatically trusts declared capabilities for the process
and skips global installed-skill refresh and legacy CLI-link maintenance.
Explicit project-skill operations remain available. See [Security](./security.md).

Desktop launchers commonly inherit only a system PATH. Before resolving or
launching dashboard commands, the main process appends conventional user CLI
locations for the current platform (including user-local, Bun, Cargo, Homebrew,
pnpm, and npm locations). It does not read or evaluate login-shell files. A
nonstandard agent installation remains an explicit absolute command in
application settings. Agent PTYs use a fixed system shell so login-shell hooks
cannot replace the preflighted environment between validation and execution.
The tool is not added to PATH. Main sets `DASH_BORED_TOOL` to the absolute
bundled tool path and `DASH_BORED_APP_INSTANCE` to the app identifier, so
dashboard commands and launched agents inherit both. The canary release instance also
records the tool path in `~/.config/dash-bored/tool-path` for the launcher.

Main serves a per-instance agent-control channel: HTTP over a user-private Unix
socket at `~/.config/dash-bored/run/<identifier>.sock`, advertised by
`<identifier>.json` in the same directory and withdrawn on quit. Its
`/v1/status`, `/v1/actions`, `/v1/actions/run`, `/v1/open`, and
`/v1/screenshot` routes back the tool's `app` command. Actions are relayed to
the renderer and run through the shared `ActionStore`; trust, edit-mode,
add-dashboard, and confirmation-requiring actions are refused, and `/v1/open`
is refused while a draft is open. Screenshots capture the app window with
`screencapture` (optionally cropped to a node's bounds in process) and require Screen Recording permission. See
[Security](./security.md).

## Runtime topology

The application pins Electrobun 2.0.1 and uses its Bun main-process mode:

```text
project/.dash-bored/                 # canonical standalone bundle
  dash-bored.yaml
  dash-bored-lock.yaml
  .env
  components/
  arvid/                            # optional named standalone bundle
    dash-bored.yaml
    dash-bored-lock.yaml
    .env
    components/
          |
          v
Electrobun Bun main process
  - locate, parse, validate, and watch project files
  - validate and atomically persist dashboard drafts
  - resolve built-in and local components
  - compile trusted local TSX with Bun.build()
  - enforce trust and component permissions
  - own subprocesses, file access, and HTTP requests
  - persist app settings and launch the explicitly configured CLI agent
  - serve the per-instance agent-control channel
          |
          | typed request/response and snapshot RPC
          v
Vite + React renderer in the system webview
  - render the resolved tree and diagnostics
  - load revisioned local-component browser bundles
  - own the action store, search, confirmation, and command palette UI
  - display process output and project trust controls
```

`build.mainProcess` is set to `"bun"` because local component compilation uses
the Bun bundler at runtime. Vite builds the renderer. Electrobun's projected SDK
is prepared through Hutch and aliased into Vite. The application uses native
system webviews and does not bundle CEF.

Packaged built-in renderers are resolved through a synchronous registry, but a
registry entry may be a React `lazy` boundary. This keeps the component lookup
and node-rendering contract unchanged while allowing implementation modules to
load only when a live node needs them. The loading state is local to the
component surface, so one deferred built-in does not block unrelated dashboard
content. Heavy dependencies and component-owned CSS stay in the implementation
module rather than in the eager registry module. Every shipped renderer entry
is now a boundary under `src/renderer/builtins/`: group, conditional, tabs, card,
markdown, list, status, chart, live-chart, command, env, todo-list, and webview. The
registry itself contains only the synchronous lookup map, lazy boundaries, and
the local loading fallback. `@dash-bored/command` keeps its
xterm runtime and CSS in `command.tsx`, while `@dash-bored/markdown` keeps
`react-markdown` and `markdown.css` in `markdown.tsx`; both are browser-fixture
verified on insertion. The production renderer build emits separate async
chunks for every implementation module, including the heavy command and
Markdown dependencies, while the main renderer chunk stays below the default
Vite warning threshold.

This is a renderer loading optimization only. The main-process built-in
manifests, schemas, permissions, and resource contracts remain eager and
authoritative; lazy loading must not change catalog discovery, validation,
trust, process ownership, or the persistent PTY lifecycle. A new lazy boundary
must be verified in the browser fixture both before and after insertion, and
the production build must retain the default Vite chunk warning as a regression
signal. Manual chunk grouping alone does not count as lazy loading because
static imports can still make every grouped module part of startup.

`ui-harness.html` is a development-only renderer proof surface. It selects an
in-memory `DashboardHost` before mounting the normal application entrypoint,
then renders the same App, CSS, packaged components, composition, and sidebar
with deterministic fixture data. The entrypoint awaits host initialization
before mounting React, and only the harness page dynamically imports the
fixture host. The host mirrors the browser-safe dashboard
contract: catalog/children/props validation is meaningful, accepted saves
advance the config and snapshot revisions, publish a new resolved tree, and
stale revisions reject. Filesystem, lock-file, local-component compilation,
and trust remain main-process-only validation boundaries.

`bun run test:renderer-ui` drives pointer and keyboard interactions in Chrome
against that fixture and asserts both visible UI and in-memory host state. It
is intentionally not a desktop emulator: the live RPC transport remains guarded
on all other renderer pages, and this test cannot establish native
webview-overlay, title-bar, or desktop-input behavior. `bun run native:probe`
uses a different app instance and Vite port, refuses to attach to a busy port,
and leaves no user-owned watcher under its control. It exercises a manual
native-webview visibility/dimension smoke page plus the source-level contract;
it does not synthesize OS input or claim general native interaction coverage.
Native desktop input is deliberately outside this repository's automated test
dependencies, so the probe remains an honest manual smoke boundary.
These give agents stable renderer and native-proof boundaries without attaching
to an ambiguous or user-owned Electrobun process.

The main window uses Electrobun's `hiddenInset` title-bar style. The renderer
uses one shared app-background surface for the sidebar and header, without a
separator between them, so the native traffic lights sit inside the shell
instead of a second title treatment. The transparent traffic-light hit area,
sidebar, and header are draggable; buttons and other controls explicitly opt
out so they remain interactive. The sidebar reserves the small top area so its
brand mark does not collide with the controls. The main process clamps resizes
below 350px, and the renderer keeps the header single-row at that minimum by
shrinking and ellipsizing content instead of wrapping actions.

The main process publishes a complete `ProjectSnapshot` at startup and after
each accepted change. It also publishes individual process snapshots while a
command is running. The renderer treats those snapshots as authoritative; it
does not read project files or spawn commands directly.

Host state reaches the renderer only by push: the `snapshot`, `process`,
`agentTask`, and `themes` messages in `src/shared/rpc.ts`. The renderer reads
the snapshot once at boot (`getSnapshot`). After that, a mutation pushes what
it changed before it resolves, and it answers with an ack (`void`) or a
command-specific result. Examples are `{ opened }` from `chooseProject`,
`{ conflictsRemain }` from `repairInstalledTools`, and the package operation's
message. A mutation never answers with a copy of host state. The one exception
is `processCommand`, which answers with the touched process because
components' `processes` API returns it to its caller. The renderer still takes
the store's copy only from the push. This ordering relies on Electrobun's
host-to-webview queue being FIFO on macOS. Electrobun lets responses overtake
messages only on Linux, which dash-bored does not target.

Command variants share one request: `processCommand` (start, open,
quick-action, write, resize, stop), `agentTaskCommand` (stop, write, resize),
`launchAgent` (component, creation, diagnostics, setup), and `setTrust`.

`src/main/index.ts` only wires the main process. It creates the stores, the
`ProjectRuntime`, and the window, and it routes pushes through one typed
`send`. Each job lives in its own module:

- `dashboard-rpc.ts`: the renderer's request handlers.
- `agent-launch.ts`: every agent start, plus agent task commands and diffs.
- `update-wiring.ts`: the update coordinator, the busy-work guard, and the
  release-only continuation.
- `app-themes.ts`: the app-level theme catalog and the personal theme watcher.
- `installed-tools.ts`: installed-tool refresh, repair, and the warnings added
  to every snapshot.
- `app-menu.ts`: the native menu.
- `agent-control-bridge.ts`: the window side of the agent control channel.

`ProjectRuntime` builds every snapshot through `buildSnapshot()`, and it runs
process commands only after the `requireProcess()` execute check.
An item action may pass at most 32 bounded `DASH_ITEM_*` string overrides when
starting a supervised command. The main process validates those names and
values and adds them to that launch's environment; it never substitutes item
data into the configured shell command.

Within the renderer, `app/App.tsx` is the application coordinator. It composes
one hook per concern: `use-host-session.ts` owns the authoritative snapshot
subscription, `use-dashboard-draft.ts` the draft lifecycle, and
`use-composition-session.ts` the composition wiring.
`app/app-shell.tsx` owns only window chrome, dashboard navigation, the header, and
global notices. It receives state and callbacks from the coordinator and never
reads project files, creates drafts, or performs topology mutations. Workspace
and composition UI remain separate from the shell so shell changes cannot
weaken the renderer/main-process or draft persistence boundaries.

Snapshots also carry the parsed dashboard configuration, a SHA-256 revision of
the source file, and a component catalog. The catalog contains every built-in
plus bounded, containment-checked local manifest discovery. Invalid local
manifests are represented as unavailable catalog entries with diagnostics, so
they can be explained in the picker without breaking an otherwise valid tree.
The agent tool's `inspect` result exposes this same complete catalog, including
`propsSchema`, children contract, permissions, availability, and diagnostics. It is the
version-authoritative component-shape interface for coding agents.
