---
name: dash-bored
description: Create, configure, or improve a dash-bored project dashboard. Use when a user wants project workflows, status, documentation, commands, or local tools composed in dash-bored.
---

# Build with dash-bored

Turn the project into a useful local cockpit, not a generic component demo.
A new user should understand what each panel does; a returning user should run
the common workflow without rereading a tutorial. Prefer real project status
and repeatable tasks over decorative examples.

## Start from the project

Read the project's instructions and inspect its actual scripts, services,
documentation, and existing `dash-bored/` tree before editing. Preserve
unrelated work and existing dashboard workflows.

The desktop app puts its matching CLI on `PATH`, so use `dash-bored` directly.
Available commands: `init`, `install-cli`, `install-skill`, `open`,
`validate`, `inspect`, `agent`. Run `dash-bored inspect .` before composing:
its `componentCatalog` is the version-authoritative description of every
available built-in and local component. For each entry, use
`manifest.propsSchema` for props, `manifest.children` for child cardinality
and presentation, and `manifest.permissions` for the trust impact. Check
`available` and `diagnostics`; never guess a component shape from its name or
from this skill.

If the project is not initialized, run `dash-bored init .`. A standalone
bundle owns its own `dash-bored.yaml`, `dash-bored-lock.yaml`, `.env`, and
`components/` directory. Named bundles (`dash-bored init <name ...>`) are
organization, not inheritance: they share nothing implicitly. Compose one by
referencing its bundle path as a component (e.g. `component: "./arvid"`); it
renders in the allocated rectangle with its own lock, env, and components.

## Compose the dashboard

`dash-bored.yaml` (`schemaVersion: 2`) is the only source of truth: one
recursive root node plus core-owned tiled/managed topology. There is no hidden
grid database. Give every stateful, actionable, or resource-producing node an
explicit `id` unique across the tree (omitted IDs derive from the YAML path,
but anything with state, actions, or a process resource needs a stable one).

Structure:

- **Tabs per workflow.** `@dash-bored/tabs` is the usual root. It takes
  managed children (`type: managed`, `items` list); each edge carries the tab
  label as `metadata: { label: ... }`. Labels live on the parent-child edge,
  not in component props.
- **Splits for layout.** Tiled children are leaves or splits with `axis`
  (`horizontal` | `vertical`), `ratio` (0.1–0.9, the project default
  first-pane fraction), `first`, and `second`. Nest them for tiled layouts.
  Never add grid coordinates or size props to components; horizontal/vertical
  resizing belongs to the core topology.
- **Cards for framing.** `@dash-bored/card` takes optional `title` and
  `description` plus tiled children. Use it to group one workflow panel.
- **`@dash-bored/group`** is only a transparent component boundary that
  projects a tiled child surface. It is not a layout engine.
- **`@dash-bored/conditional`** wraps exactly one tiled child shown while a
  bounded shell `command` succeeds; `invert: true` means "show until done"
  for setup/recovery actions. Optional `cwd`, `env`, `timeoutMs`,
  `pollIntervalMs`. Requires `process:execute`, polls only while its panel is
  visible, and fails open before trust or when the check cannot run.

Pick components by need:

- `@dash-bored/markdown` — safe Markdown preview (no raw HTML) from inline
  `content` **or** project-relative `path` (one is required). Preview is the
  default; Raw/edit exposes Save/Cancel editing. Use for explanations,
  runbooks, and project docs next to the controls that act on them.
- `@dash-bored/status` — labeled indicator: `label`, `state`
  (`unknown`/`healthy`/`warning`/`error`), optional `detail`.
- `@dash-bored/command` — explicit user action in a persistent interactive
  terminal. Its `command` (`label` + `command`, optional `cwd`/`env`) is a
  remembered quick action; users can keep typing in the same shell. Commands
  never auto-start on open, trust, or reload. Keep paths relative to the
  project root.
- `@dash-bored/env` — edits a project-local dotenv file (`path`) via
  key-value or bulk/raw editing. Key-value saves preserve comments and blank
  lines; writes are bounded, project-contained, and atomic.
- `@dash-bored/todo-list` — small list kept in the node's own YAML props as
  `todos: [{ description, done, tags }]`. Sorts open items first, filters by
  tag, edits through the normal draft Save/Cancel boundary.
- `@dash-bored/chart` — static line/bar chart from YAML `labels` + `series`
  (`[{ label, values, color? }]`), optional `title`, `type`, `maxPoints`.
- `@dash-bored/live-chart` — polls an HTTP JSON endpoint returning that same
  chart model. `endpoint` may be absolute `http(s)://` or app-relative
  (`/...`); optional dot-separated `dataPath`, `pollIntervalMs`
  (1000–300000), `maxPoints`. Requires `network:http`; keeps the last valid
  result on refresh failure and stops polling while its tab is hidden.
- `@dash-bored/webview` — embeds an `http(s)://` application page (e.g. a
  local dev server or service UI). Requires `webview:embed`. Native surfaces
  initialize only while their tab is visible; prefer it for "which browser
  tab has the local UI" problems.

Proven patterns from this repo's own dashboard: a component that reads one
project file and exposes a refresh action (`project-pulse`); a component that
turns config entries into palette actions (`package-scripts` reads
`package.json` scripts); a bounded-shell observer panel (`git-branches`).

## Respect app-owned behavior

These are renderer/app state, never YAML — do not try to configure them:

