# dash-bored - Architecture

## Status and architectural rules

This document describes the greenfield composition architecture. It is the
source of truth for the system shape; [IDEA.md](./IDEA.md) is the source of
truth for product intent. [initial_impl.md](./initial_impl.md) is historical
inspiration only. The redesign is intentionally breaking: the contracts below
replace the former v1 slot/layout/component-special-case model.

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

## Project contract

### Layout and project arguments

All dash-bored-owned project files live together:

```text
project/
└── dash-bored/
    ├── dash-bored.yaml
    ├── dash-bored-lock.yaml
    ├── .env
    └── components/
```

A project may also contain named dashboard bundles. Each repeats the complete
contract and can be copied, opened, validated, or repaired independently:

```text
project/
└── dash-bored/
    └── arvid/
        ├── dash-bored.yaml
        ├── dash-bored-lock.yaml
        ├── .env
        └── components/
```

Named bundles are organization, not inheritance. The canonical and named
configs do not implicitly share lock entries, component directories, nodes, or
defaults. Their only composition mechanism is an explicit component reference
to another standalone bundle path.

The `validate`, `inspect`, and CLI `open` project arguments may identify the
project root, a standalone bundle directory, or its `dash-bored.yaml`. `open`
renders exactly the selected bundle; the CLI passes both the canonical project
root and the selected config path to the desktop process. Resolution does not
walk unrelated ancestor directories. Paths are canonicalized before they are
used as trust keys or containment boundaries. The desktop project chooser uses
the selected directory's shape: a nested `dash-bored/dash-bored.yaml` selects
the project root, while a direct `dash-bored.yaml` selects that standalone
bundle. The same chooser therefore opens either kind of dashboard without
merging standalone configs into one another.

Opening a project, either through `dash-bored open` or the desktop project
chooser, ensures that this complete project contract exists. The application
creates the `dash-bored/` directory, default configuration, empty lock file,
starter environment file, and `components/` directory when they are missing. It
creates only missing artifacts and never replaces an existing configuration,
lock, or environment file, so a partially initialized project is repaired
without discarding project state.
The starter `.env` is created with owner-only permissions for project-local
component and command variables. `DASH_BORED_AGENT` is app-wide instead: the
main process persists it in the Electrobun user-data directory, publishes it to
dashboard command environments, and exposes it in Settings.
Directories selected in the desktop chooser are always treated as project
roots, including when the selected directory itself is named `dash-bored`.

`dash-bored init arvid` creates the complete named bundle under
`dash-bored/arvid/`: configuration, lock file, environment file, and local
component directory.
Additional positional names each add a directory level, so `dash-bored init
arvid cicd` creates `dash-bored/arvid/cicd/`. Slash-separated names such as
`people/arvid` remain supported. The command neither changes the canonical
dashboard nor adds a reference to the new bundle.

### Dashboard configuration

`dash-bored.yaml` has one recursive root node:

```yaml
schemaVersion: 2
name: Example project
icon: ./assets/icon.svg
root:
  id: project-layout
  component: "@dash-bored/group"
  children:
    type: tiled
    layout:
      type: split
      axis: horizontal
      ratio: 0.4
      first:
        type: child
        child:
          node:
            id: welcome
            component: "@dash-bored/markdown"
            props:
              content: "# Example project"
      second:
        type: child
        child:
          node:
            id: agent-setup
            component: "@dash-bored/card"
            props:
              title: Agent setup
            children:
              type: tiled
              layout:
                type: child
                child:
                  node:
                    id: install-dash-bored-skill
                    component: "@dash-bored/command"
                    props:
                      label: Install the portable skill
                      command: '"${DASH_BORED_BUNDLED_CLI:-dash-bored}" install-skill .'
```

The public configuration types are:

```ts
interface DashboardConfig {
  schemaVersion: 2;
  name: string;
  icon?: string;
  root: ComponentNode;
}

interface ComponentNode {
  id?: string;
  component: string;
  props?: Record<string, unknown>;
  children?: ComponentChildren;
}

type ComponentChildren =
  | { type: "managed"; items: ComponentChildEdge[] }
  | { type: "tiled"; layout: ComponentChildLayout };

interface ComponentChildEdge {
  node: ComponentNode;
  metadata?: Record<string, unknown>;
}

type ComponentChildLayout =
  | { type: "child"; child: ComponentChildEdge }
  | {
      type: "split";
      axis: "horizontal" | "vertical";
      ratio: number;
      first: ComponentChildLayout;
      second: ComponentChildLayout;
    };
```

The root is a component rendered in a core-owned composition tree; it may be a
single button or display. Tile branches are topology records, not components.
Node IDs must be unique across the tree. When an ID is omitted, the loader
derives a stable ID from the YAML path. Edge metadata (for example a tab label)
belongs to the parent-child edge and is validated by the declaring parent's
metadata schema.

The loader rejects duplicate YAML keys, unsupported schema versions, unknown
structural keys, malformed recursive topology, duplicate IDs, excessive
nesting, unknown components, invalid props, invalid child cardinality, invalid
axis declarations, and invalid edge metadata. Diagnostics
carry a stable code, severity, message, and file/path location where available.

