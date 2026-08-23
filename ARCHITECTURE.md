# dash-bored - Architecture

## Status and architectural rules

This document describes the v1 implementation. It is the source of truth for
the system shape; [IDEA.md](./IDEA.md) is the source of truth for product
intent. [initial_impl.md](./initial_impl.md) is historical inspiration only.

dash-bored is a local-first component-tree runtime. A project owns a small YAML
tree and optional project-specific React components. The desktop application
loads that tree, validates it, resolves each component, and renders the result
without containing project-specific integrations itself.

The v1 implementation deliberately has three boundaries:

1. The CLI creates and inspects project configuration.
2. The Electrobun main process owns files, trust, compilation, processes,
   network access, and application lifecycle.
3. The React renderer owns presentation and can reach privileged behavior only
   through typed Electrobun RPC.

## Runtime topology

The application pins Electrobun 2.0.1 and uses its Bun main-process mode:

```text
project/dash-bored/                 # canonical standalone bundle
  dash-bored.yaml
  dash-bored-lock.yaml
  components/
  arvid/                            # optional named standalone bundle
    dash-bored.yaml
    dash-bored-lock.yaml
    components/
          |
          v
Electrobun Bun main process
  - locate, parse, validate, and watch project files
  - validate and atomically persist explicit in-app dashboard edits
  - resolve built-in and local components
  - compile trusted local TSX with Bun.build()
  - enforce trust and component permissions
  - own subprocesses, file access, and HTTP requests
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

The main window uses Electrobun's `hiddenInset` title-bar style. The renderer
keeps only a small transparent drag region around the native traffic-light
controls, allowing the main shell to provide the visual surface underneath
without adding a second title treatment. The sidebar reserves that small area
so its brand mark does not collide with the controls. The main process clamps
resizes below 350px, and the renderer keeps the header single-row at that
minimum by shrinking and ellipsizing content instead of wrapping actions.

The main process publishes a complete `ProjectSnapshot` at startup and after
each accepted change. It also publishes individual process snapshots while a
command is running. The renderer treats those snapshots as authoritative; it
does not read project files or spawn commands directly.

Snapshots also carry the parsed dashboard configuration, a SHA-256 revision of
the source file, and a component catalog. The catalog contains every built-in
plus bounded, containment-checked local manifest discovery. Invalid local
manifests are represented as unavailable catalog entries with diagnostics, so
they can be explained in the picker without breaking an otherwise valid tree.

## Project contract

### Layout and project arguments

All dash-bored-owned project files live together:

```text
project/
└── dash-bored/
    ├── dash-bored.yaml
    ├── dash-bored-lock.yaml
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
        └── components/
```

Named bundles are organization, not inheritance. The canonical and named
configs do not implicitly share lock entries, component directories, nodes, or
defaults. Their only composition mechanism is an explicit component reference
to another standalone bundle path.

The `validate` and `inspect` project arguments may identify the project root, a
standalone bundle directory, or its `dash-bored.yaml`. A directory passed to
`open` is the project root; `open` also accepts an explicit `dash-bored.yaml`
path. `init` instead takes an optional bundle name and an explicit `--project`
path. Resolution does not walk unrelated ancestor directories. Paths are
canonicalized before they are used as trust keys or containment boundaries.

Opening a project, either through `dash-bored open` or the desktop project
chooser, ensures that this complete project contract exists. The application
creates the `dash-bored/` directory, default configuration, empty lock file,
and `components/` directory when they are missing. It creates only missing
artifacts and never replaces an existing configuration or lock file, so a
partially initialized project is repaired without discarding project state.
Directories selected in the desktop chooser are always treated as project
roots, including when the selected directory itself is named `dash-bored`.

`dash-bored init arvid` creates the complete named bundle under
`dash-bored/arvid/`: configuration, lock file, and local component directory.
Additional positional names each add a directory level, so `dash-bored init
arvid cicd` creates `dash-bored/arvid/cicd/`. Slash-separated names such as
`people/arvid` remain supported. The command neither changes the canonical
dashboard nor adds a reference to the new bundle.

### Dashboard configuration

`dash-bored.yaml` has one recursive root node:

```yaml
schemaVersion: 1
name: Example project
root:
  component: "@dash-bored/stack"
  props:
    gap: medium
  slots:
    children:
      - id: welcome
        component: "@dash-bored/markdown"
        props:
          content: |
            # Example project
            The dashboard is ready.
```

The public configuration types are:

```ts
interface DashboardConfig {
  schemaVersion: 1;
  name: string;
  root: ComponentNode;
}

