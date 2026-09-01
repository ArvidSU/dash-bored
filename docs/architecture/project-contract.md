# dash-bored - Architecture: Project contract

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
component and command variables, and is prepopulated with editable starter
values for `DASH_BORED_AGENT` and `DASH_BORED_AGENT_PROMPT`. `DASH_BORED_AGENT`
is also app-wide: the main process persists its application setting in the
Electrobun user-data directory, publishes it to dashboard command environments,
and exposes it in Settings.
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
                    id: show-install-dash-bored-skill
                    component: "@dash-bored/conditional"
                    props:
                      command: 'test -f ".agents/skills/dash-bored/SKILL.md"'
                      invert: true
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
                              command: 'dash-bored install-skill .'
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

`@dash-bored/conditional` is a transparent layout boundary that accepts exactly
one tiled child. It runs its declared bounded shell `command` while the
containing panel is visible and projects the child only when the command exits
successfully; `invert: true` shows the child when it fails. Optional `cwd`,
`env`, `timeoutMs`, and `pollIntervalMs` props follow the same project-root and
bounded-shell rules as other host-backed components. Before trust, while a
check is unavailable, or after a check error, it fails open and keeps the child
available.

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
All renderer pointer gestures use one active, cancellation-safe pointer session:
its window listeners are installed only for the active gesture, preserve pointer
capture and WebKit mouse-release fallback, and are removed on release, cancel,
blur, lost capture, replacement, or owner unmount. Gesture-specific commit
semantics remain local to node movement, library insertion, split resizing, and
height resizing.
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