The optional top-level `icon` is an image path relative to the owning config
bundle or an HTTP(S) URL. In trusted mode the main process bounds and
content-sniffs the image, converts it to a data URL, and uses it for that
dashboard's sidebar item. Missing, unreadable, or unsupported artwork falls back
to the generic project glyph without invalidating the dashboard. The dashboard
editor exposes both `name` and `icon` as dashboard metadata fields; they are
saved with the same draft as the component tree. Clearing the icon field removes
the optional key and restores the generic project glyph. These fields are
dashboard metadata, not component-tree nodes.

### In-app structural editing and composition contract

The core application owns the recursive tiling topology and every operation
that changes it: drag-and-drop, horizontal split resize, visible-surface height caps, component
frames, focus, collapse, draft validation, and atomic Save/Cancel persistence.
A tile branch is composition structure, not a component node. YAML recursively
stores the topology and component content as the sole source of truth; there
is no hidden grid database or parallel coordinate store.

An ordinary component manifest declares whether it renders a visible `surface`
(the default) or is a transparent `layout` boundary, plus exactly one `children`
contract with minimum and maximum cardinality and allowed axes. A complex container may
declare managed child presentation and a schema for metadata on each
parent-child edge. The runtime passes generic child handles, read-only child
descriptors, and a render/visibility projection to components. Tabs and
accordions are therefore ordinary declarations: tab labels are edge metadata,
not a tabs-specific app prop or validation branch.

Packaged and project-local components implement the same manifest, render,
host, children, and capability contracts. Provenance and trust are the only
difference: packaged app code is pretrusted; project-local code requires
project trust. Validation, editor, and runtime code never branches on a
component ID. All variation is declarative through manifest rendering mode,
schemas, formats, and capabilities.

The right-hand component-library flyout is read-only when it opens. The first
insertion, move, removal, replacement, edge-metadata edit, or horizontal ratio resize
creates the renderer's draft from the authoritative owning YAML. Save validates
the complete owning tree and atomically publishes it, while Cancel discards the
draft; opening or closing a clean flyout never creates a draft.
The draft uses the same recursive topology and children contracts as YAML: there
is no separate grid model. The root toolbar exposes replacement with any catalog
component, while descendants can move between compatible child contracts.
Incompatible nested content is reported before it is dropped from the draft.
Empty child boundaries and insertion boundaries
expose add targets; props are edited from the manifest JSON Schema with a JSON
fallback.

The flyout uses the complete snapshot catalog for packaged, project-local, and
linked-config entries. Search, provenance, permissions, child contracts, and
unavailable diagnostics are catalog metadata, not capability differences. Its
drop targets are derived from the target manifest's cardinality, presentation,
axis, and edge-metadata schema; the editor has no component-ID-specific paths.
Every insertion, root replacement, and existing-node move is first evaluated by
one pure composition-operation planner over the current draft, catalog, payload,
and target. The planner returns either a stable rejection reason or the exact
next immutable configuration; renderer eligibility (including keyboard and
pointer drop affordances) and the final draft mutation consume that same plan.
It reuses the authoritative tree helpers, preserves moved edge metadata, IDs,
and props, and fails closed for stale paths, impossible placements, root moves,
and own-descendant moves.
Managed-child metadata moves with its edge, and a new edge is configured through
the declaring parent's generic metadata schema. Focused linked content still
uses the linked bundle's source config as the one atomic save target.
Pointer geometry is used only to choose among those explicit targets; it never
creates a second placement representation. While the flyout, a drop target, or
a composition dialog is active, the renderer propagates visibility to native
Electrobun webview surfaces so their separate window overlays cannot cover the
composition UI.
Library-card insertion uses a pointer gesture with window-level move and release
listeners rather than depending on native HTML5 drop delivery. Once the gesture
activates, the flyout becomes translucent and non-hit-testing so a dashboard
target underneath it remains discoverable; the resulting pointer coordinates
still resolve through the same generic placement and draft mutation path.
Dashboard component frames are the native node drag sources rather than a small
move handle. During a node drag, the open flyout becomes 20% of the viewport
dotted trash drop target containing only an accessible trash icon. Component
menus and composition controls are omitted for the duration, and a drop routes
through the existing confirmed removal and draft mutation path.

A horizontal tile branch exposes its core-owned ratio separator. Runtime
horizontal ratios remain local to the user and keyed by config path and split
branch; while composing, the same interaction updates the draft and becomes the
project default only after Save. Vertical branches are ordered document flow:
they never pin a shared height, stretch one child when another shrinks, or own
scrollbars.

Every manifest defaults to `renderMode: surface`; organizational components
whose height follows their descendants declare `renderMode: layout`. Only visible surfaces expose a bottom
height control. A surface is initially uncapped at its full intrinsic height.
Dragging or using the keyboard may set a smaller per-user maximum height, never
a larger one, and reset removes the cap. The component's own outer box stays in
place while its content becomes the scroll container, so rounded top and bottom
chrome remain visible. Height caps are renderer presentation state keyed by
config path and stable node ID; layout boundaries and linked-config boundaries
remain auto-sized. The document is the sole outer vertical scroller and grows
with any number of components. The editor never writes a parallel coordinate
model.

Drafts may temporarily omit required props or children. The renderer requests
debounced validation from the main process and disables Save while errors
remain. Cancel discards the renderer-only draft. Existing components remain
the authoritative runtime until a save succeeds.

