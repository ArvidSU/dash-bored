# dash-bored - Architecture: Renderer and shipped examples

## Renderer module map

`src/renderer/app/App.tsx` is the orchestrator (app state, project actions,
composition orchestration, workspace render). Everything else lives in focused
modules under feature directories:

- `app/` — shell and orchestration: `App.tsx`, `app-shell.tsx`,
  `AppDialogs.tsx` (all dashboard modals), `app-utils.ts` (pure
  snapshot/task/project helpers, edit-session types), `main.tsx` (entry),
  `use-dashboard-view-state.ts` (renderer-owned presentation state).
- `panels/` — app-level views: `DiagnosticsPanel.tsx`, `TrustPanel.tsx`,
  `EmptyProject.tsx`, `AgentPromptPanel.tsx`, `AgentActivity.tsx`,
  `SettingsPanel.tsx`, `CommandPalette.tsx`.
- `composition/` — dashboard editing: `dashboard-editor.ts` (draft engine),
  `composition-*.ts(x)` (targets, labels, dnd, placement, movement,
  operation, preview, interaction-controller), `ComponentCompositor.tsx`,
  `CompositionFlyout.tsx`, `DashboardEditor.tsx`, `DashboardOutlineTree.tsx`.
- `render/` — node rendering: `NodeRenderer.tsx` (recursive rendering plus
  the staggered update-polish batch hook), `ComponentFrame.tsx` (per-node
  frame: menu, collapse shell, height resizing, drag/drop affordances),
  `ComponentWebviewSurface.tsx`, `SplitLayout.tsx` + `split-layout.ts`,
  `local-host.tsx` (permission-gated `LocalComponentHost` factory),
  `local-components.tsx`.
- `lib/` — shared model and services: `component-children.ts`,
  `component-height.ts`, `component-view-state.ts`, `component-updates.ts`,
  `component-library.ts`, `actions.ts`, `action-providers.ts`,
  `rpc-client.ts`, `ui-harness-host.ts`, `virtual-root.ts`, `chart-data.ts`,
  `clipboard.ts`, `env.ts`, `safe-url.ts`, `todo.ts`, `pointer-session.ts`,
  `right-drawer.tsx` (shared Agent work / component-library drawer shell,
  with an optional header-actions slot), `editor-modal.tsx` (centered modal
  layer above the drawer; the drawer shell yields outside/Escape/focus to it).
- `builtins/` — `index.tsx` (lazy `packagedComponent` aggregator) plus one
  directory per shipped component (`types.ts`, `shared.tsx` helpers).

Placement rules for new modules: app chrome goes in `app/`, a full-screen
view in `panels/`, draft/topology editing in `composition/`, per-node
rendering in `render/`. Anything imported from two or more of those goes in
`lib/`. A new `@dash-bored/*` component gets `builtins/<name>/index.tsx` plus
registration in `builtins/index.tsx` and `src/core/builtins.ts`. Vite entries
stay at the root (`index.html`, `ui-harness.html` → `app/main.tsx`). Update
this map when adding a module.

Pure helpers and their contracts:

- `app/app-utils.ts` — pure snapshot/task/project helpers, edit-session types,
  per-dashboard empty states.
- `composition/composition-labels.ts` — human labels for drop targets and dragged payloads.
- `composition/composition-targets.ts` — pure drop-zone/validity/default-target resolution
  over a draft config (`createCompositionTargets`, memoized per render).
- `render/local-host.tsx` — permission-gated `LocalComponentHost` factory.
- `render/ComponentFrame.tsx` — per-node frame: menu, collapse shell, height
  resizing, drag/drop affordances.
- `render/NodeRenderer.tsx` — recursive node rendering plus the staggered
  update-polish batch hook.
- `app/use-dashboard-view-state.ts` — renderer-owned presentation state
  (collapse, split ratios, height caps, virtual-root focus) with per-dashboard
  localStorage persistence; never part of a draft.
- `panels/DiagnosticsPanel.tsx`, `panels/TrustPanel.tsx`, `panels/EmptyProject.tsx`,
  `panels/AgentPromptPanel.tsx`, `panels/SettingsPanel.tsx` — app-level panels.
