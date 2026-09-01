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

1. The CLI creates and inspects project configuration.
2. The Electrobun main process owns files, trust, compilation, processes,
   network access, and application lifecycle.
3. The React renderer owns presentation and can reach privileged behavior only
   through typed Electrobun RPC.

Desktop builds also carry a standalone CLI compiled from the same source and
an embedded agent-skill payload. This is distribution of the first boundary,
not a fourth runtime authority: CLI validation uses the same core loader, and
the skill tells agents to discover the live component catalog from that CLI.

## Runtime topology

The application pins Electrobun 2.0.1 and uses its Bun main-process mode:

```text
project/dash-bored/                 # canonical standalone bundle
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
          |
          | typed request/response and snapshot RPC
          v
Vite + React renderer in the system webview
  - render the resolved tree and diagnostics
  - load revisioned local-component browser bundles
  - own the action registry, search, confirmation, and command palette UI
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
text, markdown, status, chart, live-chart, command, file, env, todo-list, and
webview. The registry itself contains only the synchronous lookup map, lazy
boundaries, and the local loading fallback. `@dash-bored/command` keeps its
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
with deterministic fixture data. The host mirrors the browser-safe dashboard
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

Within the renderer, `App.tsx` is the application coordinator: it owns the
authoritative snapshot subscription, draft lifecycle, and composition wiring.
`app-shell.tsx` owns only window chrome, dashboard navigation, the header, and
global notices. It receives state and callbacks from the coordinator and never
reads project files, creates drafts, or performs topology mutations. Workspace
and composition UI remain separate from the shell so shell changes cannot
weaken the renderer/main-process or draft persistence boundaries.

Snapshots also carry the parsed dashboard configuration, a SHA-256 revision of
the source file, and a component catalog. The catalog contains every built-in
plus bounded, containment-checked local manifest discovery. Invalid local
manifests are represented as unavailable catalog entries with diagnostics, so
they can be explained in the picker without breaking an otherwise valid tree.
The CLI's `inspect` result exposes this same complete catalog, including
`propsSchema`, children contract, permissions, availability, and diagnostics. It is the
version-authoritative component-shape interface for coding agents.