Saving sends the complete draft and the source revision from which editing
started. The main process serializes save operations with project lifecycle
operations, rejects stale revisions, reruns config/lock/tree validation, and
precompiles local components before writing when the proposed permission set
is already trusted. It publishes canonical YAML through a same-directory
temporary file and atomic rename. Validation, compilation, and conflict
failures leave the source file and active dashboard untouched. A permission
increase naturally invalidates the existing trust grant through the normal
permission-union check.

Edit sessions target the standalone YAML bundle that owns the focused node.
The renderer fetches that source config, bundle-local catalog, and revision;
Save validates and atomically replaces only that file before reloading the
canonical dashboard. Nodes rendered across a config-link boundary therefore
remain independently editable without creating a multi-file transaction.

### Lock file

`dash-bored-lock.yaml` is required and consumed on every load:

```yaml
lockfileVersion: 1
components: {}
```

Built-ins and files below the project's `components/` directory are not locked.
External npm and Git components are intentionally unavailable in this
architecture, so any
non-empty external component entry is reported as unsupported rather than
silently ignored. This keeps the file format ready for reproducible external
resolution without pretending that resolution exists today.

## Component system

The built-in catalog includes inline display and managed-container components,
including `@dash-bored/chart` for YAML-defined static line or bar data and
`@dash-bored/live-chart` for polling a JSON chart model through the
`network:http` capability. These chart components share a dependency-free SVG
renderer and keep the last valid live result when a refresh fails.
Core composition branches are YAML topology and do not appear in the component
catalog.

### Standalone dashboard paths

A component reference outside the built-in `@dash-bored/*` namespace and the
bundle-local `./components/*` directory may resolve to another standalone
dashboard bundle or its `dash-bored.yaml`. For example,
`component: "./arvid"` in the canonical config loads
`dash-bored/arvid/dash-bored.yaml`. This is a component boundary, not a
preprocessing directive.

Paths may be absolute or relative; relative paths resolve from the directory
containing the source `dash-bored.yaml`. The target uses its own
`dash-bored.yaml`, `dash-bored-lock.yaml`, `.env`, and `components/` directory
and renders inside the space allocated to the referencing component. No nodes,
locks, or component lookup state are merged into the containing config.

Broken paths are expected after users reorganize checked-in files. The
component instance reports that failure locally and leaves the containing
dashboard usable; dash-bored does not search for, rewrite, or repair the path.
Recursive references stop with a localized diagnostic at the component
boundary.

### Resolution

The `@dash-bored/*` namespace is reserved for built-ins. Project components are
referenced by a relative path below `./components/`, for example:

```yaml
component: "./components/service-health"
```

When a reference selects a local React component below `./components/`, the
resolver uses canonical real paths and rejects absolute paths, traversal,
symlinks that escape that bundle's component directory, and reserved-namespace
collisions. Those restrictions do not apply to standalone dashboard paths,
which intentionally allow absolute references.

A local component is a directory with this shape:

```text
components/service-health/
├── component.yaml
├── index.tsx
└── optional relative TS, TSX, and CSS files
```

Its manifest is self-describing:

```yaml
schemaVersion: 2
id: service-health
name: Service health
description: Shows project service health.
entry: ./index.tsx
renderMode: surface
propsSchema:
  type: object
  additionalProperties: false
children:
  min: 0
  max: 10
  presentation:
    type: tiled
    axes: both
permissions:
  - network:http
```

`renderMode` defaults to `surface`; use `layout` when the component is an
organizational boundary whose height must follow its descendants rather than an
independently resizable surface. `propsSchema` and,
for managed children, `children.metadataSchema` are JSON Schema. A component
that accepts children declares one contract with minimum
and maximum cardinality plus either app-owned tiled axes or managed
presentation. Managed presentation uses generic child handles and read-only
descriptors plus edge metadata. Supported permission names are:

- `filesystem:read`
- `filesystem:write`
- `network:http`
- `process:execute`
- `process:observe`
- `webview:embed`

Chart-shaped data uses a shared model:

```yaml
labels: [Mon, Tue, Wed, Thu]
series:
  - label: Checks passed
    values: [18, 24, 21, 29]
```

`@dash-bored/chart` receives that model through its required `labels` and
`series` props. `@dash-bored/live-chart` receives it from an HTTP JSON response.
Its `endpoint` may be absolute HTTP(S) or an app-relative path such as
`/metrics/chart.json`, and may optionally select a nested model with a
dot-separated `dataPath`; it accepts `type: line|bar`,
`pollIntervalMs: 1000..300000`, and `maxPoints: 2..200`. Live polling stops
while the containing tab is hidden.

Generic tree validation runs before component-specific props and children are
validated. The requested project permission set is the union of permissions
declared by every resolved component, packaged or project-local.

### Local React contract and compilation

Local TSX imports its supported API from a virtual module:

```tsx
import {
  defineComponent,
  useEffect,
  useState,
} from "@dash-bored/component";

interface Props {
  endpoint: string;
}

export default defineComponent<Props>(({ props, children, host }) => {
  const [status, setStatus] = useState("waiting");

  useEffect(() => {
    void host.http?.request({ url: props.endpoint }).then(() => setStatus("ok"));
  }, [host.http, props.endpoint]);

  useEffect(() => host.actions.register({
    id: "refresh",
    label: "Refresh service health",
    run: async () => {
      await host.http?.request({ url: props.endpoint });
    },
  }), [host.actions, host.http, props.endpoint]);

  return (
    <section>
      {status}
      {children?.type === "tiled" ? children.surface : null}
    </section>
  );
});
```

