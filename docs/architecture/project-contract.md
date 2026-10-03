# dash-bored - Architecture: Project contract

## Project contract

### Layout and project arguments

All dash-bored-owned project files live together:

```text
project/
└── .dash-bored/
    ├── dash-bored.yaml
    ├── dash-bored-lock.yaml
    ├── README.md
    ├── install-app.sh
    ├── .env
    ├── prompts/
    │   └── implement-todo.md
    └── components/
        └── external/
            └── service-health/
```

A project may also contain named dashboard bundles. Each repeats the complete
contract and can be copied, opened, validated, or repaired independently:

```text
project/
└── .dash-bored/
    └── arvid/
        ├── dash-bored.yaml
        ├── dash-bored-lock.yaml
        ├── README.md
        ├── install-app.sh
        ├── .env
        └── components/
```

Named bundles are organization, not inheritance. The canonical and named
configs do not implicitly share lock entries, component directories, nodes, or
defaults. Their only composition mechanism is an explicit component reference
to another standalone bundle path.

The agent tool's `validate`, `inspect`, and `app open` project arguments may
identify the project root, a standalone bundle directory, or its
`dash-bored.yaml`. `app open` renders exactly the selected bundle; the tool
resolves the selected config path and passes it to the running app over the
agent-control channel. Resolution does not
walk unrelated ancestor directories. Paths are canonicalized before they are
used as trust keys or containment boundaries. The desktop project chooser uses
the selected directory's shape: a nested `.dash-bored/dash-bored.yaml` selects
the project root, while a direct `dash-bored.yaml` selects that standalone
bundle. The same chooser therefore opens either kind of dashboard without
merging standalone configs into one another.

Opening a project, either through the desktop project chooser or the agent
tool's `app open`, ensures that this complete project contract exists. The application
creates the `.dash-bored/` directory, default configuration, empty lock file,
starter environment file, onboarding `README.md`, `install-app.sh` helper, and
`components/` directory when they are missing. It
creates only missing artifacts and never replaces an existing configuration,
lock, or environment file, so a partially initialized project is repaired
without discarding project state.
README and installer helper files are project-owned and never overwritten,
including during explicit initialization. They use the same exclusive atomic
publication and rollback as the configuration, lock, and environment files.
Atomic writes use a unique sibling temporary file and publish by hard link for
create-only files or rename for replacements; the owning operation retains
directory creation, mode selection, validation, and rollback.
The README explains the portable bundle and links to GitHub Releases. Its
command runs the adjacent helper from the project root; named bundles receive
their own correct path and chooser instructions. The helper reads the adjacent
YAML's top-level numeric `schemaVersion`, discovers all published GitHub release
pages (including canary prereleases, excluding drafts), and chooses the highest
semantic version whose metadata declares that exact `dashboardContract`,
canary channel, and macOS arm64 identity. Minimum migratable contract alone is
not direct load compatibility. The helper verifies the metadata's DMG SHA-256
before opening the installer with normal macOS approval; no matching release
or an invalid download fails without opening an installer. It uses macOS's
built-in JXA, curl, and shasum; app installation remains drag-and-drop in the UI.
The starter `.env` is created with owner-only permissions for project-local
component and command variables, and is prepopulated with an editable starter
value for `DASH_BORED_AGENT`. `DASH_BORED_AGENT_PROMPT` is generated once when
the setup action launches. `DASH_BORED_AGENT`
is also app-wide: the main process persists its application setting in the
Electrobun user-data directory, publishes it to dashboard command environments,
and exposes it in Settings. Clearing that setting removes the app-published
override, allowing the owning bundle's `.env` value to win.