- `app/AppDialogs.tsx` — all dashboard modals (composition, removal, agent,
  discard, deletion).

## Renderer and shipped examples

The initial shipped set is intentionally generic. These are public contract
examples, not privileged component types:

- Core tile branches compose layout; components such as cards may declare
  children presentation but do not own topology or resizing.
- `@dash-bored/markdown` and `@dash-bored/status` display safe project
  information. Markdown does not enable raw HTML. Markdown accepts either
  inline `content` or a project-relative `path`; preview is the default view,
  while Raw / edit exposes an explicit editor with Save/Cancel behavior. Inline
  edits update the owning dashboard draft, and path-backed edits use the
  declared bounded filesystem capability.
- `@dash-bored/command` opens a persistent interactive terminal after a user
  click, remembers its configured command as a quick action, and displays its
  terminal session.
- `@dash-bored/conditional` runs a bounded shell condition while its panel is
  visible and projects one tiled child on success, with optional inversion for
  "show until done" setup actions.
- `@dash-bored/env` edits a project-local dotenv file through a key-value or
  bulk/raw editor. Key-value saves preserve comments, blank lines, and
  unrecognized lines; writes are bounded, project-contained, and atomic.
- `@dash-bored/todo-list` edits its `todos` prop in the owning
  `dash-bored.yaml`, containing only descriptions, boolean completion state,
  and tags. It sorts open items first, filters by tag, and supports adding,
  removing, and inline editing items without reloading the component. Its
  interactions use the normal draft Save/Cancel boundary.
- `@dash-bored/webview` embeds a sandboxed application page. Native child
  webviews are initialized only while their tab is visible and are explicitly
  hidden while an already-initialized tab is inactive. The native surface is an
  overlay rather than a DOM descendant, so the component first reserves a
  normal document-flow placeholder and creates the native tag only after that
  slot has a real size. The enclosing shell's measured in-flow width and height
  override Electrobun's native-tag defaults before creation and whenever its shell resizes, so the overlay
  remains inside the component rectangle rather than preserving a default
  child-view frame. Capture-phase scroll updates explicitly resync it through
  nested layouts and page scrolling. Ordinary CSS `display: none` cannot hide
  it reliably.

Every rendered node exposes a keyboard-accessible context menu, also available
through right-click. It contains Focus, Edit component, Collapse or Expand
component, Copy component path, and Change with agent. Edit component opens the
same schema-driven props and child-metadata dialog used by composition editing.
Components may also replace only their own declared props through the generic
dashboard host. That change begins or updates the owning dashboard draft; it
never reloads the project or bypasses Save/Cancel.
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
process, so collapsing a command does not stop a running command.
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

The app owns one dashboard-only agent harness around that same configured CLI.
It records a bounded in-memory task for each component-change or component-build
request and shows a compact item with the user's prompt, start time, and a
Working/Not working state in an app-level Agent work drawer across dashboard
navigation. Clicking an item opens a three-tab modal: the regular command
component against that task's PTY-backed process, a bounded git diff for the
owning `dash-bored/` bundle, and the complete contextualized command with a copy
action. The terminal includes retained output after the process exits. Tasks
retain their component/YAML locator, request, contextualized prompt, command, and
whether the owning dashboard changed while the CLI was running. A process exit
or observed file change is never represented as agent success: the UI asks the
user to review the dashboard. This harness does not accept arbitrary commands,
manage agent sessions, persist work across app quit, or add a provider SDK;
quitting dash-bored stops its child agent processes. The Agent work panel and
the component library flyout are mutually exclusive right-side drawers sharing
one shell (`lib/right-drawer.tsx`: slide transition, outside/Escape dismiss,
focus trap and restore, unified header/body geometry below the modal layer);
the library's drag fold-away and node-removal trash mode stay library-only.
The generated starter remains an ordinary `@dash-bored/command`. It invokes the
`dash-bored agent "${DASH_BORED_AGENT:-codex exec}"` wrapper with its
request in `DASH_BORED_AGENT_PROMPT`; the wrapper runs that resolved agent
command with the prompt as one environment-backed argument. Agent work
recognizes that generated command process by its stable node ID and shows its
existing process lifecycle alongside harness-launched requests.