`defineComponent` gives the component typed props, generic child handles and
read-only descriptors, a render/visibility projection, and a host object. The
virtual API re-exports the supported React hooks and ensures local
bundles share the renderer's one React runtime.

After the project is trusted, the main process compiles an entry with:

```ts
Bun.build({
  target: "browser",
  format: "esm",
  splitting: false,
});
```

A bundler plugin maps React and `@dash-bored/component` to renderer-owned
runtime modules. No output directory is configured, so the runtime consumes
the build's in-memory outputs without writing component bundles to disk. A
component may use contained relative TS, TSX, and CSS imports. Bare package
imports, Node or Electrobun APIs, files outside that component directory, and
unsupported asset types are rejected.

The compiled JavaScript and CSS travel in the project snapshot. The renderer
imports JavaScript through a revisioned blob URL and owns a replaceable style
element for its CSS. Each instance has an error boundary, so one failed local
component does not take down the dashboard.

Local-component hot reload is incremental within one dashboard bundle. An
unchanged compiled revision keeps its mounted component and stylesheet; a
changed revision keeps the previous component visible while the new blob module
loads, installs the replacement stylesheet before the React swap, and removes
the prior stylesheet on the following frame. Other local components therefore
do not pass through loading placeholders just because one bundle changed. A
dashboard switch clears the old bundle scope instead of reusing code across
projects.

This is a convenience boundary, not a hostile-code sandbox. Trusting a project
allows its local component code to execute in the shared application renderer.
The main process still rejects host requests unless their supplied node ID has
the requested permission, but that renderer-supplied identity is not an
authenticated boundary between mutually hostile local components.

## Trust and host capabilities

An untrusted project may be parsed and may render safe built-in layout and
inline content. It cannot compile local code, start a command, read or write a
project file, make an HTTP request, or instantiate a project webview.

The application presents one project-level trust decision with the complete
requested permission set. Trust is keyed by canonical project root and stores
the approved permission set in Electrobun's user-data directory. Reloading with
the same or a smaller permission set preserves trust; adding any permission
invalidates it and requires a new decision. Trust can also be revoked manually.
The main process checks both project trust and the requested node's declared
permission on every privileged RPC.

Per-node permissions shape the host API, protect against accidental use, and
constrain every component equally. They do not isolate trusted local components from one
another: all local code shares one renderer and could forge another node ID by
speaking the internal RPC protocol directly. Project trust is the security
boundary for local code. Strong per-component isolation would require
separate execution realms and authenticated capability channels.

Local components receive only the host methods allowed by their manifest:

```ts
interface ComponentAction {
  id: string;
  label: string;
  description?: string;
  keywords?: string[];
  enabled?: boolean;
  disabledReason?: string;
  confirmation?: {
    title: string;
    message?: string;
    confirmLabel?: string;
  };
  run(): void | Promise<void>;
}

interface LocalComponentHost {
  dashboard: { reload(): Promise<void> };
  actions: { register(action: ComponentAction): () => void };
  filesystem?: {
    readText(path: string): Promise<string>;
    writeText?(path: string, content: string): Promise<void>;
  };
  http?: { request(request: HttpRequest): Promise<HttpResponsePayload> };
  shell?: { run(request: ShellRunRequest): Promise<ShellRunResult> };
  processes?: {
    get(nodeId?: string): ProcessSnapshot | undefined;
    start?(): Promise<ProcessSnapshot>;
    stop?(): Promise<ProcessSnapshot>;
  };
  webview?: { render(request: { url: string; title?: string }): ReactNode };
}
```

Packaged and local renderers receive exactly the same `LocalComponentRenderProps`
shape: typed `props`, generic rendered `children` and handles, and a
`LocalComponentHost`. The host is shaped solely by manifest permissions. No
packaged component receives an API that a local component cannot declare.

Action registration is renderer-local and grants no host permission. A local
action ID begins with an ASCII letter and contains only letters, digits,
underscores, or hyphens. The renderer namespaces it by project revision, node
ID, and local action ID, and rejects simultaneous duplicates from one owner.
Registration returns a disposer intended for a React effect cleanup. The host
also clears all actions owned by an instance when that instance unmounts, the
project reloads, trust is revoked, or the active project changes.

An action may provide a description, search keywords, an unavailable state and
reason, and optional confirmation copy. Its callback runs as trusted local
component code in the shared renderer and can perform privileged work only by
calling that component instance's already-shaped host APIs. Component actions
are intentionally unknown before the component is trusted and mounted; their
metadata is neither cached nor declared in `component.yaml` in this version.

The dogfood `package-scripts` component demonstrates dynamic action discovery:
it reads a configured `package.json`, registers one action for each
string-valued `scripts` entry, and invokes the selected package runner through
`host.shell.run` from the manifest's containing directory. It defaults to the
`packageManager` field when that field names Bun, npm, pnpm, or Yarn, while an
explicit runner prop can override it. These are short bounded shell actions.
Long-running workflows use the generic process resource model described below.

Capability behavior is bounded:

- File reads are UTF-8, confined to the canonical project root, and limited to
  1 MiB.
- Dashboard icon reads are limited to 2 MiB and support SVG, PNG, JPEG, GIF, and
  WebP. Relative icon paths resolve from the owning config bundle and may point
  outside the project root; absolute paths and HTTP(S) URLs are also accepted.
  The main process returns a data URL to the renderer, and icon failures fall
  back to the generic sidebar glyph.