At launch, each command or shell call resolves the `.env` beside its owning
`dash-bored.yaml`, including when a node comes from a named or linked bundle.
The effective order is component request, app setting, inherited process
environment, then bundle defaults. When the app setting is cleared, the
remaining environment resolution uses the inherited process value or owning
bundle default. Editing a bundle `.env` refreshes the
displayed effective agent value while preserving unchanged running processes;
changing app settings refreshes the same display through the runtime without
mutating the main process environment.
Directories selected in the desktop chooser are always treated as project
roots, including when the selected directory itself is named `.dash-bored`.

`dash-bored init arvid` creates the complete named bundle under
`.dash-bored/arvid/`: configuration, lock file, environment file, README,
installer helper, and local component directory.
Additional positional names each add a directory level, so `dash-bored init
arvid cicd` creates `.dash-bored/arvid/cicd/`. Slash-separated names such as
`people/arvid` remain supported. The command neither changes the canonical
dashboard nor adds a reference to the new bundle.

### Dashboard configuration

`dash-bored.yaml` has one recursive root node:

```yaml
schemaVersion: 3
name: Example project
icon: ./assets/icon.svg
root:
  id: project-layout
  component: "@dash-bored/group"
  children:
    axis: horizontal
    ratio: 0.4
    first:
      node:
        id: welcome
        component: "@dash-bored/markdown"
        props:
          content: "# Example project"
    second:
      node:
        id: agent-setup
        component: "@dash-bored/group"
        children:
          node:
            id: show-install-dash-bored-skill
            component: "@dash-bored/conditional"
            props:
              command: 'test -f ".agents/skills/dash-bored/SKILL.md"'
              invert: true
            children:
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
  schemaVersion: 3;
  name: string;
  icon?: string;
  theme?: string;
  themeMode?: "light" | "dark" | "system";
  root: ComponentNode;
}

interface ComponentNode {
  id?: string;
  component: string;
  props?: Record<string, unknown>;
  children?: ComponentChildren;
  persistOnFocus?: boolean;
}

type ComponentChildren = ComponentChildLayout | ComponentChildEdge[];

interface ComponentChildEdge {
  node: ComponentNode;
  metadata?: Record<string, unknown>;
}

type ComponentChildLayout =
  | ComponentChildEdge
  | {
      axis: "horizontal";
      ratio?: number;
      first: ComponentChildLayout;
      second: ComponentChildLayout;
    }
  | {
      axis: "vertical";
      ratio?: never;
      first: ComponentChildLayout;
      second: ComponentChildLayout;
    };
```