interface ComponentNode {
  id?: string;
  component: string;
  props?: Record<string, unknown>;
  slots?: Record<string, ComponentNode | ComponentNode[]>;
}
```

The root is any `ComponentNode`; it does not need to be a layout component and
may therefore describe a dashboard containing only one button or display.
Node IDs must be unique across the tree. When an ID is omitted, the loader
derives a stable ID from the node's tree path. A stateful or actionable node,
such as `@dash-bored/command`, must have an explicit ID so its state can be
reconciled safely across reloads.

The loader rejects duplicate YAML keys, unsupported schema versions, unknown
structural keys, malformed recursive nodes, duplicate IDs, excessive nesting,
unknown components, invalid props, and invalid slot cardinality. Diagnostics
carry a stable code, severity, message, and file/path location where available.
Slot names begin with an ASCII letter and contain only letters, digits,
underscores, or hyphens.

### In-app structural editing

The renderer can create an edit-session draft from the snapshot configuration.
The draft uses the same recursive nodes and declared slots as YAML: there is no
separate grid model. The root toolbar exposes replacement with any catalog
component, while descendants can move between compatible slots. Matching root
slots carry their children across; incompatible nested content is reported
before it is dropped from the draft. Empty slots and insertion boundaries
expose add targets; props are edited from the manifest JSON Schema with a JSON
fallback.

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
External npm and Git components are intentionally unavailable in v1, so any
non-empty external component entry is reported as unsupported rather than
silently ignored. This keeps the file format ready for reproducible external
resolution without pretending that resolution exists today.

## Component system

### Standalone dashboard paths

A component reference outside the built-in `@dash-bored/*` namespace and the
bundle-local `./components/*` directory may resolve to another standalone
dashboard bundle or its `dash-bored.yaml`. For example,
`component: "./arvid"` in the canonical config loads
`dash-bored/arvid/dash-bored.yaml`. This is a component boundary, not a
preprocessing directive.

Paths may be absolute or relative; relative paths resolve from the directory
containing the source `dash-bored.yaml`. The target uses its own
`dash-bored.yaml`, `dash-bored-lock.yaml`, and `components/` directory and
renders inside the space allocated to the referencing component. No nodes,
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
schemaVersion: 1
id: service-health
name: Service health
description: Shows project service health.
entry: ./index.tsx
propsSchema:
  type: object
  additionalProperties: false
slots:
  children:
    required: false
    multiple: true
permissions:
  - network:http
```

`propsSchema` is JSON Schema. Each slot declares whether it is required and
whether it accepts multiple nodes. Supported permission names are:

- `filesystem:read`
- `network:http`
- `process:execute`

Generic tree validation runs before component-specific props and slots are
validated. The requested project permission set is the union of permissions
declared by every resolved local component and privileged built-in.

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

export default defineComponent<Props>(({ props, slots, host }) => {
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

  return <section>{status}{slots.children}</section>;
});
```

`defineComponent` gives the component typed props, rendered slots, and a host
object. The virtual API re-exports the supported React hooks and ensures local
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

This is a convenience boundary, not a hostile-code sandbox. Trusting a project
allows its local component code to execute in the shared application renderer.
The main process still rejects host requests unless their supplied node ID has
the requested permission, but that renderer-supplied identity is not an
authenticated boundary between mutually hostile local components.

## Trust and host capabilities

An untrusted project may be parsed and may render safe built-in layout and
inline content. It cannot compile local code, start a command, read a project
file, make an HTTP request, or instantiate a project webview.

The application presents one project-level trust decision with the complete
requested permission set. Trust is keyed by canonical project root and stores
the approved permission set in Electrobun's user-data directory. Reloading with
the same or a smaller permission set preserves trust; adding any permission
invalidates it and requires a new decision. Trust can also be revoked manually.
The main process checks both project trust and the requested node's declared
permission on every privileged RPC.

Per-node permissions shape the host API, protect against accidental use, and
constrain built-ins. They do not isolate trusted local components from one
another: all local code shares one renderer and could forge another node ID by
speaking the internal RPC protocol directly. Project trust is the security
boundary for local code in v1. Strong per-component isolation would require
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
  filesystem?: { readText(path: string): Promise<string> };
  http?: { request(request: HttpRequest): Promise<HttpResponsePayload> };
  shell?: { run(request: ShellRunRequest): Promise<ShellRunResult> };
}
```

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

Capability behavior is bounded:

- File reads are UTF-8, confined to the canonical project root, and limited to
  1 MiB.
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

### Long-running commands

`@dash-bored/command` represents an explicit user action. A command never runs
just because a project was opened, trusted, or reloaded.

The main process owns each subprocess and streams stdout/stderr into a bounded
ring buffer. `@dash-bored/terminal` renders that buffer as read-only output; it
is not an interactive PTY. A node cannot have duplicate concurrent runs.
Unchanged command nodes keep their process across a hot reload, while removed
or materially changed command nodes are stopped. On application exit, the main
process attempts graceful termination and then cleans up the whole process
tree.

## Renderer and built-ins

The initial built-in set is intentionally generic:

- `@dash-bored/tabs`, `@dash-bored/split`, `@dash-bored/stack`, and
  `@dash-bored/card` compose layout.
- `@dash-bored/text`, `@dash-bored/markdown`, and `@dash-bored/status` display
  safe project information. Markdown does not enable raw HTML.
- `@dash-bored/command` starts and stops a declared process after a user click.
- `@dash-bored/terminal` displays bounded process logs.
- `@dash-bored/file` displays a read-only project file.
- `@dash-bored/webview` embeds a sandboxed application page. Native child
  webviews are initialized only while their tab is visible and are explicitly
  hidden while an already-initialized tab is inactive; the native surface is an
  overlay rather than a DOM descendant, so ordinary CSS `display: none` cannot
  hide it reliably.

Every rendered node exposes a focus action. Focusing a node makes it a virtual
root in the application viewport and provides breadcrumb navigation back to
its configured ancestors; it never rewrites YAML or changes which bundle owns
the node. This is the same presentation model for an ordinary leaf, a layout
subtree, or a referenced dashboard.

Tabs are keyboard accessible. Splits support horizontal and vertical layouts
and collapse to a stacked layout in narrow windows. The application shell also
shows project identity, trust state, reload state, diagnostics, and a collapsed-
by-default project sidebar. The main process persists projects that have been
opened successfully in a user-data registry. Each entry retains its canonical
project root and last configured dashboard name. The sidebar can switch the
single active runtime between those projects, add another project through the
native chooser, or open application settings.

One application process/window runs one active project at a time in v1. The
project list is navigation history, not concurrent project execution; switching
projects stops the prior project's watcher and supervised processes before the
next project becomes active.

The expanded project row exposes an edit control. Edit mode adds a sticky
Save/Cancel toolbar and per-node drag, configure, and remove controls. Removal
requires confirmation, including the size of a removed subtree. Native drag
and drop is supplemented by same-slot up/down controls for keyboard users.
Adding uses the snapshot catalog; a newly selected local component is shown as
metadata until the accepted save reloads and, when trusted, compiles it.

The built-in tabs component keeps the dashboard editor structural: its preview
shows the tab panels and their child-node controls, while Configure component
contains the tab fields. From that modal users can add a panel through the
normal component picker, rename a tab, and remove a tab with confirmation. Tab
names are stored in the `labels` prop in child order. The editor keeps that
positional list synchronized when tab children are inserted, removed, or
reordered, while unnamed existing entries continue to render as `Tab N` until
explicitly named.

### Action registry and command palette

The renderer owns one action registry for the active application window. The
command palette merges three providers:

- application navigation and lifecycle actions from shell state;
- start/stop actions derived from resolved `@dash-bored/command` nodes and
  their authoritative process snapshots;
- actions registered by mounted, trusted local component instances.

Known actions remain searchable when unavailable and carry a reason. For
example, configured commands remain visible before project trust, while local
component actions do not exist until their code mounts. Process actions call
the same typed `startProcess` and `stopProcess` RPC used by their built-in UI;
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

Local render exceptions are isolated at component-instance boundaries. Host and
process failures update snapshots and diagnostics without crashing the main
process.

## CLI surface

The package exposes a `dash-bored` executable through its `bin` field:

```text
dash-bored init [name ...] [--project <path>]
dash-bored validate [project] [--json]
dash-bored inspect [project]
dash-bored open [project]
```

- `init` and `init .` target the canonical bundle in the current project;
  `--project <path>` selects another project root. Initialization creates the
  required files and empty component directory, uses the bundle name in a valid
  welcome dashboard, and never overwrites existing files.
- `init <name ...>` joins every positional name as another safe directory
  level and creates a complete standalone bundle at that leaf, including its
  own config, lock, and components directory. It does not modify the canonical
  dashboard. Positional values are always names; the former positional-project
  form is not supported.
- `validate` runs project, manifest, resolver, schema, and local compilation
  validation. It emits stable diagnostics and a non-zero status on errors.
- `inspect` writes JSON describing the resolved tree, component metadata,
  requested permissions, and diagnostics.
- `open` creates any missing project artifacts, validates the resulting
  dashboard, launches the Electrobun development application, and forwards
  termination signals.

Files are published atomically and never overwritten. Explicit `init` remains
strict: an existing configuration or lock file is an error. Opening is
idempotent and fills in missing required artifacts while preserving those that
already exist.

## Deliberate v1 exclusions

The following are not part of this architecture yet:

- npm, Git, registry, or marketplace component resolution
- component search, describe, create, publishing, or shared templates
- installer publication, signing, notarization, or application auto-update
- interactive PTY support, general project-file editing, and a general process viewer
- simultaneously active multi-project views or windows
- custom AI or agent infrastructure
- claims of hostile-code or per-component isolation for trusted local components

These can be added only after their contracts are reflected here and remain
consistent with the product principles in `IDEA.md`.