- HTTP accepts only `http:` and `https:` URLs and bounds response size and
  request time.
- Short shell calls bound output and execution time; an optional relative
  working directory must remain inside the project root.
- Capability requests from untrusted projects, undeclared components, unknown
  nodes, or escaped paths fail with a permission or validation diagnostic.

The renderer CSP permits revisioned blob modules and the local websocket origins
needed for Vite, while blocking direct application HTTP requests from component
code. Supported HTTP access goes through the checked host RPC. Embedded
application pages use sandboxed `<electrobun-webview>` elements and receive no
dash-bored RPC bridge.

### Declarative process resources

Any component may declare a supervised process resource. The manifest maps the
resource to props containing its command and, optionally, a project-relative
working directory and string-valued environment:

```yaml
resources:
  process:
    commandProp: command
    cwdProp: cwd
    envProp: env
permissions:
  - process:execute
```

Another component can reference that resource through a prop:

```yaml
references:
  processId:
    resource: process
permissions:
  - process:observe
```

The main process extracts and supervises every declared process resource
generically. Resource nodes require stable IDs; cross-node references are
validated against the resolved tree and IDs are remapped across config links.
Command-palette start/stop actions are derived from these resources, never
from component IDs or a special built-in list.

### Long-running commands

`@dash-bored/command` is the shipped example of an explicit user-action
component. A command never runs
just because a project was opened, trusted, or reloaded.

The main process owns each subprocess and streams stdout/stderr into a bounded
ring buffer. `@dash-bored/terminal` renders that buffer as read-only output; it
is not an interactive PTY. A node cannot have duplicate concurrent runs.
Unchanged command nodes keep their process across a hot reload, while removed
or materially changed command nodes are stopped. On application exit, the main
process attempts graceful termination and then cleans up the whole process
tree.

## Renderer and shipped examples

The initial shipped set is intentionally generic. These are public contract
examples, not privileged component types:

- Core tile branches compose layout; components such as cards may declare
  children presentation but do not own topology or resizing.
- `@dash-bored/text`, `@dash-bored/markdown`, and `@dash-bored/status` display
  safe project information. Markdown does not enable raw HTML.
- `@dash-bored/command` starts and stops a declared process after a user click.
- `@dash-bored/terminal` displays bounded process logs from a referenced process.
- `@dash-bored/file` displays a read-only project file.
- `@dash-bored/env` edits a project-local dotenv file through a key-value or
  bulk/raw editor. Key-value saves preserve comments, blank lines, and
  unrecognized lines; writes are bounded, project-contained, and atomic.
- `@dash-bored/todo-list` edits a small project-owned YAML list containing only
  descriptions, boolean completion state, and tags. It sorts open items first,
  filters by tag, and supports adding, removing, and inline editing items.
- `@dash-bored/webview` embeds a sandboxed application page. Native child
  webviews are initialized only while their tab is visible and are explicitly
  hidden while an already-initialized tab is inactive; the native surface is an
  overlay rather than a DOM descendant, so ordinary CSS `display: none` cannot
  hide it reliably.

Every rendered node exposes a keyboard-accessible context menu, also available
through right-click. It contains Focus, Edit component, Collapse or Expand
component, Copy component path, and Change with agent. Edit component opens the
same schema-driven props and child-metadata dialog used by composition editing.
The popover is rendered in a document-level fixed overlay with viewport
clamping, so isolated or overflowing component frames cannot paint over it.
Focusing a node makes it a virtual root
in the application viewport and provides breadcrumb navigation back to its
configured ancestors; it never rewrites YAML or changes which bundle owns the
node. Copy uses an unambiguous locator such as
`/project/dash-bored/dash-bored.yaml#root.children.layout.first.child.node`.
Resolved nodes
retain both the canonical owning YAML and their YAML-style path, including
nodes reached through standalone config links.

Collapse state is renderer-owned presentation state, persisted locally per
dashboard config path and resolved node ID. It is not a component prop, a YAML
field, or part of a draft save. A collapsed node retains a compact accessible
shell with its component name and an expand action; its rendered body and
descendant components are unmounted so polling and native child surfaces do not
continue consuming dashboard space. Processes remain owned by the main
process, so collapsing a command or terminal does not stop a running command.
Focusing a collapsed node expands it first. This runtime state is separate from
the structural editor's temporary tree-branch collapse state.

Core-owned horizontal tile branches support runtime ratio resizing. Their
project-owned topology contains a normalized first-pane `ratio` between
`0.1` and `0.9`; the renderer applies shared minimum pane sizes while dragging. The
separator is a real grid track with pointer capture, keyboard arrows, Home/End,
and Enter/double-click reset behavior. Runtime drags persist a per-user override
under the active config path and stable layout branch key; the configured ratio remains the
canonical project default, changing that default invalidates an older local
override, and reset removes it. Ratio changes alter CSS tracks without changing
React keys or unmounting either child.

Each split establishes an inline-size container. A horizontal split stacks its
two panes and removes the separator when that specific container becomes
narrow, including when it is nested inside another split; this is independent
of the application window breakpoint. Vertical branches are content-sized flex
flow with no separator, fixed total, or pane overflow. Legacy runtime vertical
ratio/height entries are discarded because they cannot satisfy the surface-only
compression contract.