A tiled child boundary contains a child edge directly, or a recursive split
with `axis`, `first`, and `second`. Horizontal `ratio` is optional and defaults
to `0.5`; vertical topology uses document flow and rejects `ratio`. A managed
child boundary contains an array of child edges. The manifest still declares
which presentation it accepts, and validation checks the configured shape
against that declaration. Component manifests keep schema version 2.
Manifest reference declarations accept `resource: process` for provider-node
IDs and `resource: action` for stable action references. A declaration's key
is a prop path where `*` matches every array item: `items.*.action` names the
`action` field of each item, and a trailing `*` (`actions.*`) makes each item
itself a reference. Validation, linked-tree remapping, and legacy migration all
walk these paths through `referenceLocations` in `src/core/tree-links.ts`. Action references use
explicit node IDs (`focus:<node-id>`, `process:<node-id>`, or
`component:<node-id>:<action-id>`), never a tree position. Schema-v3 dashboards
temporarily resolve legacy `${root...}` references and report a deprecation
warning (see [Legacy migrations](#legacy-migrations)); the v4 migration will
rewrite them and remove that compatibility.
Resolution is scoped to the owning YAML bundle, then linked-tree namespacing
remaps the node-bearing segment of focus, process, and component-action IDs.

Manifests may also declare `actions: [{id, label, description?, args?}]`;
`args` is JSON Schema. A present `actions` array opts into registration checks,
including an empty array. Component action references are checked against the
target node's manifest. Palette and Settings include declared actions before
mount with an unavailable reason. Omitting `actions` preserves dynamic legacy
registration for components that discover IDs at runtime.

An action-bearing prop may keep the argument-free string form or use
`{ run: <reference>, with: { ... } }`. The loader validates `with` against the
target action's declared `args` schema. A button passes those typed values through
the shared action executor; matching string values prefill choice steps, while
unmatched choices remain interactive. The app action `agent:prompt` accepts an
optional `prompt` string (the composer's editable input), an optional
`template` name, and optional `vars` of strings, numbers, or booleans; list item
templates must still be whole values. A button invocation opens the existing
agent composer with the resolved command, template, and rendered prompt for
review; the user must press Send.

### Prompt templates

Agent requests are rendered from prompt templates. The app ships two:
`project` (work in the project, requested from a component; the `agent:prompt`
default) and `dashboard` (change the dashboard from a component; used by Change
with agent). A bundle adds templates as `prompts/<name>.md` beside its
`dash-bored.yaml`; a file named like a shipped template replaces it for that
bundle, and `dash-bored/<name>` always means the shipped one. Names are
lowercase letters, digits, and hyphens. Files are regular files of at most
32 KiB, at most 64 per bundle; symlinks are rejected.

```markdown
---
description: Implement a backlog item
scope: project        # or dashboard; default project
input: optional       # or required (default): Send needs user text
vars:
  id: Backlog item ID
env: [LINEAR_TEAM]
---
{{> dash-bored/project}}

Implement backlog item {{vars.id}}, then mark it done.
```

The body is a logic-less Mustache subset: `{{name}}`, sections
`{{#name}}…{{/name}}` (render when truthy, once per array entry),
inverted sections `{{^name}}…{{/name}}`, and includes `{{> name}}`. Values are
inserted verbatim, and a section or include tag alone on its line removes that
line. Templates see `input`, `vars.<name>`, `varList` (`name`/`value` entries),
`hasVars`, `env.<KEY>`, `project.root`/`name`, `dashboard.config`/`directory`,
and `component.id`/`reference`/`path`/`name`. A bundle template must declare
every var it uses or accepts and every environment key it reads; shipped
templates accept any vars and list them as context. Only declared environment
keys are rendered, and the user sees their values in the composer preview
before sending.

Loading reports `PROMPT_TEMPLATE_INVALID` for malformed files, unknown fields,
undeclared references, and unknown includes, and
`COMPONENT_ACTION_ARGUMENTS_INVALID` when an `agent:prompt` names an unknown
template or passes undeclared vars. Scope decides the app's follow-up, not the
wording: `dashboard` requests are validated with at most one repair and diff
the bundle; `project` requests diff the whole project.

The same representation is used for YAML, drafts, resolved trees, and saved
configuration. There is no shorthand expansion or alternate topology model.

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

`persistOnFocus` is an optional composition marker, defaulting to false. When a
descendant is focused, marked ancestors remain as the effective parent chain;
at those retained boundaries, marked direct sibling component edges remain as
complete navigation subtrees. Unmarked ancestors and siblings are projected
away. Managed edge order and metadata survive, tiled splits retain their axis
and ratio when both sides survive, and one-sided splits collapse. The current
focus target itself remains renderer-owned per-user state and never enters YAML.

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
is no separate grid model. The host resolves each debounced draft through the
same resolver as saved configuration and returns its tree, diagnostics, and
trusted compiled local components. The renderer displays that resolved tree;
it does not guess identities from the previous tree. An unresolved draft shows
diagnostics in place, with Save disabled and Cancel still available. Responses
belong to their edit session and draft version; superseded responses are ignored.
The root toolbar exposes replacement with any catalog
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
Frame menus also expose Move up and Move down when a compatible sibling exists;
they use `siblingMoveTarget` and the same operation planner as pointer movement.
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
Dashboard component frames render a small drag handle for every movable non-root
node, so packaged and project-local components are draggable without requiring
component code to add a handle. Only the deepest hovered frame reveals its
generated handle and component menu; keyboard focus can reveal a focused
control independently. Hidden ancestor controls are non-hit-testing, and
component content has no drag semantics.
During a node drag, the open flyout becomes 20% of the viewport dotted trash
drop target containing only an accessible trash icon. Component menus and
composition controls are omitted for the duration, and a drop routes through
the existing confirmed removal and draft mutation path.

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
The session also retains the exact config-link occurrence ID. The host checks
that it still reaches the owning file and namespaces the draft under that
boundary, so replacing its root cannot change the enclosing link identity.
When a file is linked more than once, its path alone cannot choose a preview.
`NodePath` is the internal editing locator; YAML-style paths remain an external
display and agent-tool contract.

### Lock file

`dash-bored-lock.yaml` is required and consumed on every load:

```yaml
lockfileVersion: 1
components: {}
```

Built-ins and files below the project's `components/` directory are not locked,
except for external components: each submodule below `components/external/`
is pinned in the lock file as
`components: { <name>: { url, commit, path } }`, where `commit` is the exact
40-hex SHA and `path` is `components/external/<name>` matching the entry key.
A pin change alters the code under trust and re-runs the permission-union
trust check. Only an actually empty external directory is reported as an
uninitialized checkout (`COMPONENT_EXTERNAL_UNINITIALIZED`) with a pointer at
Sync in the component library; discovery descends into initialized checkouts
(monorepo-style layouts resolve deeper manifests as
`./components/external/<name>/<path…>`), and a checkout with no manifest
anywhere reports `COMPONENT_EXTERNAL_NO_MANIFEST`. Neither silently resolves
to something else.

Theme selection and appearance are optional top-level `theme` and `themeMode`
metadata. Each field inherits the app default independently when omitted.
Application Settings can edit these fields for any registered dashboard without
opening that dashboard or changing the active runtime.
Bundle-local packages and the optional `themes` lock section follow the [theme contract](themes.md).

### Legacy migrations

Every rewrite of state written by an earlier release lives in
`src/migrations/`, one file per legacy form, and each file is scheduled for
deletion at dashboard schema v4. The directory is layer-neutral: files depend
only on `shared/`, `core/`, and Node, so core, main, the agent tool, and the
renderer call the same owner instead of carrying their own copies.

| File | Legacy form | Runs in |
| --- | --- | --- |
| `action-references.ts` | Schema-v3 positional action targets (`focus:${root.children…}`). After reference validation, `resolveComponentTree` rewrites each one to the node ID it resolves to and reports `COMPONENT_ACTION_REFERENCE_DEPRECATED`; an unresolvable path reports `COMPONENT_ACTION_REFERENCE_INVALID`. The rewrite changes the loaded config's props in place, so edit sources and saves persist stable IDs. | core, every load |
| `app-theme-reference.ts` | An app default theme saved as a bare `./themes/<name>`. Main's `getAppSettings` pins it to `project:<active-config>:./themes/<name>` once the active dashboard provides that package, and persists the result. Until then app settings keep it readable. The renderer holds no migration logic; it re-reads settings when the active dashboard or theme catalog changes while the default is still unpinned. | main, settings read |
| `skill-payloads.ts` | Skill installs without a `skill-version.json` receipt. A complete exact match of one published payload is adopted as owned; anything else stays a conflict. | agent tool `install-skill`, app skill refresh |
| `cli-link.ts` | The `~/.local/bin/dash-bored` link earlier releases created, removed only when its receipt proves ownership. | main, app start |
| `todo-ids.ts` | Todo props without stable `id`s, or with duplicate ones (`@dash-bored/todo-list` and list `todos`). `migrateTodoItems` backfills a `todo-<uuid>` ID for each and keeps unique existing IDs. Node-free: it imports only `shared/todo.ts`, because the renderer bundles it. | renderer, `todoItemsFromProps` and the todo-list component |
