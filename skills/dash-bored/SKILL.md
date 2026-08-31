---
name: dash-bored
description: Create, configure, or improve a dash-bored project dashboard. Use when a user wants project workflows, status, documentation, commands, or local tools composed in dash-bored.
---

# Build with dash-bored

Turn the project into a useful local cockpit, not a generic component demo.

## Start from the project

Read the project's instructions and inspect its actual scripts, services,
documentation, and existing `dash-bored/` tree before editing. Preserve
unrelated work and existing dashboard workflows.

Run `dash-bored inspect .` before composing the dashboard. Its
`componentCatalog` is the version-authoritative description of every available
built-in and local component. For each entry, use `manifest.propsSchema` for
props, `manifest.children` for child cardinality and presentation, and
`manifest.permissions` for
the trust impact. Check `available` and `diagnostics`; do not guess a component
shape from its name or from this skill.

The desktop app puts its matching CLI on `PATH` and also exports its absolute
path as `DASH_BORED_BUNDLED_CLI`. If `dash-bored` is not otherwise resolvable,
run `"$DASH_BORED_BUNDLED_CLI"` with the same arguments.

If the project is not initialized, run `dash-bored init .`. A standalone bundle
owns its own `dash-bored.yaml`, `dash-bored-lock.yaml`, `.env`, and
`components/` directory. Named bundles do not inherit from the canonical one;
compose one by referencing its bundle path as a component.

## Compose the dashboard

Edit `dash-bored/dash-bored.yaml` as recursive core-owned composition topology.
Give every
stateful, actionable, or resource-producing node an explicit ID
that is unique across the tree.

Prefer the generic built-ins:

- Composition: `@dash-bored/group` for transparent child-surface projection,
  plus core-owned tiled branches and managed child presentation.
- Display: `@dash-bored/markdown`, `@dash-bored/text`, and
  `@dash-bored/status`.
- Project capabilities: `@dash-bored/command`, `@dash-bored/terminal`,
  `@dash-bored/file`, `@dash-bored/env`, `@dash-bored/todo-list`, and
  `@dash-bored/webview`.

Use tiled child topology for layouts. A tiled layout is either a child leaf or
a split with `axis`, `ratio`, `first`, and `second`; a managed layout contains
`items` with optional edge metadata. Horizontal and vertical resizing belong to
the core topology. `@dash-bored/group` is only a transparent component
boundary/projection wrapper; it is not a layout engine. Do not add grid
coordinates or size props to arbitrary components.

Use commands for explicit user actions; they never need to start automatically.
Pair a long-running process resource with a terminal whose `processId` refers
to that resource. Keep file and environment paths relative to the project root. Put
editable runtime choices in the bundle-local `.env` and source that file from
commands that consume them. Do not put secrets directly in dashboard YAML or
assume an environment file is ignored by version control.

Balance explanation with working controls. A new user should understand what a
panel does, while a returning user should be able to run the common workflow
without rereading a tutorial. Prefer real project status and repeatable tasks
over decorative examples.

## Add local components only when useful

When built-ins cannot express the need, create a small component under the
bundle's `components/<name>/` directory with `component.yaml`, `index.tsx`, and
optional CSS. Reference it as `./components/<name>`.

Read [references/components.md](references/components.md) before authoring a
local component. It defines the manifest, renderer API, capability mapping,
import boundary, and validation loop shipped with this dash-bored version.

Declare only the permissions the component uses: `filesystem:read`,
`filesystem:write`, `network:http`, `process:execute`, `process:observe`, or
`webview:embed`. Local component code
may use relative contained TypeScript, TSX, and CSS imports plus
`@dash-bored/component`; do not add bare package imports or reach outside its
directory. Project trust is the security boundary, so keep privileged behavior
visible and intentional.

## Verify UI changes visually

For renderer UI work, start the isolated proof fixture with `bun run
ui:fixture`, then open `http://127.0.0.1:5488/ui-harness.html` in the available
browser-control surface. It mounts the normal `App` with deterministic fixture
data, so inspect the actual CSS, sidebar, tabs, component library, and tiled
composition—not a static mock. Check a normal desktop viewport and a narrow
`390×844` viewport. Capture a screenshot or inspect layout geometry after any
meaningful interaction.

The fixture is renderer-only. Never present it as proof of native desktop
behavior. For native chrome, Electrobun webview overlays, or desktop pointer
input, inspect the running Electrobun app separately and first confirm its
header config path identifies this checkout. If the native surface is blocked,
report the renderer fixture coverage and the exact missing native coverage;
never kill a user-owned watcher just to obtain a smoke test.

## Validate the result

Run `dash-bored validate .` after editing. Resolve validation or compilation
errors rather than leaving the dashboard on its last-known-good snapshot. For a
more detailed structural check, run `dash-bored inspect .` again and confirm
the resolved tree and catalog match the intended configuration.

Summarize the useful workflows exposed, any permissions added, and which
runtime or native interactions were not exercised.
