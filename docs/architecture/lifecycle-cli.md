# dash-bored - Architecture: Lifecycle and agent tools

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

The application shell exposes a separate renderer recovery operation from its
dashboard reload. `Reload app` reloads the current webview, and the native
application menu binds it to `CommandOrControl+Shift+R`; the command palette
also invokes it. `Reload dashboard` remains the project-scoped operation that
rereads configuration and preserves the last known-good tree when validation
fails.

## Agent tool surface

Users work in the desktop app; nothing dash-bored is installed on `PATH`.
Agents use the tool that ships with the skill. `bun run build:cli` compiles
`src/cli/index.ts` with Bun's standalone-executable build, inlining core
dependencies and the skill text assets, into `dist/tools/dash-bored`, which
Electrobun copies into the app resources. The package has no `bin` entry; a
source checkout runs the same entrypoint with `bun run dash-bored -- <command>`.

```text
dash-bored init [name ...] [--project <path>]
dash-bored install-skill [project] [--global] [--check]
dash-bored validate [project] [--json]
dash-bored inspect [project] [--summary | --component <reference>]
dash-bored migrate inspect <dashboard>
dash-bored component add|list|status|update|remove|sync ...
dash-bored theme init|validate|list|status|add|update|remove|sync ...
dash-bored app status [--instance <identifier>]
dash-bored app actions [--all] [--instance <identifier>]
dash-bored app run <action> [--select <choice>=<option> ...] [--instance <identifier>]
dash-bored app open <dashboard> [--instance <identifier>]
dash-bored app screenshot [--focus <node-id>] [--output <file.png>] [--instance <identifier>]
```

### Resolution and version matching

The skill payload contains the launcher `scripts/dash-bored`, installed with
mode 0755. It resolves the tool in order from `DASH_BORED_TOOL`, the path the
canary release app records in `~/.config/dash-bored/tool-path`, and the conventional
`/Applications` and `~/Applications` bundles, then execs it with
`DASH_BORED_SKILL_DIR` set. When that directory's `skill-version.json` names
another version than the tool, the tool warns on stderr. At startup the main
process sets `DASH_BORED_TOOL` to the bundled tool's absolute path and
`DASH_BORED_APP_INSTANCE` to its app identifier in its own environment, so
dashboard commands, conditional checks, and every agent it launches inherit
both. `PATH` is left unchanged.

Earlier releases could link the CLI into `~/.local/bin`. At startup the app
removes that link and its `.dash-bored-cli.json` receipt only when the receipt's
source equals the link target and that target is a bundled
`Contents/Resources/app/tools/dash-bored`; any other file is left alone.

### Commands

- `init` and `init .` target the canonical bundle in the current project;
  `--project <path>` selects another project root. Initialization creates the
  required files and empty component directory, uses the bundle name in a valid
  guided dashboard with an editable bundle-local `.env` file, a
  `agent:prompt` button that opens a reviewed starter prompt in the configured
  app-owned agent harness with the app-wide `DASH_BORED_AGENT` override when
  set, and conditional commands that install the packaged skill globally or
  into the project through `"$DASH_BORED_TOOL"`. The
  starter presets a bundle-local `icon` (`./assets/icon.svg`, a silent generic
  glyph until the file exists), and its agent prompt instructs the agent to
  generate a project-customized SVG there while building the cockpit and to
  check the result with `app screenshot`. It never overwrites existing files.
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
  than a runtime dependency. The skill, metadata, launcher, and
  local-component reference are text assets embedded in the standalone
  executable. Detailed app-state guidance lives in the separately embedded
  `references/app-runtime.md` so routine dashboard authoring need not load it.
  The generated per-component built-in reference
  (`references/builtins.md`, rendered by `bun run generate:components` from
  `BUILTIN_COMPONENTS`) is embedded the same way; see
  `docs/architecture/components.md` ("Generated built-in reference").
  Installation is idempotent when files and aliases match and refuses to
  replace modified files or conflicting paths. A `skill-version.json` sidecar
  records the shipped version and SHA-256 hash of each payload file, allowing
  later installs to update files previously owned by dash-bored while
  preserving local edits. A receipt-free installation is adopted only when all
  three files exactly match the recorded hashes for one complete v0.2.2 or v0.2.3 release. Partial, mixed,
  or customized legacy payloads remain conflicts; individual matching files do
  not confer ownership of the rest. An unchanged launcher that lost its
  executable bit is restored. `--check` performs the same ownership, freshness,
  and launcher-mode checks without creating or changing files. `--global` does
  not accept a project path.
- `validate` runs project, manifest, resolver, schema, and local compilation
  validation. It emits stable diagnostics and a non-zero status on errors.