Resizable surface caps use the same config-path/stable-ID presentation boundary
as collapse state. Pointer movement is retained with window-level move, release,
cancel, blur, and lost-capture cleanup. A cap is applied as `max-height`, so a
component whose content later becomes shorter contracts naturally instead of
showing empty space. The component's direct surface owns unavoidable internal
overflow; organizational ancestors never add another scrollbar. Electrobun's
overlay resize observer follows the resulting surface geometry while the
existing explicit visibility synchronization remains in force.

Change with agent opens a composer that visibly presents the resolved app-wide
command, user text in quotes, and Send as one invocation. The renderer sends
only the selected node ID and user text. The main process re-resolves that node
from the authoritative tree, verifies its owning config is reachable, adds the
project root, config path, component path, ID, reference, dash-bored guidance,
and project-instruction reminder, then starts the configured CLI from the
owning project root. The enriched prompt is passed in
`DASH_BORED_AGENT_PROMPT` and referenced as one quoted shell argument, so user
text is not interpolated into shell syntax. This app-owned, explicit user
action does not grant project component code a capability or embed an AI
provider; dashboard file watching remains responsible for showing accepted
agent edits.

Tabs are keyboard accessible. Splits support horizontal and vertical layouts;
horizontal splits may be recursively nested for tiled layouts and stack based
on their own container width. The application shell also
shows project identity, diagnostics, and a collapsed-by-default project
sidebar. The header exposes the command palette and active-dashboard edit
controls; trust and reload actions remain available from Settings. The main
process persists successfully opened dashboard targets in a user-data
registry. Each entry retains its canonical project root, exact config path,
and configured dashboard name, so the canonical and named bundles can appear
as separate sidebar entries. Each entry also retains its resolved top-level
config icon when available. The sidebar can switch the single active runtime
between those dashboards, add another target through the native chooser, open
application settings, or remove a remembered dashboard.

Application Settings also persists `DASH_BORED_AGENT` in a separate versioned,
owner-only user-data file. The inherited environment value supplies the first
default, with `codex exec` as the fallback. Updating it affects later component
agent launches and later dashboard commands without rewriting project files.

The trash affordance is rendered as a separate keyboard-accessible button on
expanded sidebar rows and is revealed on row hover or focus. The renderer asks
the main process for a typed deletion preview before showing the confirmation
dialog. The preview reports whether the app-owned `project/dash-bored/`
directory exists, which other registered dashboards directly or transitively
link into it, the linked config paths, and whether analysis completed. A
dashboard-only removal is the default. File removal is available only after a
complete scan; broken, unreadable, invalid, cyclic, or otherwise unresolved
config links fail closed. A registered dashboard whose local component bundle
is inside the target files also fails closed because moving those files would
remove code that may access them. Local components outside the target files
are not treated as dependencies of the target.

Each expanded sidebar row also reveals a tree-disclosure button immediately
before the trash affordance. It loads a read-only resolved outline for that
registered dashboard without activating its runtime, then expands the complete
node hierarchy below the row. Selecting an outline node switches to that
dashboard when necessary and uses the existing virtual-root focus model for
navigation. The active dashboard outline follows live snapshots; inactive
outlines are refreshed whenever their disclosure is reopened.

One application process/window runs one active dashboard at a time. The
dashboard list is navigation history, not concurrent execution; switching
dashboards stops the prior dashboard's watcher and supervised processes before
the next target becomes active.

The header's Components button opens the right-hand library without entering a
separate mode. The flyout keeps one searchable catalog for packaged and local
components, offers keyboard insertion and an agent fallback, and supplies
contextual insertion targets plus full-frame node dragging on the rendered
composition. A node drag turns the flyout into a dotted 20%-wide trash
target; dropping there uses the same confirmed removal path as the toolbar.
Each component frame keeps those choices in one compact Add menu with contextual
labels such as “Tile left of Project pulse” or “Insert between Overview and
Configure”; opening the library never renders every possible target across the
dashboard. During a pointer drag, valid frames receive a quiet readiness outline
and only the nearest compatible edge under the pointer becomes a filled spatial
drop target. The source remains in place with a picked-up treatment and the
target renders a compact component-and-destination preview; neither changes
layout geometry or becomes a second topology representation. Header gestures
prevent native text selection before their movement threshold is crossed.
Keyboard movement, Configure, Remove, root replacement, and both-axis
separator resizing use the same topology and draft helpers as pointer
interactions. Composition-active split separators expose a visible grip, while
hover, focus, and drag expose the current first-pane percentage. Runtime ratio
overrides remain local; draft ratio changes are written only to the draft YAML.

Removal requires confirmation, including the size of a removed subtree. Adding
uses the snapshot catalog; a newly selected local component is shown as metadata
until the accepted save reloads and, when trusted, compiles it. Configuration
dialogs trap focus, return it on close, and only the topmost nested dialog reacts
to Escape.

When an effective `DASH_BORED_AGENT` command is configured, the add-component
picker accepts either a catalog search or a natural-language component
description. If no catalog entry matches non-empty text, the results contain
one explicit agent action showing the user's description, configured command,
and complete enriched prompt. Selecting it closes the composition UI (with the
normal discard confirmation for an already-dirty draft), asks the main process to
revalidate the target against the authoritative reachable config, and launches
the configured agent. The prompt tells the agent to use the installed
dash-bored skill when available, build a project-local component for the owning
dashboard, and insert its node at an exact YAML topology path. The prompt remains one
environment-backed shell argument under the same launch boundary as Change
with agent.

