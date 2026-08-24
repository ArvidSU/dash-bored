# dash-bored

dash-bored is a local-first desktop cockpit that a project describes with YAML
and optional project-specific React components. The application supplies the
component runtime and controlled host capabilities; each project supplies the
workflow and domain knowledge.

The repository is an early developer build. It uses Electrobun 2.0.1 with a Bun
main process and a Vite/React renderer. Read [IDEA.md](./IDEA.md) for product
principles and [ARCHITECTURE.md](./ARCHITECTURE.md) for the complete runtime and
security contracts.

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

These early builds are not signed or notarized, so macOS may block the first
launch. Try to open the app once, then open **System Settings → Privacy &
Security**, select **Open Anyway**, and confirm. Apple documents this explicit
override in [Safely open apps on your
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
validates the dashboard. After that, `bun run dev` is ready to use. If another
desktop development process is already running, `bun run qa:fast` provides the
non-locking typecheck, test, and renderer-build path once Hutch is prepared.

`bun link` exposes the local `dash-bored` CLI. Without a link, invoke the same
entrypoint with `bun run dash-bored -- <command>`.

Useful repository commands:

```sh
bun run dev             # Vite development renderer + watched Electrobun app
bun run dev:desktop     # built renderer + watched Electrobun main process
bun run build:cli       # standalone CLI embedded in desktop builds
bun run typecheck
bun test
bun run build:renderer
bun run build           # local canary application build
bun run icon:generate   # regenerate the committed macOS iconset from its SVG
bun run build:release   # clean unsigned Apple Silicon release build
bun run release:prepare # verify artifacts and stage release files
bun run qa              # typecheck, tests, and renderer production build
bun run qa:fast         # non-locking typecheck, tests, and renderer build
```

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
a sampler of the available component primitives, and a command that asks your
chosen CLI coding agent to tailor the dashboard to the project. It uses
`codex exec` by default; the included environment editor updates
`DASH_BORED_AGENT` in `dash-bored/.env`, and the command sources that file
before it runs. Adjacent actions optionally expose the bundled CLI to external
shells and run `dash-bored install-skill .`, which copies the packaged guidance
and component-authoring reference into the cross-client Agent Skills location
`.agents/skills/dash-bored/`. That location is discovered by Codex, Gemini CLI,
Cursor, Copilot CLI, and OpenCode. Because Claude Code currently uses its own
project path, the installer also creates `.claude/skills/dash-bored` as a link
to the same canonical payload. The skill itself follows the open Agent Skills
format and contains no agent-specific commands; `agents/openai.yaml` is optional
Codex presentation metadata that other clients ignore. Repeated installs are
safe, and modified installed files or conflicting paths are never overwritten.
You can also create these files without
opening the app by running
`dash-bored init .`; unlike `open`, explicit initialization fails if a
configuration, lock, or dashboard environment file already exists.

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
machine-readable contract for its JSON Schema props, named slots, and required
permissions. Agents use this version-matched catalog instead of guessing from
examples; invalid local components remain in the catalog with diagnostics.

`validate` and `inspect` accept a project root, a standalone bundle directory,
or the path to its `dash-bored.yaml`. A directory passed to `open` is the
project root; `open` also accepts an explicit `dash-bored.yaml` path. `init`
uses `--project <path>` to select another project root because its positional
argument is the optional bundle name.
Running the desktop app without a project presents a project chooser; selecting
an uninitialized project creates the same root-level `dash-bored/` structure
before loading it. The selected folder is always the project root, even when
that folder is itself named `dash-bored`.

## Configure a dashboard

`dash-bored/dash-bored.yaml` contains one recursive component node:

```yaml
schemaVersion: 1
name: Example project
root:
  component: "@dash-bored/stack"
  props:
    gap: medium
  slots:
    children:
      - id: intro
        component: "@dash-bored/markdown"
        props:
          content: |
            # Development
            Project controls and status live here.
      - id: api-status
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
- `slots`: named child nodes, either a single node or an array.

The `root` is a normal component node. A dashboard may use a layout tree, but
it may just as well have one command button, status, or project component as
its root. In the app, any rendered component can also be focused as a temporary
virtual root; breadcrumbs return to its configured ancestors without changing
the YAML.

The initial built-ins are:

- Layout: `@dash-bored/tabs`, `@dash-bored/split`, `@dash-bored/stack`, and
  `@dash-bored/card`.
- Display: `@dash-bored/text`, `@dash-bored/markdown`, and
  `@dash-bored/status`.
- Host-backed: `@dash-bored/command`, `@dash-bored/terminal`,
  `@dash-bored/file`, `@dash-bored/env`, and `@dash-bored/webview`.

`@dash-bored/env` takes a relative `path` prop, reads a project-local dotenv
file, and provides a key-value editor with a bulk/raw mode. Saving requires
project trust because the component requests both `filesystem:read` and
`filesystem:write`; comments, blank lines, and unrecognized lines remain in
place when editing through the key-value view.

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

### Edit a dashboard in the app

Expand the project sidebar and use the pencil button beside a dashboard to
enter edit mode. The editor works directly with the configured component tree:

- drag components between declared slots or use the up/down controls;
- use the small insertion controls, or the large `+` in an empty slot, to add
  a built-in or discovered project-local component;
- configure props through fields generated from `propsSchema`, with Advanced
  JSON available for arrays, objects, and other schema shapes;
- replace the dashboard root with any available component; compatible root
  slots carry their children across, while incompatible nested content is
  called out before it is removed from the draft;
- remove a component and its subtree after confirmation.

Changes remain a renderer-only draft until **Save dashboard** is selected.
Save is disabled while the draft has validation errors. **Cancel** discards the
whole draft. If `dash-bored.yaml` changes outside the app after editing starts,
the save is rejected instead of overwriting that newer source.

The pencil edits the YAML bundle that owns the currently focused component.
Focus content rendered from a config-link component to edit that standalone
bundle; composition boundaries remain separate, and each save rewrites only
the source path shown in the editor toolbar.

### Remove a dashboard

Expand the project sidebar, then hover a dashboard row or focus it with the
keyboard to reveal its trash button. Removing a dashboard deletes its entry
from dash-bored’s remembered dashboard registry; this is the default and leaves
the project files untouched.

The confirmation dialog previews direct and transitive standalone-config links
from other remembered dashboards, including the affected config paths. If the
dependency scan is incomplete because a link is broken, unreadable, or may
execute arbitrary local component code, project file removal is disabled.
Otherwise, you may select **Also move project files
to Trash**. This moves only the app-owned `project/dash-bored/` directory (and
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
configured `@dash-bored/command` processes, and actions contributed by active
local components.

## Author a project component

Create a directory below the project's component root:

```text
project/dash-bored/components/service-health/
├── component.yaml
├── index.tsx
└── styles.css                 # optional
```

Define its metadata, props, slots, and least-privilege permissions in
`component.yaml`:

```yaml
schemaVersion: 1
id: service-health
name: Service health
description: Checks the development service.
entry: ./index.tsx
propsSchema:
  type: object
  additionalProperties: false
  required:
    - endpoint
  properties:
    endpoint:
      type: string
slots:
  children:
    required: false
    multiple: true
permissions:
  - network:http
```

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

export default defineComponent<Props>(({ props, slots, host }) => {
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
      {slots.children}
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
| `process:execute` | `host.shell.run(request)` | Run a short, output- and time-bounded command. |

Register actions in an effect and return the disposer, as in the example.
Local action IDs start with a letter and may contain letters, digits,
underscores, and hyphens. Actions may also declare `enabled`, a
`disabledReason`, and confirmation copy. They exist only while that trusted
component instance is mounted and do not add permissions; action callbacks use
the same shaped host APIs as the component UI.

The desktop app asks the user to trust the project before compiling local code
or enabling privileged built-ins. The main process checks the supplied node ID
and its declared capability on every host request. A reload that adds a
requested permission requires a new trust decision; the same or a smaller
permission set preserves the existing decision.

Local components are trusted project code running together in one renderer,
not a hostile-code sandbox. Their per-node permissions shape the provided API
and prevent accidental capability use, but do not isolate local components from
one another; sufficiently adversarial trusted code could forge another node's
ID at the internal RPC layer. Project trust is the v1 security boundary.

Use `@dash-bored/command` for a user-controlled long-running process. It starts
only after an explicit click. Pair it with `@dash-bored/terminal` for read-only
streamed output; the terminal is not an interactive PTY.

## Current boundaries

The developer build supports one project per window and local components only.
It does not yet include external package resolution, a component marketplace,
interactive terminals, file editing, multi-project windows, or custom AI
infrastructure. Those omissions are intentional until the core runtime is
proven.
