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

Bun is not required. You work in the app; your coding agent works through the
tools that ship with the dash-bored skill (see [Agent tools](#agent-tools)).
Nothing is installed on your `PATH`.

The installed application includes a custom dash-bored icon for Finder, the
Applications folder, and the Dock.

## Developer setup

Install [Bun](https://bun.sh/) and clone the repository. The project pins its Bun
and Electrobun versions; a global Electrobun install is not needed.

```sh
bun install --frozen-lockfile
bun run packages:restore
bun run setup
```

When changing the default core-component pin, publish the component commit
before other checkouts or new projects use it. Run
`bun run packages:verify-published` to check a fresh download and the component
API contracts. Release builds and release preparation require this check;
development builds may use local commits while authoring components.

For a new Git worktree, use the one-step setup instead:

```sh
bun run worktree:setup
```

It installs locked dependencies, creates an ignored `.env.worktree` with a
checkout-specific port and application identity, seeds an isolated Hutch home,
restores the pinned dashboard packages, prepares Hutch, and validates both bundles. `bun run dev` also creates this
environment automatically. Separate worktrees can run native dev apps together.

Dev builds are agent-owned: agents may restart this checkout's app without
asking. They automatically trust declared dashboard capabilities, including
new permissions, and do not update your global skill installation. This applies
only to the actual `dev` channel; installed releases retain normal trust.
Revoking trust still disables a project until the dev app is restarted.

Installed apps remember approved project capabilities across restarts. Nonfatal
validation errors still allow **Trust project** when all requested capabilities
can be inspected; you can then use **Fix with agent**. A wrong schema marker,
invalid props or action references, or a compile failure does not erase trust.
The dashboard loads after the errors are fixed. Unreadable YAML, unsafe paths,
or missing capability declarations block approval; new permissions require a
fresh review.

For an agent-managed background instance, use `bun run dev:start`. Use
`dev:status` to get its identity, PID and log path, `dev:restart` to rebuild and
restart it, and `dev:stop` to stop this checkout's dev processes. Restart returns
immediately so it can also be run from the app being restarted; use `dev:status`
to check the new PID. Background
output is in `.hutch/dev.log`. In the checkout, `bun run dash-bored -- app ...`
automatically targets its own instance. Use `--instance` to target another one.

In a source checkout, run the agent tool with `bun run dash-bored -- <command>`.

Useful repository commands:

```sh
bun run dev             # Vite development renderer + watched Electrobun app
bun run dev:start       # start this checkout's app in the background
bun run dev:restart     # rebuild/restart this checkout's app
bun run dev:status      # identity, PID, URL and background log
bun run dev:stop        # stop only this checkout's dev processes
bun run dev:desktop     # built renderer + watched Electrobun main process
bun run build:cli       # standalone agent tool embedded in desktop builds
bun run styles:dead     # report app CSS class/ID hooks without source references
bun run typecheck
bun run test            # repository tests only; excludes saved release artifacts
bun run build:renderer
bun run build           # local canary application build
bun run icon:generate   # regenerate the committed macOS iconset from its SVG
bun run build:release   # clean unsigned Apple Silicon release build
bun run release:prepare # verify artifacts and stage release files
bun run qa              # prepare, typecheck, tests, renderer and agent-tool builds
bun run qa:fast         # same checks/builds, reusing prepared Hutch files
bun run ui:fixture      # isolated renderer fixture at http://127.0.0.1:5488/ui-harness.html
bun run test:renderer-ui # browser-driven pointer and keyboard verification for that fixture
bun run native:probe    # isolated manual Electrobun webview visibility/dimensions probe
```

`styles:dead` scans `src/renderer/styles.css` against runtime source under
`src/renderer`. Core component styles live in the component repository. It reports class and ID
hooks with no static reference, while listing state/value-prefixed hooks
assembled dynamically for manual review. Add `--check` when a non-zero exit
code is wanted for definitely dead hooks.

### Choosing verification

For an already prepared checkout, default to `bun run qa:fast`. `qa`,
`typecheck`, and `build:renderer` invoke `electrobun prepare`, which can wait
behind this checkout's running desktop watcher. Agents may restart their own
dev app when preparation is needed; other checkouts and installed apps are
separate. The fast commands never prepare; they fail immediately
with setup guidance if the required Hutch files are missing. After changing
the Electrobun dependency, regenerate Hutch with `bun run setup` when the
watcher is stopped before relying on fast checks.

| Change or question | Smallest useful check |
| --- | --- |
| Focused logic regression | `bun test tests/<area>/<file>.test.ts` |
| TypeScript across the repo | `bun run typecheck:fast` |
| Renderer bundling or CSS | `bun run build:renderer:fast` |
| Component rendering in packaged apps | `bun test tests/renderer/production-components.test.ts` (production React and JSX, pinned core navigation, local TSX) |
| Completed code change | `bun run qa:fast` (includes the browser interaction suite and agent-tool build) |
| Dashboard YAML | `bun run dash-bored -- validate .` |
| Release QA harness | `bun run qa:release:test`, then the relevant [release QA scenario](./docs/release-qa.md) |
| Agent skill guidance | `bun test tests/core/component-authoring.test.ts`; for behavior changes, the work-in-progress [skill A/B eval](./scripts/eval/README.md) |
| Renderer, CSS, or dashboard change visible in the running dev app | `bun run dash-bored -- app screenshot [--focus <node-id>]`, then view the PNG; drive it with `app actions <filter>` and `app run <action>` (see [Agent tools](#agent-tools)) |
| Documentation only | Check links and `git diff --check`; no full build needed |

Run focused checks while iterating and the relevant full check once the change
is ready. Do not rerun `test:renderer-ui` or `build:cli` after a successful
`qa:fast` unless new edits or a specific investigation require it. Dashboard
validation and the Python release-harness tests are separate from `qa:fast`.
Use `bun run test` for the complete repository suite: it scopes discovery to
`./tests`. Bare `bun test` also discovers copied tests in saved release-QA
artifacts and the standalone release fixture, making its totals depend on
local evidence directories.
The production component regression is included in `bun run test`; it builds
the renderer with production React and exercises existing compiled components
as well as local TSX. The normal Vite fixture uses development React and cannot
by itself prove this packaged-runtime compatibility.
Check `git diff --check` before handing off changes.

On macOS, use `caffeinate -is bun run qa:fast` when an unattended run could
span system sleep. The keep-awake assertion ends with the command; sleeping
during a run can invalidate the tests' wall-clock timeouts.

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
If Vite exits early or does not answer before the eight-second startup deadline,
the test reports the child exit status, bounded stdout/stderr, and the last HTTP
probe instead of only reporting a fixture timeout. It is also included in `bun run test` and therefore both QA commands. No manually
started fixture server is needed for this test. For manual browser inspection,
open `/ui-harness.html`; the normal `/` page requires the native host bridge.
If the manual fixture port is busy, use `DASH_BORED_UI_PORT=5489 bun run ui:fixture`.

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

## Agent tools

dash-bored separates the two audiences. You use the desktop app. Your coding
agent uses the tools that ship with the dash-bored skill: a small launcher,
`scripts/dash-bored` inside the installed skill, that runs the version-matched
tool carried inside the app. The app passes that tool's path to agents it
launches in `DASH_BORED_TOOL`, and the installed app records it for agents you
start yourself. Nothing is linked onto your `PATH`. Earlier releases could link
a CLI into `~/.local/bin`; the app removes that link at startup when its
receipt shows dash-bored created it.

With those tools an agent can:

- create dashboard bundles (`init`), inspect the component catalog and
  contracts (`inspect --summary`, `inspect --component <reference>`), and
  validate its edits (`validate`);
- check whether a dashboard needs migration and get the recipes
  (`migrate inspect <dashboard>`);
- manage external component and theme pins when you ask it to (`component`,
  `theme`);
- work with the running app through a private, per-instance control socket:
  read its state (`app status`), list and run the same command-palette actions
  you can (`app actions [<filter>]`, `app run <action>`), open a dashboard
  (`app open <dashboard>`), and capture the app window to check the result
  visually (`app screenshot [--node <node-id>]`). `--node` crops to one node,
  restoring any view change it made, and `--focus <node-id>` restores your
  previous focus afterwards unless `--keep-focus` is given. `app actions` lists
  choices by option count; `--choices` includes their options. `app run` and `app screenshot`
  wait up to ten seconds for views to finish loading their sources, so a
  refresh is complete when the command returns; `--timeout <ms>` changes the
  bound and `app run --no-wait` skips the wait. Started commands keep running.
- read results instead of guessing from pixels: visible diagnostics and trust
  state in `app status`, command process states and exit codes
  (`app processes`), and recent, ANSI-stripped command output
  (`app logs <command-id> [--tail <n>]`), a command's result in one call
  (`app run process:<id> --until-exit`, or `app wait <id>` for a run in
  progress), and a panel's full text (`app read <node-id>`). These are read-only; starting or
  stopping a process stays an `app run process:*` action.

An agent can bring dash-bored to the foreground with
`app run app:focus-window --no-wait` (**Bring app to front** in the palette).
It restores a minimized window and gives it keyboard focus without changing
your dashboard, selected panels, or draft. Agents use it sparingly when work is
done or blocked and your attention is needed.

The control channel never widens what an action can do. Trust, starting,
saving, or cancelling a dashboard edit, the Add dashboard chooser, and any
action that asks for confirmation are refused and left to you. Opening a
dashboard is refused while you have unsaved dashboard changes or a save in
progress. A clean settings session does not block agents or require Cancel.
Screenshots use macOS Screen
Recording permission; the first capture asks for it. The app keeps rendering
while other windows cover it, so agents can drive and capture it without you
switching to it; a minimized or hidden window cannot be captured.

Later app launches refresh installer-owned skill files. Modified files are
preserved, with a notice explaining the conflict; successful refreshes do not
remain in the diagnostics panel. The Installed tools warning also offers
**Remove old and reinstall**. This explicit action moves the conflicting
managed skill directory and its alias to the OS Trash before installing the
current payload.

## Start a project dashboard

Launch the desktop application and select a project directory with **Add
dashboard**. Opening a project creates any missing dash-bored files, without
overwriting existing files:

```text
project/
└── .dash-bored/
    ├── dash-bored.yaml
    ├── dash-bored-lock.yaml
    ├── README.md
    ├── install-app.sh
    ├── .env
    └── components/
```

Each bundle's `README.md` explains the app, its files, and setup for teammates
who have never used dash-bored. From the project root, run
`sh .dash-bored/install-app.sh` to download, verify, and open the newest
published canary DMG for the bundle's exact `schemaVersion`, then drag the app
into Applications. The helper uses built-in macOS tools and requires Apple
Silicon with macOS 14 or newer; it does not migrate YAML or replace an installed
app. Existing README and helper files are preserved when opening a project.

### Show output from a project source

The Markdown view can display JSON or text from a bounded project source. A
small project script owns any domain-specific processing:

```yaml
component: "./components/external/core/markdown"
props:
  title: Project summary
  source:
    shell: bun run scripts/dashboard-summary.ts
    cwd: .
    timeoutMs: 5000
    every: 30000
```

Use one of `shell`, `file`, `http`, `process`, or `inline` in `source`. HTTP
sources use absolute HTTP(S) URLs. Process sources name a supervised command
node by ID. Omitting `every` runs the source on mount and on manual refresh;
process snapshots update when the supervised process changes. Polling pauses
while the view is hidden. Each source kind requests only its needed capability:
shell execution, file read, HTTP, or process observation. The app bounds source
timeouts and output, and shows a stale last value when a refresh fails.

The generated dashboard is immediately valid. Its first screen is a
**Get started** checklist: trust the project, choose your coding agent, install
the dash-bored skill, and run the setup agent. Each step explains what its
button does and what to expect, and shows a live status for the result, so
installed skills and a missing agent CLI stay visible rather than disappearing.
Below it, a tabbed component tour explains each component and shows it working
on the project's own files. The setup action asks your chosen CLI coding agent
to replace the starter with a project-specific cockpit. It uses
`codex exec` by default; set the app-wide `DASH_BORED_AGENT` command in
**Settings → General → Dashboard agent**. Leave that field empty and save when
the active dashboard's `.env` should provide the command. The bundle environment
editor shows the effective agent command and its source; a set app setting
overrides the bundle's `.env` default. Other command variables load from each
component's owning bundle, with explicit command overrides taking precedence.
Saving `.env` affects new launches and leaves existing terminals running.
Desktop launches also recognize conventional user CLI locations, including
`~/.local/bin`, `~/.bun/bin`, Homebrew, pnpm, and npm locations, so a normal
Codex CLI installation works without copying a shell PATH. For a custom
installation directory, configure an absolute dashboard-agent command.

In **Settings → General → Dashboard sidebar**, enable **Start expanded** when
you want configured dashboard names visible as soon as dash-bored opens. The
sidebar can still be expanded or collapsed independently from its toggle.

**Set up this dashboard** starts a tracked agent task with a prompt generated
for that bundle. No prompt needs to be copied into YAML or `.env`. Agent work
keeps its terminal output available even when the agent replaces the starter.
After the agent finishes, the app validates the saved dashboard and local
components. A successful run that leaves fixable configuration errors gets one
automatic repair attempt; the result is validated again. Stopping the task,
leaving the dashboard, or revoking trust prevents an automatic repair. A valid
dashboard that adds permissions still requires trust before becoming live.
Validation establishes configuration correctness; review the workflows the
agent created to decide whether they meet your needs.

A button can invoke an action with typed YAML arguments, for example
`action: { run: "agent:prompt", with: { prompt: "Review the failing checks." } }`.
The app validates those arguments when it loads the dashboard. Agent prompts show
the resolved command, the prompt template, and the full prompt for review, then
wait for the user's Send.

Agents are briefed with prompt templates. `agent:prompt` uses the built-in
`project` template, which asks for work in the project and names the button or
list item it came from; `template: dashboard` asks for a dashboard change
instead, as Change with agent does. Add your own as Markdown files in
`.dash-bored/prompts/<name>.md` and pass typed values from a list item:

```yaml
itemActions:
  - name: Implement with agent
    action:
      run: agent:prompt
      with: { template: implement-todo, prompt: "${item.description}", vars: { id: "${item.id}" } }
```

A file named `project.md` or `dashboard.md` replaces the built-in briefing for
that bundle. The [project contract](./docs/architecture/project-contract.md#prompt-templates)
documents the template syntax and the values available to it.

Every rendered component has a context menu
with Focus, Edit component, Copy component path, and Change with agent. The
Edit component action opens the declared props and child metadata editor. The
menu also offers **Move up** and **Move down** when a compatible sibling exists;
these changes use the same dashboard draft as dragging.
Change with agent shows the resolved command before sending and enriches your request with the owning
dashboard and exact component path. **Agent work** in the header keeps each
launch visible while it runs, including its output, exit state,
and an observed dashboard change; review the result rather than treating those
signals as proof that an external agent completed the request. Each Agent work
item shows the user's prompt, start time, and Working/Not working state; clicking
it opens Terminal, Diff, and Command tabs. Diff is scoped to the owning
`.dash-bored/` folder for dashboard changes and covers the project for project
work, while Command shows the full contextualized invocation
with a copy action. When configuration diagnostics are present, **Fix with
agent** asks the configured CLI to repair the
owning dashboard and includes the current reported issues, even when the tree
cannot render. The starter's skill step installs the skill globally or for
this project and reports each scope's `install-skill --check` result. The global form writes the portable guidance and
component-authoring reference to `~/.agents/skills/dash-bored/`; the project
form writes to `.agents/skills/dash-bored/`. Both create
`.claude/skills/dash-bored` as a link to the same canonical payload. Repeated
installs are safe. The app refreshes previously installed global skills at
startup and project skills for registered or newly opened dashboards, using
file hashes to preserve local edits. An older installation without ownership
metadata can be adopted when its contents match; otherwise the Installed tools
warning offers an explicit Trash-and-reinstall action. Install globally for
convenience when you use dashboards in several projects. The shipped reference
includes the live catalog, host response types, theme guidance, and a complete
local-component example; agents do not need the app source to author a dashboard.
You can also create these files without
opening the app by running
`dash-bored init .`; unlike `open`, explicit initialization fails if a
configuration, lock, or dashboard environment file already exists.

Set a dashboard-specific sidebar icon directly in its `dash-bored.yaml`:

```yaml
schemaVersion: 4
name: Example project
icon: ../assets/icon.svg
root:
  component: "./components/external/core/markdown"
  props:
    content: Ready
```

The icon may be a relative or absolute image path, or an HTTP(S) URL. It is
loaded after the project is trusted; missing or unsupported artwork falls back
to the generic dashboard glyph. You can edit the dashboard name and this icon
from the app's dashboard editor; clearing the icon field restores the generic
glyph. Changes are written when you save the dashboard draft.

Ask your agent to create a standalone named dashboard for a person or workflow;
it runs the agent tool (shown here as `dash-bored`, which is the skill's
`scripts/dash-bored` launcher):

```sh
dash-bored init arvid
# or initialize it in another project
dash-bored init arvid --project /path/to/project
```

This creates a complete bundle independently of the main dashboard:

```text
project/.dash-bored/arvid/
├── dash-bored.yaml
├── dash-bored-lock.yaml
├── README.md
├── install-app.sh
├── .env
└── components/
```

The command does not edit `project/.dash-bored/dash-bored.yaml` or automatically
link the new dashboard into it. Each positional name adds another directory
level, so `dash-bored init arvid cicd` creates `.dash-bored/arvid/cicd/`.
Safe slash-separated names such as `dash-bored init people/arvid` remain
supported; every leaf is a complete bundle.

Agents check or inspect a dashboard with:

```sh
dash-bored validate .
dash-bored validate . --json
dash-bored inspect .
```

`validate` exits non-zero when it finds errors. `inspect` emits JSON containing
the resolved tree, requested permissions, diagnostics, and a `componentCatalog`
for every core component and discovered local component. Each catalog manifest is the
machine-readable contract for its rendering mode, JSON Schema props, children
contract, and required permissions. Agents use this version-matched catalog instead of guessing from
examples; invalid local components remain in the catalog with diagnostics.

`validate` and `inspect` accept a project root, a standalone bundle directory,
or the path to its `dash-bored.yaml`. `app open` accepts the same three forms
and asks the running app to render exactly the bundle selected by the path:

```sh
dash-bored app open ./.dash-bored/arvid
# equivalent:
dash-bored app open ./.dash-bored/arvid/dash-bored.yaml
```

The app receives the selected config path separately from the project root, so
opening a named bundle does not fall back to the canonical dashboard. `init`
uses `--project <path>` to select another project root because its positional
argument is the optional bundle name.
Running the desktop app without a project presents a project chooser; selecting
an uninitialized project creates the same root-level `.dash-bored/` structure
before loading it. A selected folder containing a nested `.dash-bored/` is the
project root, even when that folder is itself named `.dash-bored`. The same
**Add dashboard** chooser
also opens standalone bundles: select a directory containing
`dash-bored.yaml`, and that bundle is rendered directly without merging it into
the canonical dashboard. A selected directory containing a nested
`.dash-bored/` directory continues to open as a project root. Each selected
config is remembered as its own sidebar entry, so the canonical dashboard and
named bundles from the same project can be switched independently.

## Configure a dashboard

`.dash-bored/dash-bored.yaml` contains one recursive component node:

```yaml
schemaVersion: 4
name: Example project
root:
  component: "./components/external/core/group"
  children:
    axis: horizontal
    first:
      node:
        id: intro
        component: "./components/external/core/markdown"
        props:
          content: |
            # Development
            Project controls and status live here.
    second:
      node:
        id: api-status
        component: "./components/external/core/status"
        props:
          label: API
          state: unknown
```

Each node supports:

- `component`: a bundle-relative component path or linked dashboard path; required.
- `id`: a tree-unique stable identity; optional for display-only nodes and
  required for stateful/actionable nodes.
- `props`: data validated by the component's JSON Schema.
- `children`: a tiled child edge `{ node, metadata? }`, a split with `axis`,
  `first`, and `second`, or an array of edges for managed children such as tabs.
  Horizontal splits accept an optional `ratio` from `0.1` to `0.9`, defaulting
  to `0.5`. Vertical splits use document flow and do not accept a ratio.
- `persistOnFocus`: keep this ancestor or direct sibling navigation subtree in
  the projected view when a related node is focused; defaults to `false`.

The `root` is a normal component node. A dashboard may use a layout tree, but
it may just as well have one command button, status, or project component as
its root. In the app, any rendered component can be focused. The renderer keeps
marked ancestors and marked direct sibling rails around that target, while
breadcrumbs still follow the original configured path. The selected focus
target is local presentation state; only the optional persistence markers live
in YAML.

The pinned core components are:

- Composition: `./components/external/core/group` for transparent tiled children and
  `./components/external/core/selection` for one core-selected managed child.
- Controls and display: `./components/external/core/button`, `./components/external/core/markdown`, and
  `./components/external/core/status` (a tile or `density: compact` row, with optional source
  trend and part-of-whole segments).
- Lists: `./components/external/core/list` for bounded source data with stable item IDs,
  tag filtering, and open-first sorting.
- Charts: `./components/external/core/chart` for static YAML data or a bounded source, with
  `./components/external/core/live-chart` retained as a compatibility form for endpoint data.
- Host-backed: `./components/external/core/command`, `./components/external/core/conditional`,
  `./components/external/core/env`, `./components/external/core/todo-list`, and
  `./components/external/core/webview`.

These shipped components are examples of the public component contracts, not
privileged types. Local components can declare the same child contracts,
process resources, references, and permissions.

`./components/external/core/button` accepts one `name`/`action` pair or a compact `items`
array. Item actions use the same executor as the command palette, including
trust, confirmation, choices, availability, and bounded last-result feedback:

```yaml
component: "./components/external/core/button"
props:
  variant: tabs
  label: Project sections
  items:
    - name: Overview
      action: select:project-sections/overview
    - name: Development
      action: select:project-sections/development
```

Variants are `buttons`, `segmented`, and `tabs`. A tab-styled bar uses tablist
keyboard and accessibility semantics only when every item selects a child in
the same managed container. Active selection stays owned by that container.
Process-start feedback means the start request succeeded; the supervised process
snapshot supplies the later exit status and remains the source of truth. Agent
prompt actions report that the prompt is ready for review, while launch and task
validation remain separate outcomes.

Action references name nodes by their explicit stable ID, so moving a node does
not change the button. The editor's target picker assigns an ID when needed.
Stable forms include `app:reload`, `focus:<node-id>`, `process:<node-id>`, and
`component:<node-id>:<local-action-id>`. Schema-v3 dashboards still resolve
legacy positional references and show a deprecation warning; the v4 migration
will replace that transitional support with ID-only validation. A valid action
that is currently unmounted remains valid and renders as a disabled button with
its reason.

`./components/external/core/markdown` accepts either inline `content` or a project-relative
`path`. It opens in pretty Markdown preview by default; `Raw / edit` exposes
the source editor, with Save/Cancel behavior. Inline saves update the owning
dashboard draft, while path-backed saves write the bounded project file.

`./components/external/core/list` reads JSON from one bounded source and expects an array of
items with source-owned, unique string `id` and non-empty string `title`
fields. Optional `detail`, `tags`, `state`, and `done` fields have fixed types;
shape errors are shown beside the list. It filters by tags and puts items with
an open state before completed items by default. A source may be inline, a
project file, a bounded shell command, HTTP, or a supervised process:

```yaml
component: "./components/external/core/list"
props:
  title: Package scripts
  source:
    shell: bun run .dash-bored/scripts/package-scripts.ts
    cwd: .
    timeoutMs: 5000
  itemActions:
    - name: Run
      action:
        run: component:package-script-runner:run
        with:
          name: "${item.name}"
          runner: "${item.runner}"
```

The referenced `./components/external/core/command` node can use the fixed command
`"$DASH_ITEM_RUNNER" run "$DASH_ITEM_NAME"`. Item templates occupy whole,
typed argument values; the host passes them as bounded `DASH_ITEM_*`
environment variables when it starts the supervised process. The list keeps
separate invocation feedback for each item. The process snapshot's latest run
reports its later exit, and a finished command accepts the next item's run
without being closed first.

For editable YAML todos, set `todos` instead of `source` on the same list atom.
Each todo needs a stable `id`, `description`, `done`, and `tags`; the editor
keeps add, remove, toggle, and inline edits within the dashboard draft's
Save/Cancel boundary. `itemActions` work in either mode. The older
`./components/external/core/todo-list` reference remains available for schema-v3 dashboards.

`./components/external/core/group` is an ordinary transparent component boundary with
`renderMode: layout`: it accepts the core-tiled child surface and projects
those children without becoming a layout engine. Optional `title` and
`description` frame the group. Split topology and resize behavior remain
app-owned.

`./components/external/core/selection` projects one managed child. Give its children stable
IDs and labels in edge metadata; optional `props.defaultChild` names the child
shown before a saved local selection exists. `select:<container-id>/<child-id>`
actions can drive a button bar with `variant: tabs`. Use focus for global pages
and selection for nested panels. The component library's **Switchable panels**
pattern inserts two starter panels and a tab bar with stable ID references.

Core-owned horizontal split branches use a drag and keyboard separator while
retaining a checked-in default:

```yaml
children:
  axis: horizontal
  first:
    node: ...
  second:
    node: ...
  ratio: 0.4
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

`./components/external/core/env` takes a relative `path` prop, reads a project-local dotenv
file, and provides a key-value editor with a bulk/raw mode. Saving requires
project trust because the component requests both `filesystem:read` and
`filesystem:write`; comments, blank lines, and unrecognized lines remain in
place when editing through the key-value view.

A status can continue to use a hand-written `state`, or read a bounded source
that emits `{ state: unknown | healthy | warning | error, detail? }`. A source
that observes a supervised process derives the state from its phase and exit
code. Both forms keep schema-v3 dashboards readable while migration is in
progress.

`./components/external/core/todo-list` stores its `todos` array directly in the component's
dashboard YAML props. Items have stable `id` strings, descriptions, boolean
completion state, and tags. Legacy items receive IDs when the user next edits
the list; add, remove, toggle, and inline edits use the normal dashboard draft
Save/Cancel boundary. `itemActions` use the same whole-value item templates and
per-item feedback as source lists; an agent action can use
`prompt: "${item.description}"` without changing todo completion state.

Charts use a shared `{ labels, series }` model. `./components/external/core/chart` renders
static line or bar data from YAML or reads the same shape from a bounded source
(shell, file, HTTP, supervised process, or inline). Source shape errors are
shown on the chart. The schema-v3 `./components/external/core/live-chart` form remains
compatible with HTTP endpoint dashboards and delegates polling and rendering to
the shared chart source view. Its endpoint may be absolute HTTP(S) or an
app-relative path such as `/metrics/chart.json`; it also supports an optional
dot-separated `dataPath`. Source polling pauses while its panel is hidden.

`./components/external/core/conditional` accepts one tiled child and a bounded shell `command`.
The child is projected when the command exits successfully; set `invert: true`
to show it until the check succeeds. Checks poll only while their panel is
visible and fail open before trust or when the host cannot complete a check.
Use it for setup actions that should disappear after they are complete, such as
the starter's agent-skill installers.

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

The lock file is authoritative. New bundles include the release-owned `core`
pin from [dash-bored-components](https://github.com/ArvidSU/dash-bored-components),
with a full commit SHA and `path: components/external/core`. Core references use
`./components/external/core/<name>` and follow normal project trust.

Dash-bored owns private Git repositories inside `components/external/` and
`themes/external/`. Generated bundle `.gitignore` rules exclude both directories;
commit your YAML, local components and `dash-bored-lock.yaml`. Package operations
work in plain directories and never edit parent Git metadata. Init and opening a
bundle restore missing locked packages, including linked bundles, at exact pins.
Existing checkouts stay untouched. Updates are explicit.

Use `component restore <bundle>` to retry missing checkouts, `component sync
<bundle>` to align existing clean checkouts, and `component migrate-ownership
<bundle>` only when explicitly converting older parent-owned submodules. This
conversion changes parent gitlinks and `.gitmodules`, refuses staged changes or
local edits on those targets, and preserves paths and pins. Inspection, validation
and watcher reloads stay read-only. Offline failures preserve YAML and pins and
show an app-owned recovery screen with Retry and Sync.

Dashboard contract 4 replaces recognized `@dash-bored/<name>` references with
external core paths. Cumulative migration recipes preserve IDs, props, metadata,
actions and topology and add the release core pin. Linked bundles migrate
independently. All 17 components remain available; retirement is a separate change.

The application watches the configuration, lock file, component manifests, and
component source. A valid edit replaces the current dashboard. An invalid edit
leaves the last known-good dashboard visible and adds diagnostics.

### Compose a dashboard in the app

Select **Components** in the header to open the right-hand library. It lists
the complete core, external and project-local catalog, with search, descriptions,
child contracts, permissions, provenance, and unavailable diagnostics. Use an
**Insert** button for keyboard-accessible insertion or drag a card onto a
contextual dashboard target. Use an existing component's drag handle to move it,
or choose **Move up** or **Move down** in its frame menu. Empty boundaries, managed-child
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

Pick up an existing component from its frame's drag handle to move it. During a
component drag, the fly-out becomes a 20%-wide dotted trash target with
only a trash icon; dropping there opens the existing removal confirmation.
Component menus and composition controls are hidden for the duration of this
dropper-style interaction.

Configure edits component props through `propsSchema`. New managed edges expose
their parent's generic `children.metadataSchema`; edge metadata moves with the
child. If search finds no suitable catalog entry, the flyout retains the
**Build with agent** path. Its prompt, visible in the Agent work drawer, asks
the agent to prefer a core view fed by a small source script over new
component code, and states exactly where and how the new node joins the
chosen insertion position.

Opening or closing a clean flyout does not create a draft. The first insertion,
move, removal, replacement, metadata edit, or horizontal separator resize creates a
renderer-owned draft, previewed through the same host resolver as saved YAML.
Save/Cancel appears only for actual unsaved changes. Inspecting component settings,
cancelling an insertion, or reverting every change needs no extra Cancel and
does not block agents. A clean preview follows external YAML reloads.
The toolbar shows **Checking draft…** while the preview updates. **Save dashboard** validates the whole owning tree,
checks the source revision, and atomically writes it; **Cancel** discards the
whole draft. If `dash-bored.yaml` changes outside the app, save is rejected
instead of overwriting that newer source. Focused config-link content edits the
linked bundle that owns it.

Expand the project sidebar and use a dashboard row's tree button to inspect its
read-only component outline. Branches can be collapsed independently, and the
node that is currently focused is highlighted.
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
`project/.dash-bored/` directory (and
its named bundles, components, lock files, and environment files) to the OS
Trash. Source files elsewhere in the project are never removed. Removing the
active dashboard unloads its watcher, supervised processes, and trust state;
the next remembered dashboard is selected automatically when one exists.

The accepted configuration is written back as canonical YAML, so comments and
hand formatting are not preserved. Adding a component that requests a new
capability saves the configuration but returns the project to restricted mode
until the expanded permission set is trusted.

Press <kbd>Command-K</kbd> on macOS or <kbd>Ctrl-K</kbd> elsewhere to open the
command palette. It searches application controls, component navigation in the
selected dashboard, its declared process resources, and component actions.
Type a component, panel, theme, or dashboard name to jump straight to it:
matches appear as rows such as **Focus component › Backlog** or
**Select panel › Docs**. Choosing an action with options (**Focus component**,
**Set dashboard theme**) narrows the same search box and list to its options;
press <kbd>Esc</kbd> or <kbd>Backspace</kbd> in the empty box to step back.
Manifest-declared actions also stay searchable in the palette and listed in
Settings while their component is collapsed or hidden; they show why they cannot
run until mounted.
Choose **Switch dashboard** in the palette to open another registered dashboard;
searching its name lists it as a **Switch dashboard** option. Other dashboards remain reachable
from the sidebar. With the palette closed, hold <kbd>Command</kbd> to show
number hints on the first nine dashboard icons and press <kbd>1</kbd>–<kbd>9</kbd>
to switch to that dashboard. Drag a dashboard icon or row above or below another
row to reorder the sidebar; the order is saved and determines these numbers.
Click the active dashboard again, or press its Command number again, to toggle
sidebar expansion. From Settings, that gesture returns to the dashboard.
Switching with an unsaved dashboard draft offers **Keep editing**, **Save dashboard**,
and **Discard changes**. Saving writes the validated draft first, then completes
the requested navigation; a rejected save keeps the draft open.
Hold <kbd>Command</kbd>
while pressing <kbd>Enter</kbd> or clicking an action to run it and keep the
palette open. This also works through component choices and confirmations.
Search clears by default; turn off **Clear search when keeping the palette
open** in **Settings → General** to keep it. Plain Enter or a click closes the
palette after running the action.
Settings is split into **General**, **Themes**, and **Actions**. Themes contains app appearance defaults, a per-dashboard list of theme and appearance selections, and theme package management. General lets you change the
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
project/..dash-bored/components/service-health/
├── component.yaml
├── index.tsx
└── styles.css                 # optional
```

Define its metadata, props, children contract, and least-privilege permissions in
`component.yaml`:

```yaml
schemaVersion: 3
apiVersion: 1.0.0
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
actions:
  - id: check-now
    label: Check service health now
    description: Fetch the current endpoint status.
```

Declare each stable local action in `actions`. The palette and Settings can
show its metadata before this component mounts, and dashboard validation can
check references to its ID. When `actions` is present, runtime registrations
must use a declared ID. Omitting it retains legacy dynamic registration for
older local components that discover actions at runtime.

`renderMode` defaults to `surface`. Declare `layout` when the component is an
organizational boundary whose height follows its descendants rather than an
independently resizable surface.

The app ships its offline authoring SDK and checker in `.dash-bored-sdk/`; no
separate React installation is needed. Inspect the API, scaffold an authoring
directory, set up editor types, and check sources with:

```sh
dash-bored component api [--api-version 1.0.0] [--json]
dash-bored component init <directory>
dash-bored component setup <directory> [--tsconfig <file>]
dash-bored component check <directory> [--source-project <tsconfig>] [--json]
```

`component api` reports supported API targets and includes an SDK digest for
the exact shipped SDK declaration set. `setup` installs those
SDK files beside the chosen tsconfig, includes ambient public-module and CSS
declarations, and maps only private SDK type aliases. Runtime imports keep their
ordinary resolution, including Bun tests and build scripts. Setup preserves
unrelated settings and removes earlier SDK runtime aliases only when a receipt
identifies the installation and the alias still points at its managed file.
`component api` points agents to the installed dash-bored skill's standalone
authoring workflow; scaffold READMEs and their `dash-bored.sh` launcher make the
same workflow usable without a command on PATH. `check` semantically checks
local TypeScript/TSX entries against the selected SDK and checks the production
bundle. For a published JavaScript entry, it checks the declared `.d.ts` file
against the component render interface and bundles the JavaScript artifact;
pass `--source-project <tsconfig>` to semantically check the original TS/TSX
publication sources too. Runtime imports may use contained relative `.ts`,
`.tsx`, `.js`, and `.css` files. JavaScript entries must set
`types: ./types.d.ts`. Published components include generated JavaScript
runtime output and declarations, so source, declaration interface, and shipped
artifact checks have distinct roles. These checks do not execute or preview the
component. Add it to a dashboard and use the app's normal live reload and
`app screenshot --focus <node-id>` to see it in context; there is no separate
component preview host or command.

A manifest must declare a supported exact stable-semver `apiVersion`. Missing
and unsupported versions fail with migration guidance before any component
executes.

The component API version is independent of dashboard `schemaVersion`. API
1.0.0 uses SemVer: additive optional methods and types may ship in a minor
release, with deprecation notes before removal; breaking changes require a
major release and migration guidance.
Capabilities can be absent: authors handle optional host members and runtime
denials. Every privileged call checks trust and the declaring node's permissions. Component
schema-v2 manifests require explicit migration; the app never changes pins to
make older external components appear compatible.

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

The host object always includes `dashboard.reload()`,
`actions.register(action)`, `actions.resolve(reference)`, and
`actions.invoke(reference)`. `resolve` reports the current label, availability,
disabled reason, running state, active state, and whether palette interaction
is required. `invoke` uses the shared action request/execution path. Additional APIs appear only when the manifest
declares the corresponding permission:

| Manifest permission | Host API | Purpose |
| --- | --- | --- |
| None | `host.actions.register/resolve/invoke` | Contribute or invoke mounted and application actions without adding capability. |
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

The repository's dogfood dashboard uses `.dash-bored/scripts/package-scripts.ts`
as a source for `./components/external/core/list`. The script reads `package.json`, detects
its `packageManager`, and emits one stable-ID item per string-valued script.
The list's declared Run action passes the selected name and runner to a
`./components/external/core/command` through bounded `DASH_ITEM_*` environment variables.
The command surface and item button show process and invocation results.

Local components are trusted project code running together in one renderer,
not a hostile-code sandbox. Their per-node permissions shape the provided API
and prevent accidental capability use, but do not isolate local components from
one another; sufficiently adversarial trusted code could forge another node's
ID at the internal RPC layer. Project trust is the security boundary.

Use `./components/external/core/command` for a user-controlled terminal. It never starts
automatically: **Open terminal** creates its persistent PTY-backed shell and
the configured YAML `command` is its remembered quick action. Use the command
button to run that action again, or type directly into the terminal to run
consecutive commands; **Close terminal** ends the shell and its process tree.
Each quick-action run reports its own result: the command shows `running`
and then its exit code, and a status view or button bound to the command
follows that run rather than the open terminal. When a run finishes, the
terminal returns to a fresh interactive shell, and the command, its palette
action, and item actions can run again without closing it. Commands you type
into that shell are not runs. While one of them is still running, starting a
run is refused so that your work is not ended.

## Current boundaries

The developer build supports one project per window and local components only.
It does not yet include external package resolution, a component marketplace,
file editing, multi-project windows, or custom AI infrastructure. Those
omissions are intentional until the core runtime is proven.

## Release onboarding evaluation

Use the opt-in [Docker release QA and macOS checklist](docs/release-qa.md)
to check fresh installation, existing-user tool updates, and repeated
Codex/luna dashboard-building runs with saved logs and review evidence.
Run `bun run qa:release --help` for options; this is separate from ordinary QA.

Pristine v0.2.2 and v0.2.3 agent skills are recognized by the complete historical file-hash
set and upgraded automatically. Customized or unrecognized legacy skills still
require moving the old skill directory aside and reinstalling; preserve those
files for comparison. This does not migrate schema-v1 dashboards. Keep their
`dash-bored/` directory intact, initialize a new schema-v3 bundle with
`dash-bored init .`, and ask your agent to recreate the required workflows in
`.dash-bored/` using the old dashboard as read-only reference. Review and validate
the new bundle before retiring the original.

For bounded agent discovery, use `dash-bored inspect . --summary` followed by
`dash-bored inspect . --component ./components/external/core/command` (or another exact catalog
reference). Full `inspect` output remains available when the entire tree is needed.

## UI themes

Settings → Themes selects any available default theme and **Dark**, **Light**, or
**System** appearance. The app-level list includes global themes and packages
from registered dashboard bundles. The dashboard list independently selects a
theme and appearance for every remembered bundle; blank fields inherit the app
defaults. These changes write the selected bundle directly and do not open it,
change the active dashboard, or enter the dashboard editor. **Set default theme**
and **Set dashboard theme** in the command palette guide the same selections.
Linked dashboards and component focus do not change the window theme.

The development dashboard uses `Ocean`, with calm blue navigation accents and
separate semantic health colors. Its Overview shows live health, backlog
completion as a meter, a 14-day commit trend, and the first five open work
items (bugs first); **Show in backlog** opens Work and focuses that todo. Work
contains the full editable backlog and check terminals. `Retro Industrial` remains available
as an optional warm theme. Both are regular data-only theme packages that can
be copied as a starting point for another project.

Ask your agent to create a local theme; it runs:

```sh
dash-bored theme init ocean .
dash-bored theme validate .dash-bored/themes/ocean
```

Edit `.dash-bored/themes/ocean/theme.yaml`:

```yaml
schemaVersion: 1
id: ocean
name: Ocean
light:
  accent: '#285fbb'
dark:
  accent: '#8fb8ff'
```

Select `./themes/ocean` under Component library → Dashboard appearance or set the top-level
`theme: ./themes/ocean` in its YAML. Each variant inherits all unspecified
built-in tokens. See the [token reference](skills/dash-bored/references/theme-tokens.md)
and [JSON Schema](schemas/theme.schema.json). Agents can print the same schema
with the agent tool's `theme validate --schema`. Theme packages contain data;
custom CSS, scripts, downloaded fonts, and layout changes are unsupported.

**Settings → Themes → Manage theme packages** lists personal or selected-dashboard
packages with repository URLs, exact pins, and missing-checkout diagnostics. Choose
Add, Update, Remove, Sync, or Status and select **Run theme operation** to apply it
to that exact dashboard bundle (or the personal store). Local authored themes
remain editable files. A theme repository has `theme.yaml` at its root. Agents
can run the same operations with the agent tool's `theme` command.

The project installation becomes `./themes/external/ocean`; commit its gitlink,
`.gitmodules`, and `dash-bored-lock.yaml`. A fresh clone uses Sync to
restore the exact pinned revision. Personal installation becomes `global:ocean`
and lives under `~/.config/dash-bored/themes`. Git is required for installations; project installs work in Git projects and
plain directories. Updates are always
explicit and refuse local changes. Installation does not select a theme.
Two themes ship with the app and need no installation: `builtin:default`
(calm blue) and `builtin:neon-dusk` (synthwave plum with a hot-magenta accent).
Missing themes show a diagnostic and fall back to your app default, then
`builtin:default`. Existing settings keep Dark until you choose another mode.

### App updates and dashboard migrations

Open **Application Settings → Updates**. The surface remains available when a
dashboard cannot load. It shows one state at a time: you're up to date, an
update is available, or the step in progress. Startup and 24-hour checks can be
switched off with **Check automatically**. Canary is the only available channel,
so no channel picker is shown yet. Downloads and installation remain explicit
actions.

Dashboards appear only when the new release needs to migrate them. When some
do, select them and choose **Update and migrate**: after installing and
restarting the exact target app, those migrations continue automatically.
**Update without migrating** leaves them for later; select them and use
**Migrate** afterward. **Cancel update** revokes pending automatic migration
authorization. With no migrations needed, the single action is **Update to
<version>**.

The app offers **Restart and install** using verified native update artifacts,
plus **Use the installer instead** (or **Open installer** where native
updates are unavailable) as the DMG fallback. Save or cancel drafts and
finish running terminals/agents first. With the DMG fallback, quit the
app, replace it, then restart. The
first updater-capable release requires manual installation. Unsigned macOS
builds retain the normal Privacy & Security → Open Anyway flow. Native replacement and relaunch passed an isolated two-version macOS test;
downloaded-DMG Gatekeeper approval remains a separate manual check.

Agents read applicable bundled guidance with the agent tool's
`migrate inspect <dashboard>`.
The bundled v2-to-v3 recipe removes redundant topology wrappers and vertical
ratios while preserving component content, edge metadata, and binary grouping.
Component manifests use schema version 3 and a supported `apiVersion`. Schema
version 1, version 2 without explicit migration, and unknown schemas are
unsupported.
App-driven migration agents receive the target agent tool, diagnostics,
cumulative recipes, and a read-only skill handoff. Existing customized skills are preserved. Migration requires the
existing project trust decision; new permissions require review in the app.

**Cancel continuation** cancels pending migrations. If an operation was
interrupted, the Updates surface's recovery action releases its lock only after
the owner exits. Review
reported snapshots and edits before explicitly retrying migrations; interrupted
work never runs again just because the app restarted. Snapshot and receipt paths
are under `~/.config/dash-bored/updates/`. To restore, first preserve current
edits, then copy the desired files from the reported snapshot. Failed dashboard
migrations are reported separately from a successful app installation.
