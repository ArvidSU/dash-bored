# dash-bored - Architecture: Lifecycle and CLI

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

## CLI surface

The package exposes a `dash-bored` executable through its `bin` field:

```text
dash-bored init [name ...] [--project <path>]
dash-bored install-cli [--check]
dash-bored install-skill [project] [--global] [--check]
dash-bored validate [project] [--json]
dash-bored inspect [project] [--summary | --component <reference>]
dash-bored open [project]
dash-bored component add <url> [--name <name>] [--ref <ref>] [project]
dash-bored component list [project]
dash-bored component status [<name>] [project]
dash-bored component update <name> [--to <ref>] [project]
dash-bored component remove <name> [project]
dash-bored component sync [project]
```

- `init` and `init .` target the canonical bundle in the current project;
  `--project <path>` selects another project root. Initialization creates the
  required files and empty component directory, uses the bundle name in a valid
  guided dashboard with an editable bundle-local `.env` file, a
  first-class setup-agent component that invokes the configured app-owned
  dashboard-agent harness with the app-wide `DASH_BORED_AGENT` override when
  set, and a
  command that installs the packaged dash-bored skill into the project. The
  starter presets a bundle-local `icon` (`./assets/icon.svg`, a silent generic
  glyph until the file exists), and its agent prompt instructs the agent to
  generate a project-customized SVG there while building the cockpit. It
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
  reference are text assets embedded in the standalone executable. Detailed
  app-state guidance lives in the separately embedded `references/app-runtime.md`
  so routine dashboard authoring need not load it. The
  generated per-component built-in reference
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
  not confer ownership of the rest. `--check` performs the same ownership and freshness
  checks without creating or changing files. `--global` does not accept a
  project path.
- `install-cli` creates a symlink from `~/.local/bin/dash-bored` to the CLI
  bundled in the application on macOS or Linux. It is an explicit user action,
  reports when that directory is absent from `PATH`, and refuses to replace an
  existing file or a link to another target. A `.dash-bored-cli.json` receipt
  records the bundled source and version so an existing dash-bored link can be
  refreshed safely; `--check` reports missing or stale links without changing
  them. The Windows app still carries the CLI for in-app use, but this
  shell-link command is not yet supported there.
- `validate` runs project, manifest, resolver, schema, and local compilation
  validation. It emits stable diagnostics and a non-zero status on errors.
- `inspect --summary` emits project status, diagnostics, permissions and a compact
  catalog without schemas or repeated tree/config data. `--component <reference>`
  emits one authoritative catalog entry (including its schema) and project
  diagnostics. Unknown references fail; modes cannot be combined. Full
  `inspect` writes JSON describing the resolved tree, the complete component
  catalog, component metadata used by the tree, requested permissions, and
  diagnostics. Agents read `componentCatalog[].manifest.propsSchema`, `children`,
  and `permissions` before editing instead of relying on static examples.
- `open` creates any missing project artifacts, validates the resulting
  dashboard, launches the packaged desktop application when invoked by its
  embedded or linked CLI (and the development application from source), and
  forwards termination signals.
- `component add <url> [--name] [--ref]` clones a component repository as a
  git submodule below `components/external/` and pins its commit in
  `dash-bored-lock.yaml`. `list` shows pinned externals, `status [<name>]`
  reports pin drift, dirty checkouts, and uninitialized checkouts (a lone bare
  argument is a component name; pass a path to target another project),
  `update <name> [--to]` moves a pin,
  `remove <name>` detaches a submodule, and `sync` initializes or updates
  checkouts to their pinned commits. A pin change re-runs the permission-union
  trust check. The renderer never runs these commands; the library flyout
  previews their exact text with a one-click copy.

`bun run build:cli` uses Bun's standalone-executable build to inline the CLI,
its core dependencies, and the skill text assets into `dist/tools/dash-bored`.
Electrobun copies `dist/tools/` into the application resources. At main-process
startup dash-bored prepends that resource directory to the inherited `PATH`
and publishes the exact CLI and app-launcher paths. Consequently every built-in
command, long-running process, local-component shell call, and CLI agent
launched from the dashboard can resolve the matching CLI without a global
installation. The optional shell link resolves back into the application, so
`dash-bored open` can locate the packaged launcher.

Project artifacts are published atomically and never overwritten by
initialization. Explicit `init` remains strict: an existing configuration, lock,
or environment file is an error.
Opening is idempotent and fills in missing required artifacts while preserving
those that already exist.

At application startup, the main process refreshes only previously installed
global and registered-project skills and the managed CLI link. It skips absent
installations, keeps successful maintenance out of the diagnostics snapshot,
and reports only conflicts or unexpected failures. It never makes the refresh a
prerequisite for opening a dashboard. A project skill is checked once when that
project is opened; any unresolved installed-tool diagnostics are retained on
later load and reload snapshots.

The Installed tools diagnostics panel exposes an explicit recovery action for
`INSTALLED_TOOL_UPDATE_CONFLICT`. The main process derives targets from its own
diagnostics, moves the conflicting managed skill directory and Claude alias or
CLI link and receipt to the OS Trash, then installs the current bundled payload.
It never accepts paths from the renderer or silently replaces conflicts during
startup; a failed repair remains a warning so the action can be tried again.

`update` and `migrate` share the coordinator and receipt formats documented in
[Distribution](./distribution.md#unified-update-release-contract). They can
inspect release/migration status without a loaded dashboard or an app window.
Non-interactive updates reject an omitted migration choice, including `--yes`
alone. `update resume` reconciles an explicitly authorized update after the
new bundled CLI is installed; cancelled and interrupted agent work is not
implicitly reauthorized. `migrate --dashboard <path>` is the explicit retry.
