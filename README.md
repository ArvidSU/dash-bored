# dash-bored

dash-bored is a local-first desktop cockpit that a project describes with YAML
and optional project-specific React components. The application supplies the
component runtime and controlled host capabilities; each project supplies the
workflow and domain knowledge.

The repository is an early developer build. It uses Electrobun 2.0.1 with a Bun
main process and a Vite/React renderer. Read [product vision](./docs/IDEA.md)
for product principles and [ARCHITECTURE.md](./ARCHITECTURE.md) for the
architecture index and complete runtime and security contracts.

## License

[MIT](./LICENSE)

## Install on macOS

Unsigned prereleases support **Apple Silicon** Macs running **macOS 14 or
newer**. Linux, Windows, Intel Macs, signing, notarization, and automatic
updates are intentionally deferred.

1. Download the macOS DMG and `SHA256SUMS.txt` from the latest
   [GitHub Release](https://github.com/ArvidSU/dash-bored/releases).
2. Optionally place both files in the same directory and verify the download:

   ```sh
   shasum -a 256 -c SHA256SUMS.txt
   ```

3. Open the DMG and drag **dash-bored-canary** to **Applications**.
4. Open the application and choose the project directory you want to use.

These early builds are not Developer ID signed or notarized, so macOS may block
the first launch. Try to open the app once, then open **System Settings →
Privacy & Security**, select **Open Anyway**, and confirm. Apple documents this
explicit override in [Safely open apps on your
Mac](https://support.apple.com/en-us/102445). Only do this for an artifact you
downloaded from this repository and, preferably, verified with the published
checksum.

The application already contains its version-matched `dash-bored` CLI, so Bun
is not required. The starter dashboard can optionally expose that CLI at
`~/.local/bin/dash-bored` for external shells.

The installed application includes a custom dash-bored icon for Finder, the
Applications folder, and the Dock.

## Developer setup

Install [Bun](https://bun.sh/) and clone the repository. The project pins its Bun
and Electrobun versions; a global Electrobun install is not needed.

```sh
bun install --frozen-lockfile
bun run setup
bun link
```

For a new Git worktree, use the one-step setup instead:

```sh
bun run worktree:setup
```

It installs the locked dependencies, prepares Hutch, creates an ignored
`.env.worktree` with an isolated port and Electrobun development identity, and
validates the dashboard. After that, `bun run dev` is ready to use. If
`bun run dev` is already running, setup reuses its prepared development files
instead of waiting for Hutch's build lock. If another desktop development
process is already running, `bun run qa:fast` provides the non-locking
typecheck, test, and renderer-build path once Hutch is prepared.

`bun link` exposes the local `dash-bored` CLI. Without a link, invoke the same
entrypoint with `bun run dash-bored -- <command>`.

Useful repository commands:

```sh
bun run dev             # Vite development renderer + watched Electrobun app
bun run dev:desktop     # built renderer + watched Electrobun main process
bun run build:cli       # standalone CLI embedded in desktop builds
bun run styles:dead     # report app CSS class/ID hooks without source references
bun run typecheck
bun test
bun run build:renderer
bun run build           # local canary application build
bun run icon:generate   # regenerate the committed macOS iconset from its SVG
bun run build:release   # clean unsigned Apple Silicon release build
bun run release:prepare # verify artifacts and stage release files
bun run qa              # typecheck, tests, and renderer production build
bun run qa:fast         # non-locking typecheck, tests, and renderer build
bun run ui:fixture      # isolated renderer fixture at http://127.0.0.1:5488/ui-harness.html
bun run test:renderer-ui # browser-driven pointer and keyboard verification for that fixture
bun run native:probe    # isolated manual Electrobun webview visibility/dimensions probe
```

`styles:dead` scans `src/renderer/styles.css` against runtime source under
`src/renderer`, including `src/renderer/builtins/**`. It reports class and ID
hooks with no static reference, while listing state/value-prefixed hooks
assembled dynamically for manual review. Add `--check` when a non-zero exit
code is wanted for definitely dead hooks.

### Visual UI verification

`ui:fixture` runs the actual React application, CSS, component compositor, and
dashboard chrome against a deterministic in-memory host. It needs no
Electrobun process, does not use the worktree's Vite port, and is therefore a
fast visual proof surface for coding agents when a desktop dev process is busy
or inaccessible. Review it at a normal desktop viewport and at `390×844`; it
supports sidebar, tabs, component-library, and composition interactions.

`test:renderer-ui` starts and tears down its own Vite process and drives Chrome
against the fixture. It verifies renderer interactions and the in-memory host
contract (draft, Save, Cancel, rejected drop, and revision conflict), but it is
still **renderer-only** evidence. It uses `/Applications/Google Chrome.app` by
default; set `DASH_BORED_BROWSER_EXECUTABLE` when Chrome lives elsewhere.

`native:probe` first checks the source-level visibility/dimension contract, then
opens a separate Electrobun app and Vite server on port `5499` (or
`DASH_BORED_NATIVE_PROBE_PORT`). It refuses a busy port and never attaches to,
reuses, or terminates another developer's watcher. Toggle its native webview
manually and confirm it hides and returns at the right dimensions. This is a
native smoke aid, not OS-input automation; it does not establish general
desktop interaction coverage. The repository has no native desktop-input test
driver, and this command intentionally does not fake one. When recording other
native evidence, confirm
the header config path matches the checkout before recording a screenshot or
accessibility state.

GitHub Actions runs QA on an Apple Silicon macOS runner. Pushing a tag that
exactly matches `v<package.json version>` builds and verifies the unsigned DMG,
generates its checksum and install notes, and creates a draft GitHub prerelease.
Publishing that draft remains an explicit maintainer action.

Packaged desktop builds contain a standalone, version-matched `dash-bored` CLI.
The app prepends that embedded tool to `PATH` for dashboard commands and agents
it launches, so users do not need a separate CLI installation. The starter
dashboard also offers an explicit `dash-bored install-cli` action that creates
an idempotent link at `~/.local/bin/dash-bored` for use from external shells;
it refuses to replace an existing file or different link.

## Start a project dashboard

Launch the desktop application and select a project directory. Once you have
optionally installed the bundled CLI link, you can also open a project root
from a shell:

```sh
cd /path/to/project
dash-bored open .
```

Opening through the CLI or the desktop project chooser creates any missing
dash-bored files, without overwriting existing files:

```text
project/
└── dash-bored/
    ├── dash-bored.yaml
    ├── dash-bored-lock.yaml
    ├── .env
    └── components/
```

The generated dashboard is immediately valid and combines a short guided tour,
a sampler of the available component primitives, and a setup action that asks your
chosen CLI coding agent to tailor the dashboard to the project. It uses
`codex exec` by default; set the app-wide `DASH_BORED_AGENT` command in
**Settings → Dashboard agent**. A newly initialized dashboard also prepopulates
its environment editor with editable `DASH_BORED_AGENT` and
`DASH_BORED_AGENT_PROMPT` values. The setup command invokes the packaged
`dash-bored agent "${DASH_BORED_AGENT:-codex exec}"`, so the wrapper runs the
same resolved agent command while Agent work follows its process alongside later
dashboard changes. Every rendered component has a context menu
with Focus, Edit component, Copy component path, and Change with agent. The
Edit component action opens the declared props and child metadata editor. The
last action shows the resolved command before sending and enriches your request with the owning
dashboard and exact component path. **Agent work** in the header keeps the
dashboard-only launch visible while it runs, including its output, exit state,
and an observed dashboard change; review the result rather than treating those
signals as proof that an external agent completed the request. Each Agent work
item shows the user's prompt, start time, and Working/Not working state; clicking
it opens Terminal, Diff, and Command tabs. Diff is scoped to the owning
`dash-bored/` folder, while Command shows the full contextualized invocation
with a copy action. When configuration diagnostics are present, **Fix with
agent** asks the configured CLI to repair the
owning dashboard and includes the current reported issues, even when the tree
cannot render. Adjacent actions optionally expose the
bundled CLI to external shells, install the skill globally with
`dash-bored install-skill --global`, or install it for this project with
`dash-bored install-skill .`. The global form writes the portable guidance and
component-authoring reference to `~/.agents/skills/dash-bored/`; the project
form writes to `.agents/skills/dash-bored/`. Both create
`.claude/skills/dash-bored` as a link to the same canonical payload. Repeated
installs are safe, and modified installed files or conflicting paths are never
overwritten.
You can also create these files without
opening the app by running
`dash-bored init .`; unlike `open`, explicit initialization fails if a
configuration, lock, or dashboard environment file already exists.

Set a dashboard-specific sidebar icon directly in its `dash-bored.yaml`:

```yaml
schemaVersion: 2
name: Example project
icon: ../assets/icon.svg
root:
  component: "@dash-bored/markdown"
  props:
    content: "Ready"
```

The icon may be a relative or absolute image path, or an HTTP(S) URL. It is
loaded after the project is trusted; missing or unsupported artwork falls back
to the generic dashboard glyph. You can edit the dashboard name and this icon
from the app's dashboard editor; clearing the icon field restores the generic
glyph. Changes are written when you save the dashboard draft.

Create a standalone named dashboard for a person or workflow with:

```sh
dash-bored init arvid
# or initialize it in another project
dash-bored init arvid --project /path/to/project
```

This creates all four bundle artifacts independently of the main dashboard:

```text
project/dash-bored/arvid/
├── dash-bored.yaml
├── dash-bored-lock.yaml
├── .env
└── components/
```

The command does not edit `project/dash-bored/dash-bored.yaml` or automatically
link the new dashboard into it. Each positional name adds another directory
level, so `dash-bored init arvid cicd` creates `dash-bored/arvid/cicd/`.
Safe slash-separated names such as `dash-bored init people/arvid` remain
supported; every leaf is a complete bundle.

To check or inspect a dashboard:

```sh
dash-bored validate .
dash-bored validate . --json
dash-bored inspect .
```

`validate` exits non-zero when it finds errors. `inspect` emits JSON containing
the resolved tree, requested permissions, diagnostics, and a `componentCatalog`
for every built-in and discovered local component. Each catalog manifest is the
machine-readable contract for its rendering mode, JSON Schema props, children
contract, and required permissions. Agents use this version-matched catalog instead of guessing from
examples; invalid local components remain in the catalog with diagnostics.

`validate` and `inspect` accept a project root, a standalone bundle directory,
or the path to its `dash-bored.yaml`. `open` accepts the same three forms and
renders exactly the bundle selected by the path. For example:

```sh
dash-bored open ./dash-bored/arvid
# equivalent:
dash-bored open ./dash-bored/arvid/dash-bored.yaml
```

The app receives the selected config path separately from the project root, so
opening a named bundle does not fall back to the canonical dashboard. `init`
uses `--project <path>` to select another project root because its positional
argument is the optional bundle name.
Running the desktop app without a project presents a project chooser; selecting
an uninitialized project creates the same root-level `dash-bored/` structure
before loading it. A selected folder containing a nested `dash-bored/` is the
project root, even when that folder is itself named `dash-bored`. The same
**Add dashboard** chooser
also opens standalone bundles: select a directory containing
`dash-bored.yaml`, and that bundle is rendered directly without merging it into
the canonical dashboard. A selected directory containing a nested
`dash-bored/` directory continues to open as a project root. Each selected
config is remembered as its own sidebar entry, so the canonical dashboard and
named bundles from the same project can be switched independently.

## Configure a dashboard

`dash-bored/dash-bored.yaml` contains one recursive component node:

```yaml
schemaVersion: 2
name: Example project
root:
  children:
    type: tiled
    layout:
      type: split
      axis: horizontal
      ratio: 0.5
      first:
        type: child
        child:
          node:
            id: intro
            component: "@dash-bored/markdown"
            props:
              content: |
                # Development
                Project controls and status live here.
      second:
        type: child
        child:
          node:
            id: api-status
            component: "@dash-bored/status"
            props:
              label: API
              state: unknown
```

Each node supports:

- `component`: a built-in ID or local path; required.
- `id`: a tree-unique stable identity; optional for display-only nodes and
  required for stateful/actionable nodes.
- `props`: data validated by the component's JSON Schema.
- `children`: either tiled topology (`layout`) or managed items. Tiled leaves
  wrap a node as `{ type: child, child: { node, metadata? } }`; managed
  children use `{ type: managed, items: [...] }`.

The `root` is a normal component node. A dashboard may use a layout tree, but
it may just as well have one command button, status, or project component as
its root. In the app, any rendered component can also be focused as a temporary
virtual root; breadcrumbs return to its configured ancestors without changing
the YAML.

The initial built-ins are:

- Composition: `@dash-bored/group` for transparent child-surface projection,
  plus core-owned tiled branches and managed child presentation.
- Display: `@dash-bored/markdown` and `@dash-bored/status`.
- Charts: `@dash-bored/chart` for static YAML data and
  `@dash-bored/live-chart` for polling JSON data.
- Host-backed: `@dash-bored/command`, `@dash-bored/conditional`,
  `@dash-bored/env`, `@dash-bored/todo-list`, and
  `@dash-bored/webview`.

These shipped components are examples of the public component contracts, not
privileged types. Local components can declare the same child contracts,
process resources, references, and permissions.

`@dash-bored/markdown` accepts either inline `content` or a project-relative
`path`. It opens in pretty Markdown preview by default; `Raw / edit` exposes
the source editor, with Save/Cancel behavior. Inline saves update the owning
dashboard draft, while path-backed saves write the bounded project file.

`@dash-bored/group` is an ordinary transparent component boundary with
`renderMode: layout`: it accepts
the core-tiled child surface and projects those children without becoming a
layout engine. Use it when a multi-component panel needs a component boundary;
card is not required. Split topology and resize behavior remain app-owned.

Core-owned horizontal split branches use a drag and keyboard separator while
retaining a checked-in default:

```yaml
children:
  type: tiled
  layout:
    type: split
    axis: horizontal
    ratio: 0.4
    first: { type: child, child: { node: ... } }
    second: { type: child, child: { node: ... } }
```

Normal horizontal split drags are a resettable per-user override. Opening the
component-library flyout is read-only; the first composition change starts a
draft. The same separator then changes the draft `ratio`, which becomes the
project default only after Save. Arrow keys resize by small steps, Shift-arrow
uses a larger step, Home/End move to the allowed extremes, and Enter or
double-click resets. Narrow horizontal split containers stack automatically.
Vertical branches remain intrinsic-height document flow and never add a nested
pane scrollbar.

Visible component surfaces start at their full intrinsic height. Their bottom
edge can be dragged upward, or adjusted with Arrow Up/Down, to set a smaller
per-user maximum height; a surface never expands beyond its content. Enter,
End, or double-click restores full height. The surface chrome remains fixed and
its content scrolls inside it. Transparent `renderMode: layout` components and
linked-config boundaries have no height control, and the dashboard document
continues growing as more components are added.

`@dash-bored/env` takes a relative `path` prop, reads a project-local dotenv
file, and provides a key-value editor with a bulk/raw mode. Saving requires
project trust because the component requests both `filesystem:read` and
`filesystem:write`; comments, blank lines, and unrecognized lines remain in
place when editing through the key-value view.

`@dash-bored/todo-list` stores its `todos` array directly in the component's
dashboard YAML props. Each item contains only `description`, `done`, and
`tags`; the component provides status sorting, tag filtering, add/remove
actions, and inline description/tag editing. Interactions update the normal
dashboard draft, so Save or Cancel remains the persistence boundary.

Charts use a shared `{ labels, series }` model. `@dash-bored/chart` renders
static line or bar data from YAML, while `@dash-bored/live-chart` polls an HTTP
JSON endpoint using `network:http`. Its endpoint can be absolute HTTP(S) or an
app-relative path such as `/metrics/chart.json`; it also supports an optional
dot-separated `dataPath` and pauses polling when its containing tab is hidden. Both keep
rendering the last valid live result when a refresh fails.

`@dash-bored/conditional` accepts one tiled child and a bounded shell `command`.
The child is projected when the command exits successfully; set `invert: true`
to show it until the check succeeds. Checks poll only while their panel is
visible and fail open before trust or when the host cannot complete a check.
Use it for setup actions that should disappear after they are complete, such as
the generated CLI and Agent Skill installers.

### Compose standalone dashboards

Named and main configs are standalone bundles. They do not inherit from one
another or share their lock file, environment file, or local `components/`
directory. To present
one inside another, use the target bundle path as a component reference:

```yaml
id: arvid-dashboard
component: "./arvid"
```

The path may identify the target bundle directory or its `dash-bored.yaml`.
Paths may be absolute or relative; a relative path is resolved from the
directory containing the YAML config with the reference. The target dashboard
renders within the component's available space using its own config, lock,
environment, and local components.

A missing or moved target produces an error in that component only, leaving
the containing dashboard usable. dash-bored deliberately does not repair
broken relative links: checked-in config organization remains under user
control. Named bundles below the active bundle are covered by its recursive
file watcher; an absolute target outside that tree is refreshed on the next
manual or otherwise-triggered reload.

The lock file is also required:

```yaml
lockfileVersion: 1
components: {}
```

Keep `components` empty in this version. npm, Git, registry, and marketplace
component resolution are not implemented; built-ins and local components do
not need lock entries.

The application watches the configuration, lock file, component manifests, and
component source. A valid edit replaces the current dashboard. An invalid edit
leaves the last known-good dashboard visible and adds diagnostics.

### Compose a dashboard in the app

Select **Components** in the header to open the right-hand library. It lists
the complete packaged and project-local catalog, with search, descriptions,
child contracts, permissions, provenance, and unavailable diagnostics. Use an
**Insert** button for keyboard-accessible insertion or drag a card onto a
contextual dashboard target. Drag existing component frames to move them;
keyboard arrows provide sibling reordering. Empty boundaries, managed-child
positions, root replacement, and horizontal/vertical/both-axis tiled targets
come from the target manifest, so invalid targets are not offered.

Hover or focus a component to reveal its compact toolbar. **Add** opens the
available insertion positions with labels tied to nearby components instead of
covering the dashboard with every possible action. While dragging, compatible
frames are outlined and the nearest left, right, above, below, or inside region
becomes the visible drop target. Horizontal split grips remain visible while
composing; hover, focus, or drag one to see the current first-pane percentage.
Visible component surfaces expose their own bottom-edge control for
downward-only height compression; layout-only boundaries do not.

Pick up an existing component from anywhere on its frame to move it. During a
component drag, the fly-out becomes a 20%-wide dotted trash target with
only a trash icon; dropping there opens the existing removal confirmation.
Component menus and composition controls are hidden for the duration of this
dropper-style interaction.

Configure edits component props through `propsSchema`. New managed edges expose
their parent's generic `children.metadataSchema`; edge metadata moves with the
child. If search finds no suitable catalog entry, the flyout retains the
**Build with agent** path.

Opening or closing a clean flyout does not create a draft. The first insertion,
move, removal, replacement, metadata edit, or horizontal separator resize creates a
renderer-only draft. **Save dashboard** validates the whole owning tree,
checks the source revision, and atomically writes it; **Cancel** discards the
whole draft. If `dash-bored.yaml` changes outside the app, save is rejected
instead of overwriting that newer source. Focused config-link content edits the
linked bundle that owns it.

Expand the project sidebar and use a dashboard row's tree button to inspect its
read-only component outline. Branches can be collapsed independently, and the
node that is currently serving as the dashboard's virtual root is highlighted.
Selecting a node focuses it in the dashboard without changing its YAML.

Native webviews are hidden through their visibility contract while the flyout,
drop targets, or dialogs are active because Electrobun surfaces are overlays,
not DOM descendants. Ordinary DOM dashboard interaction remains available where
it does not conflict with the composition affordances.

### Remove a dashboard

Expand the project sidebar, then hover a dashboard row or focus it with the
keyboard to reveal its trash button. Removing a dashboard deletes its entry
from dash-bored’s remembered dashboard registry; this is the default and leaves
the project files untouched.

The confirmation dialog previews direct and transitive standalone-config links
from other remembered dashboards, including the affected config paths. If the
dependency scan is incomplete because a link is broken, unreadable, or a
registered dashboard's local component files are inside the files being
removed, project file removal is disabled. Otherwise, you may select **Also
move project files to Trash**. This moves only the app-owned
`project/dash-bored/` directory (and
its named bundles, components, lock files, and environment files) to the OS
Trash. Source files elsewhere in the project are never removed. Removing the
active dashboard unloads its watcher, supervised processes, and trust state;
the next remembered dashboard is selected automatically when one exists.

The accepted configuration is written back as canonical YAML, so comments and
hand formatting are not preserved. Adding a component that requests a new
capability saves the configuration but returns the project to restricted mode
until the expanded permission set is trusted.

Press <kbd>Command-K</kbd> on macOS or <kbd>Ctrl-K</kbd> elsewhere to open the
command palette. It searches application navigation, remembered dashboards,
every node in the currently selected dashboard for virtual-root focus,
all declared process resources, and actions contributed by active components.
Settings is split into **General** and **Actions**. General lets you change the
palette shortcut and app behavior. Actions lists the same currently available
palette actions: search them, assign an app-local keyboard shortcut, or mark an
action as a favorite. You can also toggle its star directly in the palette.
Favorites appear before other matching results but remain subject to the active
search and the action's normal availability and confirmation rules. Assigning a
shortcut already in use moves that combination to the newly selected target.
Choose <strong>Reload app</strong> there, or press <kbd>Command-Shift-R</kbd> on
macOS (<kbd>Ctrl-Shift-R</kbd> elsewhere), to reload the app window when the
renderer needs a fresh start. This is separate from <strong>Reload dashboard</strong>,
which only rereads the active project's configuration.

## Author a project component

Create a directory below the project's component root:

```text
project/dash-bored/components/service-health/
├── component.yaml
├── index.tsx
└── styles.css                 # optional
```

Define its metadata, props, children contract, and least-privilege permissions in
`component.yaml`:

```yaml
schemaVersion: 2
id: service-health
name: Service health
description: Checks the development service.
entry: ./index.tsx
renderMode: surface
propsSchema:
  type: object
  additionalProperties: false
  required:
    - endpoint
  properties:
    endpoint:
      type: string
children:
  min: 0
  max: 10
  presentation:
    type: tiled
    axes: both
permissions:
  - network:http
```

`renderMode` defaults to `surface`. Declare `layout` when the component is an
organizational boundary whose height follows its descendants rather than an
independently resizable surface.

Implement the browser component with the virtual runtime API:

```tsx
import {
  defineComponent,
  useEffect,
  useState,
} from "@dash-bored/component";
import "./styles.css";

interface Props {
  endpoint: string;
}

export default defineComponent<Props>(({ props, host }) => {
  const [summary, setSummary] = useState("Checking…");

  useEffect(() => {
    let active = true;

    void host.http
      ?.request({ url: props.endpoint, timeoutMs: 5_000 })
      .then((response) => {
        if (active) setSummary(`HTTP ${response.status}`);
      })
      .catch((error: unknown) => {
        if (active) setSummary(error instanceof Error ? error.message : "Failed");
      });

    return () => {
      active = false;
    };
  }, [host.http, props.endpoint]);

  useEffect(() => host.actions.register({
    id: "check-now",
    label: "Check service health now",
    description: props.endpoint,
    keywords: ["refresh", "status"],
    async run() {
      const response = await host.http?.request({
        url: props.endpoint,
        timeoutMs: 5_000,
      });
      if (response) setSummary(`HTTP ${response.status}`);
    },
  }), [host.actions, host.http, props.endpoint]);

  return (
    <section className="service-health">
      <strong>{summary}</strong>
      {/* Projected children are rendered through the generic child surface. */}
    </section>
  );
});
```

Reference the directory from `dash-bored.yaml`:

```yaml
component: "./components/service-health"
props:
  endpoint: http://localhost:3000/health
```

Local components may import relative TS, TSX, and CSS files contained in their
own directory. They may not import arbitrary packages, Node or Electrobun APIs,
files elsewhere in the project, or unsupported assets. The runtime compiles the
entry as a browser ESM bundle and shares the application's React runtime.

### Component host APIs

The host object always includes `dashboard.reload()` and
`actions.register(action)`. Additional APIs appear only when the manifest
declares the corresponding permission:

| Manifest permission | Host API | Purpose |
| --- | --- | --- |
| None | `host.actions.register(action)` | Contribute a mounted-instance action to the command palette. |
| `filesystem:read` | `host.filesystem.readText(path)` | Read a bounded UTF-8 file below the project root. |
| `filesystem:write` | `host.filesystem.writeText(path, content)` | Atomically replace a bounded UTF-8 file below the project root. |
| `network:http` | `host.http.request(request)` | Make a bounded, timed `http:` or `https:` request. |
| `process:execute` | `host.shell.run(request)` and `host.processes.start/stop` for a declared resource | Run a bounded short command or control the node's supervised process. |
| `process:observe` | `host.processes.get(nodeId)` | Observe a declared supervised process resource. |
| `webview:embed` | `host.webview.render(request)` | Embed a native sandboxed webview surface. |

Register actions in an effect and return the disposer, as in the example.
Local action IDs start with a letter and may contain letters, digits,
underscores, and hyphens. Actions may also declare `enabled`, a
`disabledReason`, and confirmation copy. They exist only while that trusted
component instance is mounted and do not add permissions; action callbacks use
the same shaped host APIs as the component UI.

The desktop app asks the user to trust the project before compiling local code
or enabling declared capabilities. The main process checks the supplied node ID
and its declared capability on every host request. A reload that adds a
requested permission requires a new trust decision; the same or a smaller
permission set preserves the existing decision.

The repository's dogfood dashboard includes a `package-scripts` component. It
reads a configured `package.json`, detects its `packageManager` when present,
and registers one action per string-valued script. Each action runs from the
directory containing that manifest through `host.shell.run`; the component also
shows direct buttons and the bounded result of the most recent run. Use the
optional `runner` prop when a project needs to override its manifest metadata.

Local components are trusted project code running together in one renderer,
not a hostile-code sandbox. Their per-node permissions shape the provided API
and prevent accidental capability use, but do not isolate local components from
one another; sufficiently adversarial trusted code could forge another node's
ID at the internal RPC layer. Project trust is the security boundary.

Use `@dash-bored/command` for a user-controlled terminal. It never starts
automatically: **Open terminal** creates its persistent PTY-backed shell and
the configured YAML `command` is its remembered quick action. Use the command
button to run that action again, or type directly into the terminal to run
consecutive commands; **Close terminal** ends the shell and its process tree.

## Current boundaries

The developer build supports one project per window and local components only.
It does not yet include external package resolution, a component marketplace,
file editing, multi-project windows, or custom AI infrastructure. Those
omissions are intentional until the core runtime is proven.