- `inspect --summary` emits project status, diagnostics, permissions and a compact
  catalog without schemas or repeated tree/config data. `--component <reference>`
  emits one authoritative catalog entry (including its schema) and project
  diagnostics. Unknown references fail; modes cannot be combined. Full
  `inspect` writes JSON describing the resolved tree, the complete component
  catalog, component metadata used by the tree, requested permissions, and
  diagnostics. Agents read `componentCatalog[].manifest.propsSchema`, `children`,
  `actions`, and `permissions` before editing instead of relying on static
  examples.
- `migrate inspect <dashboard>` reports whether the dashboard needs migration to
  the tool's contract, with the applicable cumulative recipes. Installing
  releases and authorizing app-driven migrations are user workflows in the app.
- `component add <url> [--name] [--ref]` clones a component repository as a
  git submodule below `components/external/` and pins its commit in
  `dash-bored-lock.yaml`. `list` shows pinned externals, `status [<name>]`
  reports pin drift, dirty checkouts, and uninitialized checkouts (a lone bare
  argument is a component name; pass a path to target another project),
  `update <name> [--to]` moves a pin,
  `remove <name>` detaches a submodule, and `sync` initializes or updates
  checkouts to their pinned commits. A pin change re-runs the permission-union
  trust check. The library flyout runs the same core operations in the app for
  the active dashboard.
- `theme` scaffolds, validates, lists, and manages theme packages; see
  [Themes](./themes.md). Settings runs the same package operations in the app.

### App control

`app` commands reach one running app over its agent-control channel. Each app
instance serves HTTP on a user-private Unix socket
(`~/.config/dash-bored/run/<identifier>.sock`, directory 0700, socket 0600; a
hashed name keeps long identifiers within the platform path limit) and
publishes `<identifier>.json` with its pid, version, socket, and tool path,
withdrawn on quit. The instance identifier is the app identifier plus its
channel (for example `dev.dash-bored.app.canary`), because release and
development builds share the app identifier. The tool selects `--instance`, else
`DASH_BORED_APP_INSTANCE`, else the only live instance; several live instances
without a choice are an error that lists them. Worktree and development
instances therefore never answer for the release app by accident.

| Route | Behavior |
| --- | --- |
| `GET /v1/status` | Instance record plus renderer view state: view, config path, dashboard name, focused node, draft editing, diagnostic counts. |
| `GET /v1/actions` | Every palette action with id, stable reference, availability, choices, and a refusal reason when the agent may not run it. `app actions` hides unavailable and refused actions unless `--all` is passed. |
| `POST /v1/actions/run` | Resolves an id or reference in the renderer's action index and runs it through the palette's `ActionExecutor`, then waits for two animation frames. |
| `POST /v1/open` | Loads a dashboard path the way an app launch for that path does, so it is registered; trust stays a separate decision. Refused while a draft is open. |
| `POST /v1/screenshot` | Waits for the renderer to paint and returns the app window as PNG. |

The channel refuses all `agent:*` actions. In particular, `agent:prompt` requires the desktop composer to show the resolved command and configured prompt and wait for the user's explicit Send.

Main owns the socket and relays to the renderer through `webview.requests`
(`agentViewState`, `agentListActions`, `agentRunAction`, `agentSettle`); the
renderer shell registers the handler because it owns action, focus, and view
state. `app screenshot --focus <node-id>` first runs `focus:<node-id>` unless
that node is already focused. The action policy and capture boundary are
described in [Security](./security.md#agent-control-channel).

At application startup, the main process refreshes only previously installed
global and registered-project skills. It skips absent installations, keeps
successful maintenance out of the diagnostics snapshot, and reports only
conflicts or unexpected failures. It never makes the refresh a prerequisite
for opening a dashboard. A project skill is checked once when that project is
opened; any unresolved installed-tool diagnostics are retained on later load
and reload snapshots.

The Installed tools diagnostics panel exposes an explicit recovery action for
`INSTALLED_TOOL_UPDATE_CONFLICT`. The main process derives targets from its own
diagnostics, moves the conflicting managed skill directory and Claude alias to
the OS Trash, then installs the current bundled payload. It never accepts paths
from the renderer or silently replaces conflicts during startup; a failed
repair remains a warning so the action can be tried again.

Project artifacts are published atomically and never overwritten by
initialization. Explicit `init` remains strict: an existing configuration, lock,
or environment file is an error. Opening a project in the app is idempotent and
fills in missing required artifacts while preserving those that already exist.

Update and migration state share the coordinator and receipt formats documented
in [Distribution](./distribution.md#unified-update-release-contract). The app
is their only installation surface; `migrate inspect` is the agent's read-only
view of the same bundled recipes.