Managed child presentation is configured through the declaring component's
manifest schema. A tabs-like component receives generic child handles and
edge metadata; a tab label is stored on its parent-child edge. The editor
validates and edits that metadata declaratively, with no tabs-specific fields,
positional prop synchronization, or component-ID branch.

### Dashboard deletion and project-file cleanup

The project registry is user-data navigation history, while the dashboard
bundles remain project-owned files. Deleting a registry entry therefore never
deletes project files unless the user explicitly selects file removal. The
main-process deletion transaction recomputes the preview, unloads the active
runtime (watcher, process manager, and capability bindings), revokes trust when
file removal is selected, atomically removes the registry entry, and moves only
the canonical top-level `project/dash-bored/` directory to the operating
system Trash. The source project and paths outside that directory are not
targets.

If any step before the Trash move fails, the registry, trust grant, and active
runtime are restored. A failed Trash operation restores the registry and
runtime as well. Named bundles below the target directory are included because
they are part of that app-owned directory; when file cleanup is selected, all
remembered entries for that project root are removed together. Dynamic file
access from trusted local component
code is not statically inferable. The deletion scan therefore reports static
config links and blocks cleanup when registered local component files are
inside the target directory; unrelated component bundles outside the target do
not block removing the target.

### Action registry and command palette

The renderer owns one action registry for the active application window. The
command palette merges three providers:

- application navigation, lifecycle, and dashboard editing actions from shell
  state;
- focus actions for every node in the currently selected dashboard, using the
  same virtual-root navigation as the inline Focus controls;
- start/stop actions derived from every resolved process resource and its
  authoritative process snapshot;
- actions registered by mounted, trusted local component instances.

Known actions remain searchable when unavailable and carry a reason. For
example, configured commands remain visible before project trust, while local
component actions do not exist until their code mounts. Process actions call
the same typed `startProcess` and `stopProcess` RPC used by any component UI;
the palette never executes a shell command directly.

The registry re-resolves an action by ID immediately before invocation, tracks
running IDs to reject duplicate execution, and drops stale registrations.
Trust, revoke, and component-selected sensitive actions use the palette's
confirmation state. Trust confirmation names the complete requested capability
set before calling the existing trust RPC.

The palette is application-scoped. A visible header control and the native
application-menu accelerator `CommandOrControl+K` open it; the menu sends a
typed main-to-renderer message. This is not an operating-system-global hotkey.
Search and keyboard interaction are implemented in the renderer without an
external palette dependency.

## Reload and failure model

The main process recursively watches the active bundle directory. This covers
its `dash-bored.yaml`, lock, local components, and named bundles below it.
Events are debounced and trigger a fresh load/validate/compile pipeline.
Absolute references outside that directory are loaded on validation or reload,
but changes there do not independently trigger the active dashboard watcher.

A fully valid revision replaces the current tree and local bundles atomically.
If a reload fails, the renderer keeps the last known-good dashboard and adds
actionable diagnostics from the rejected revision. Process reconciliation runs
only after validation succeeds. This avoids destroying a useful running
dashboard because of a temporary YAML or TSX edit.

After React receives an accepted dashboard update, the renderer compares each
node with the previous accepted tree by stable node ID. Direct prop or component
changes, inserted nodes, and moved nodes receive a short non-interactive polish
overlay; removal highlights the nearest surviving parent. A successfully loaded
local-component code or style revision highlights every mounted instance when
the renderer swaps in that revision, rather than while the previous revision is
still visible. Descendant content changes do not also animate every layout
ancestor. Large batches use a bounded visual-order stagger, initial loads and
semantic no-op reloads do not animate, and the treatment follows the operating
system's reduced-motion preference. The effect never changes a node's React key,
so unchanged component state is preserved across YAML reloads. Native Electrobun
webviews remain above DOM effects and therefore show the treatment on their
surrounding shell only.

Local render exceptions are isolated at component-instance boundaries. Host and
process failures update snapshots and diagnostics without crashing the main
process.

## CLI surface

The package exposes a `dash-bored` executable through its `bin` field:

```text
dash-bored init [name ...] [--project <path>]
dash-bored install-cli
dash-bored install-skill [project] [--global]
dash-bored validate [project] [--json]
dash-bored inspect [project]
dash-bored open [project]
```

- `init` and `init .` target the canonical bundle in the current project;
  `--project <path>` selects another project root. Initialization creates the
  required files and empty component directory, uses the bundle name in a valid
  guided dashboard with an editable bundle-local `.env` file, an
  agent-customization command that uses the app-wide `DASH_BORED_AGENT`, and a
  command that installs the packaged dash-bored skill into the project. It
  never overwrites existing files.
- `init <name ...>` joins every positional name as another safe directory
  level and creates a complete standalone bundle at that leaf, including its
  own config, lock, environment file, and components directory. It does not
  modify the canonical dashboard. Positional values are always names; the
  former positional-project form is not supported.
- `install-skill [project]` copies the packaged skill into
  `.agents/skills/dash-bored/` below the selected project. With `--global`, it
  instead uses the current user's home directory, so the shared skill is
  available across projects. Both scopes create `.claude/skills/dash-bored` as
  a symlink or Windows directory junction to the same canonical payload for
  Claude Code. The shared `.agents/skills/` location is the cross-client Agent
  Skills convention used by Codex, Gemini CLI, Cursor, Copilot CLI, and
  OpenCode. The skill uses only the portable `name` and `description`
  frontmatter; `agents/openai.yaml` is optional presentation metadata rather
  than a runtime dependency. The skill, metadata, and local-component
  reference are text assets embedded in the standalone executable.
  Installation is idempotent when files and aliases match and refuses to
  replace modified files or conflicting paths. `--global` does not accept a
  project path.