- **Draft Save/Cancel.** The component-library flyout opens read-only; the
  first insertion, move, removal, replacement, metadata edit, or ratio resize
  starts a draft. Save validates and atomically publishes the owning bundle's
  YAML; Cancel discards it. The per-node Edit dialog edits declared props and
  child metadata through the same boundary.
- **Presentation state.** Collapse/expand, Focus-as-temporary-root (with
  breadcrumbs back), runtime split-ratio drags, and surface height caps are
  per-user, keyed by config path and node ID, persisted locally. They never
  change YAML. Collapsing unmounts a subtree (stops polling/views) but does
  not stop a running command process.
- **Command palette** (`Command/Ctrl+K`) merges app navigation/lifecycle,
  per-node Focus actions, process start/stop derived from declared resources,
  and actions registered by mounted local components. Known actions stay
  searchable while unavailable, with a reason. Users favorite actions and
  assign shortcuts in Settings (General/Actions tabs); favorites sort first
  without bypassing trust or availability.
- **Node menu.** Every rendered node offers Focus, Edit component, Collapse /
  Expand, Copy component path (a YAML locator for agent prompts), and Change
  with agent.
- **Agent integration.** The app-wide `DASH_BORED_AGENT` setting (Settings →
  General; starter `.env` holds an editable default) selects the CLI used by
  Change-with-agent, Fix-with-agent (in diagnostics details), the Agent work
  drawer (Working/Not working items with terminal / bundle-diff / full-command
  tabs), and the flyout's natural-language "build a component" fallback. Agent
  context travels in `DASH_BORED_AGENT_PROMPT` as one quoted argument. This is
  a narrow harness around the user's CLI, not a provider integration.
- **Trust.** One project-level decision over the union of all resolved
  component permissions, keyed by canonical project root. Untrusted projects
  still parse and render safe layout/inline content but cannot compile local
  code, run commands, touch files, fetch HTTP, or embed webviews. Adding a
  permission invalidates trust and asks again.
- **Reload vs recovery.** `Reload dashboard` rereads config and keeps the
  last-known-good tree on validation failure. `Reload app` only reloads the
  renderer window.

## Environment and secrets

Put editable runtime choices in the bundle-local `.env` and source that file
from commands that consume them. Never put secrets in dashboard YAML, and do
not assume `.env` is git-ignored — check. `DASH_BORED_AGENT` /
`DASH_BORED_AGENT_PROMPT` starter values live there; the app also publishes
the configured agent command into dashboard command environments.

## Add local components only when useful

When built-ins cannot express the need, create a small component in the owning
bundle's `components/<name>/` directory with `component.yaml`, `index.tsx`,
and optional relative TS/TSX/CSS. Reference it as `./components/<name>`.

Read [references/components.md](references/components.md) before authoring.
It defines the manifest, renderer API, capability mapping, import boundary,
and validation loop shipped with this dash-bored version. Essentials:

- Manifest: `schemaVersion: 2`, `id`, `name`, `description`, `entry`,
  `renderMode` (`surface` default; `layout` only when height must follow
  descendants), `propsSchema` (JSON Schema), one `children` contract (`min`,
  optional `max`, `presentation: { type: tiled, axes }` or
  `{ type: managed }` + optional `metadataSchema`).
- Declare only the permissions used: `filesystem:read`,
  `filesystem:write`, `network:http`, `process:execute`, `process:observe`,
  `webview:embed`. Each maps to exactly the host methods the component gets;
  packaged and local components share the same host contract.
- A component needing a long-running process declares a `resources.process`
  mapping (`commandProp`, optional `cwdProp`/`envProp`,
  `interactive: true` for a PTY-backed shell) with `process:execute`; other
  components observe it via `references: { processId: { resource: process } }`
  with `process:observe`. Resource nodes require stable IDs, and palette
  start/stop actions derive from these resources.
- TSX imports only contained relative files plus `@dash-bored/component`
  (`defineComponent`, hooks); no bare package imports, no Node/Electrobun
  APIs, nothing outside the component directory. Register palette actions via
  `host.actions.register` (IDs: letter-first, letters/digits/`_`/`-`) and
  return its disposer from the effect. Render projected children through the
  generic child surface.
- Validation loop: reuse a built-in if one fits → add manifest + code → add
  the node to the owning `dash-bored.yaml` → `dash-bored validate .` (also
  compiles local code) → `dash-bored inspect .` to confirm catalog
  availability, permissions, and tree placement. Keep privileged behavior
  visible, bounded, and user-initiated where practical.

## Verify UI changes visually

For renderer UI work, start the isolated proof fixture with `bun run
ui:fixture`, then open `http://127.0.0.1:5488/ui-harness.html` in the available
browser-control surface. It mounts the normal `App` with deterministic fixture
data — inspect the actual CSS, sidebar, tabs, component library, and tiled
composition, not a static mock. Check a normal desktop viewport and a narrow
`390×844` viewport. Capture a screenshot or inspect layout geometry after any
meaningful interaction.

The fixture is renderer-only; never present it as native desktop proof. For
native chrome, Electrobun webview overlays, or desktop pointer input, inspect
the running Electrobun app separately and first confirm its header config path
identifies this checkout. If the native surface is blocked, report the
renderer fixture coverage and the exact missing native coverage; never kill a
user-owned watcher just to obtain a smoke test.

## Validate the result

Run `dash-bored validate .` after editing. Resolve validation or compilation
errors rather than leaving the dashboard on its last-known-good snapshot. Run
`dash-bored inspect .` again and confirm the resolved tree and catalog match
the intended configuration.

Summarize the useful workflows exposed, any permissions added, and which
runtime or native interactions were not exercised.