Tabs are keyboard accessible. Splits support horizontal and vertical layouts;
horizontal splits may be recursively nested for tiled layouts and stack based
on their own container width. The application shell also
shows project identity, diagnostics, and a collapsed-by-default project
sidebar. When diagnostics are present, their details header offers Fix with
agent; the main process re-reads the current diagnostics and launches the
configured dashboard agent against the owning config, including when the
dashboard tree is unavailable. The header exposes the command palette and active-dashboard edit
controls; trust and reload actions remain available from Settings. The main
process persists successfully opened dashboard targets in a user-data
registry. Each entry retains its canonical project root, exact config path,
and configured dashboard name, so the canonical and named bundles can appear
as separate sidebar entries. Each entry also retains its resolved top-level
config icon when available. The sidebar can switch the single active runtime
between those dashboards, add another target through the native chooser, open
application settings, or remove a remembered dashboard.

Application Settings has General and Actions tabs. General owns app behavior,
including the command-palette shortcut and `DASH_BORED_AGENT`; Actions presents
the same currently known action catalog as the palette, with search, favorite
toggles, and per-action shortcut recording. The separate versioned, owner-only
user-data file persists those preferences. The inherited agent environment
value supplies the first default, with `codex exec` as the fallback. Updating it
affects later component agent launches and later dashboard commands without
rewriting project files.

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
navigation. Each outline branch has its own disclosure control, while the
currently focused virtual root is highlighted and exposed as the current
location to assistive technology. The active dashboard outline follows live
snapshots; inactive outlines are refreshed whenever their disclosure is
reopened.

One application process/window runs one active dashboard at a time. The
dashboard list is navigation history, not concurrent execution; switching
dashboards stops the prior dashboard's watcher and supervised processes before
the next target becomes active.

The header's Components button opens the right-hand library without entering a
separate mode. The flyout keeps one searchable catalog for packaged, local,
and external components, offers keyboard insertion and an agent fallback, and supplies
contextual insertion targets plus full-frame node dragging on the rendered
composition. Every movable non-root frame supplies a small drag handle and a
component menu; only the deepest hovered frame reveals those controls, while
keyboard focus can reveal a focused control independently. Hidden ancestor
controls do not intercept pointer input, and component content has no drag
semantics. Custom components do not need special markup.
A node drag turns the flyout into a dotted 20%-wide trash target; dropping
there uses the same confirmed removal path as the toolbar.
Each component frame keeps those choices in one compact Add menu with contextual
labels such as “Tile left of Project pulse” or “Insert between Overview and
Configure”; opening the library never renders every possible target across the
dashboard. During a pointer drag, valid frames receive a quiet readiness outline
and the pointer region decides the advertised target: the centered region
offers a filled drop-inside target when the hovered container accepts children
(center appends, so a Tabs center drop becomes the last tab), while the edge
bands offer the nearest compatible sibling boundary for tiling beside the
component. The source remains in place with a picked-up treatment and the
target renders a compact component-and-destination preview; neither changes
layout geometry or becomes a second topology representation. Handle gestures
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
one explicit agent action using the user's description. Selecting it closes the composition UI (with the
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

## Dashboard deletion and project-file cleanup

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

## Action registry and command palette

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

Favorites are stored by stable action ID, so a temporarily unmounted component
action can regain its favorite state when it registers again. Search first
removes non-matches, then favorites sort ahead of the remaining results and use
a star marker. The palette and Settings both update the same preference.
Shortcuts use one portable `Mod` representation, dispatch through the normal
action executor, and do not run while the user is typing into an editable
control. Assigning an already-used combination moves it to the new target. The
native View menu mirrors configured accelerators for its command-palette and
reload entries; all other action bindings are application-window shortcuts.

The application provider also exposes `Reload app`, which reloads the current
renderer window and remains available even while another action is pending or
no dashboard is open. The native application menu binds the same lifecycle
operation to `CommandOrControl+Shift+R`. This is distinct from `Reload
dashboard`, which asks the main process to reread the active project while
preserving the last known-good renderer when project validation fails.