- `install-cli` creates a symlink from `~/.local/bin/dash-bored` to the CLI
  bundled in the application on macOS or Linux. It is an explicit user action,
  reports when that directory is absent from `PATH`, and refuses to replace an
  existing file or a link to another target. The Windows app still carries the
  CLI for in-app use, but this shell-link command is not yet supported there.
- `validate` runs project, manifest, resolver, schema, and local compilation
  validation. It emits stable diagnostics and a non-zero status on errors.
- `inspect` writes JSON describing the resolved tree, the complete component
  catalog, component metadata used by the tree, requested permissions, and
  diagnostics. Agents read `componentCatalog[].manifest.propsSchema`, `children`,
  and `permissions` before editing instead of relying on static examples.
- `open` creates any missing project artifacts, validates the resulting
  dashboard, launches the packaged desktop application when invoked by its
  embedded or linked CLI (and the development application from source), and
  forwards termination signals.

`bun run build:cli` uses Bun's standalone-executable build to inline the CLI,
its core dependencies, and the skill text assets into `dist/tools/dash-bored`.
Electrobun copies `dist/tools/` into the application resources. At main-process
startup dash-bored prepends that resource directory to the inherited `PATH`
and publishes the exact CLI and app-launcher paths. Consequently every built-in
command, long-running process, local-component shell call, and CLI agent
launched from the dashboard can resolve the matching CLI without a global
installation. The optional shell link resolves back into the application, so
`dash-bored open` can locate the packaged launcher.

Files are published atomically and never overwritten. Explicit `init` remains
strict: an existing configuration, lock, or environment file is an error.
Opening is idempotent and fills in missing required artifacts while preserving
those that already exist.

## macOS prerelease distribution

The initial distribution boundary is an unsigned Apple Silicon prerelease for
macOS 14 or newer. Linux, Windows, and Intel Mac artifacts are not produced.
`package.json` is the single source of truth for the application version; the
Electrobun configuration, standalone CLI, release tag check, packaged app, and
update metadata must all agree with it.

Pull requests and pushes to `main` run QA and dashboard validation on GitHub's
`macos-15` Apple Silicon runner. A `v*` tag starts the release workflow, but the
tag must exactly equal `v<package.json version>`. The workflow creates a draft
GitHub prerelease so publishing remains an explicit maintainer decision.

`bun run build:release` uses the Electrobun canary channel, which keeps these
early installs separate from a future stable, signed application. Unlike a
normal worktree build, it strips `DASH_BORED_PROJECT_ROOT`,
`DASH_BORED_CONFIG_PATH`, development-server,
port, and instance variables before packaging. This prevents a local worktree
identifier or project path from becoming part of a release.

The macOS bundle uses the project-owned dashboard artwork in `assets/icon.svg`.
Its committed `assets/icon.iconset/` renditions are converted to
`Contents/Resources/AppIcon.icns` by Electrobun, while `CFBundleIconFile`
references `AppIcon`; that pair is what Finder and the Dock use for the app.

`bun run release:prepare -- --tag <tag>` fails closed unless all of the
following hold:

- the host is Apple Silicon macOS and the tag matches the package version;
- the build app, expanded update app, and DMG app carry the release bundle
  identifier and version, an arm64 launcher, and the expected Finder/Dock icon
  metadata and `.icns` resource;
- Electrobun's update manifest describes the same macOS arm64 canary and names
  the generated full-app archive;
- the expanded application contains a runnable, version-matched standalone
  `dash-bored` CLI; and
- the DMG mounts successfully and contains the app plus its Applications link.

The preparation step stages a versioned `*-macos-arm64-unsigned.dmg`, a SHA-256
checksum file, and release notes. Only the DMG and checksum become GitHub
Release assets. Electrobun's update archive and metadata are validation inputs,
not a public update channel; application auto-update remains disabled.

Because the DMG is neither Developer ID signed nor notarized, first launch may
require the user's explicit **Open Anyway** decision in macOS Privacy & Security.
Release packaging still applies a valid ad-hoc bundle signature and verifies it
on the app, update archive, and DMG copies; this prevents macOS from reporting a
malformed bundle as damaged while retaining the unsigned-prerelease boundary.
Release documentation must state that friction and must not present the build
as a trusted broad-consumer installer. Signing and notarization can later be
inserted into the same build-and-verify boundary without changing the project
or bundled-CLI contracts.

## Deliberate exclusions

The following are not part of this architecture yet:

- npm, Git, registry, or marketplace component resolution
- marketplace component search, publishing, or shared templates; direct
  in-process component generation without the configured external agent
- Linux, Windows, and Intel Mac distribution; Windows shell-link installation
- Developer ID signing, notarization, or application auto-update
- interactive PTY support, general project-file editing, and a general process viewer
- simultaneously active multi-project views or windows
- embedded model-provider infrastructure or agent-specific SDK integration
- claims of hostile-code or per-component isolation for trusted local components

These can be added only after their contracts are reflected here and remain
consistent with the product principles in `IDEA.md`.
