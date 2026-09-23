# Atoms roadmap

Work packages that move dash-bored toward the atom set described in
[IDEA.md](../IDEA.md#atoms-not-a-browser-and-not-a-product): few,
well-executed atoms for overview, act, and observe, with the shell as the
integration layer.

This file is a plan, not a contract. When a package lands, move its decisions
into the relevant page under [docs/architecture/](../architecture/), update
README.md and the skill references, and mark the package done here. Anything a
package defers goes to `props.todos` of node `yaml-todo` in the project
dashboard.

Land additive contracts first. Existing dashboards and local components must
keep working between packages; enforce a replacement contract only after its
users have migrated. Exercise each new atom against one real project-dashboard
case as it lands, then complete the full replacement in WP10.

## Implementation status

| Package | Status | Evidence and remaining work |
|---|---|---|
| WP1–WP5 | Implemented additively | Stable ID references, declared and parameterized actions, bounded sources, and source-bound views validate in the project dashboard. Schema-v3 compatibility forms remain until WP9. |
| WP6 | In progress | Source lists, per-item actions, stable todo IDs, and todo remediation are working. The editable YAML todo presentation still has its own renderer; unify it with the shared list view while preserving draft edits. |
| WP7–WP8 | Implemented additively | One action bar replaces the navigation buttons; root and documentation sections use selection containers and tab bars. The library inserts a Switchable panels pattern. |
| WP9 | In progress | `group` accepts title and description, the focus timer is a local example, and starter setup uses a reviewed `agent:prompt` button with the shared validation supervisor. Source-bound edge visibility and the schema-v4 migration remain. |
| WP10 | Implemented | Branches, package scripts, and project pulse now use YAML plus scripts. The script list's Run action passes item values to a command and exposes invocation and process results. |

The remaining WP6 and WP9 work is tracked in `yaml-todo` so the additive
implementation stays usable while the migration is completed.

## Target atom set

| Job | Atoms |
|---|---|
| Overview | core tiles, `group` (optional title/description), single-child selection, focus |
| Act | action model, `button` with one action or an action bar, per-item actions, `command` |
| Observe | sources (`shell`, `file`, `http`, `process`, inline), views: `status`, `list`, `chart`, `markdown`; `env` editor |

Retired builtins: `tabs`, `card`, `conditional`, `live-chart`, `setup-agent`,
`focus-timer` (moves to an example local component).

## Proof of done

The roadmap is complete when, in the project dashboard:

- `git-branches`, `package-scripts`, and `project-pulse` are replaced by YAML
  plus a small script each, with no local React;
- `yaml-todo` offers a "Remediate with agent" item action declared in YAML;
- the root tabs are focus pages or a selection container with a tab-styled
  action bar, and no action reference uses a positional tree path.

## Dependency order

```
WP1 references ─┬─ WP2 declared actions ── WP3 args + agent:prompt ─┬─ WP6 list + item actions
                │                                                   └─ WP7 action bar
                └─ WP8 selection + reveal (needs WP7 for tab styling)
WP4 sources ── WP5 source-bound views ── WP6
WP9 consolidation after WP5, WP6, WP7, WP8
WP10 full dogfood proof last (small proofs start with WP4–WP6)
```

WP1 and WP4 can run in parallel.

---

## WP1 — Action references by node ID

**Goal:** A button's target survives any rearrangement.

- Action references name targets by node ID only (`focus:yaml-todo`,
  `component:project-pulse:refresh-project-pulse`).
- Editors create only ID references and unknown target IDs are load-time
  diagnostics. Existing schema-v3 dashboards keep resolving and warning on
  `${root.children…}` legacy references until the WP9 schema migration can
  rewrite them; then
  remove interpolation from `src/shared/action-reference.ts` and its tree
  resolution in `src/core/tree.ts`.
- The button editor offers a target picker that assigns an explicit `id` to a
  target node that lacks one.
- Prepare a deterministic migration helper that rewrites positional references
  to IDs, assigning IDs where needed; include it in the WP9 contract migration.
- Migrate the project dashboard (the three buttons in
  `command-palette-navigation-card`).

**Done when:** no positional reference remains in shipped or dogfood YAML;
moving a referenced node in the composition editor leaves the button working.

## WP2 — Manifest-declared actions

**Goal:** Actions are discoverable and checkable before their component
mounts.

- Manifests declare `actions: [{ id, label, description?, args? }]`, where
  `args` is a JSON Schema.
- Runtime `host.actions.register` supplies handlers only for declared IDs;
  registering an undeclared ID is a diagnostic for manifests that opt into the
  declared-action contract. Keep legacy dynamic registrations working until
  their owners migrate; `package-scripts` currently discovers action IDs from
  `package.json` and must not lose its palette actions before WP6/WP10.
- Validation checks `component:<node>:<action>` references against the target
  manifest.
- Palette and Settings list declared-but-unmounted actions with the reason
  "Component is not mounted", so collapsed or hidden components keep a stable
  catalog.
- `inspect --component` and the skill builtins reference show declared actions.

**Done when:** a button targeting a collapsed component shows a truthful
unavailable reason, and a typo in an action ID fails validation.

## WP3 — Parameterized actions and `agent:prompt`

**Goal:** Configuration can pass data to an action.

- Object reference form: `action: { run: <reference>, with: { … } }`; the
  string form stays for argument-free actions.
- `with` is validated against the declared `args` schema at load.
- Arguments pre-fill matching palette choice steps; remaining steps still
  prompt.
- New app action `agent:prompt` (`args: { prompt: string }`) runs the
  configured `DASH_BORED_AGENT` through the existing agent-work surface with
  the same context enrichment as "Change with agent".
- Invoking a configured agent prompt presents the resolved command and prompt
  for review and an explicit Send action, as the existing agent composer does.
  The main process revalidates the owning config and target before launch.
- The agent control channel refuses `agent:*`.

**Done when:** a YAML button can start an agent task with a fixed prompt and it
appears in the agent-activity panel.

## WP4 — Sources

**Goal:** One bounded way to observe anything.

- `source` prop shape shared by views:
  `{ shell | file | http | process | inline, every?, timeoutMs?, cwd?, env? }`.
- Output is JSON (or text for Markdown); size, timeout, and poll interval are
  bounded.
- Polling runs only while the consuming view is visible, like `conditional`
  and native webviews today; manual refresh is a declared action on every
  source-bound view.
- Permissions reuse `process:execute`, `filesystem:read`, `network:http`, and
  `process:observe`; `process:<id>` exposes the existing process snapshot
  (state, exit code, last run, duration) through the existing observe permission.
- Source states: loading, value, error (with stderr excerpt), stale.

**Done when:** a view can render the JSON output of a project script, and a
view bound to `process:run-qa` updates when that command exits.

## WP5 — Source-bound views

**Goal:** Observed state always comes from a source.

- `status` takes a `source` producing `{ state, detail? }`, or derives state
  from a process or shell exit code. Hand-written `state` is removed by
  migration (converted to an inline source, flagged for review).
- `chart` takes a `source`; inline data is an inline source. `live-chart`
  becomes a migration alias.
- `markdown` accepts a text source in addition to `content` and `path`.
- Each view declares its expected data shape; a mismatch is a visible
  diagnostic that names the shape, so an agent can correct its script.

**Done when:** `live-chart` has no implementation of its own and the
dashboard's status tiles are backed by sources.

## WP6 — List view and item actions

**Goal:** The atom behind todo lists, branch lists, and script catalogs.

- `list` renders `[{ id, title, detail?, tags?, state?, … }]` from a source, with
  tag filtering and open-first sorting where applicable.
- `id` is a stable, source-owned string independent of list order and display
  text. Duplicate or missing IDs produce a visible shape diagnostic. Migrate
  editable todo items to IDs before actions can target them.
- `itemActions: [{ name, action }]` declared once per list, with `${item.<field>}`
  templates in typed action arguments; absent fields and unsupported value
  types are validation/runtime diagnostics.
- Templated values reach processes only as `DASH_ITEM_<FIELD>` environment
  variables; templates inside shell command text are a validation error.
- `todo-list` becomes a list whose source is its own YAML props, editable
  through the draft boundary; its current editing behavior is preserved.
- Add "Remediate with agent" to `yaml-todo` using `agent:prompt`.

The remediation agent may edit the todo through the normal draft/validation
boundary; an action result alone never marks an item done.

**Done when:** `package-scripts` can be expressed as a list over a script that
emits `[{ id, title }]` with a run item action.

## WP7 — Action bar and result feedback

**Goal:** Remove one-node-per-button split nesting and close act→observe on
the control.

- `button` accepts either `action` or `items: [{ name, action }]`, with
  `variant: buttons | segmented | tabs`.
- When every item selects within one container, the bar exposes
  `role=tablist` semantics.
- The shared action executor records bounded, per-invocation running and last
  result state (outcome and time) for buttons, palette, and item actions. A
  successful process-start request means "started"; the supervised process
  snapshot supplies its later exit result. Agent launch and task validation
  are likewise distinct outcomes. Navigation/select actions show active state
  without a misleading success badge.
- A `process` source reads the authoritative supervised process snapshot;
  controls and views may present that snapshot alongside action-invocation
  state, but must not treat the two as the same record.

**Done when:** the dashboard's three navigation buttons are one node, and a
failed `run-qa` is visible on the button that started it.

## WP8 — Selection and reveal

**Goal:** Tabs without a tabs component; one deep-link verb.

- Managed-children containers may declare `select: single` with an optional
  `defaultChild` in YAML; selection state is renderer-owned and persisted like
  collapse.
- Core provides `select:<container>/<child>` actions with correct `active`
  state for each selectable child.
- `reveal:<node>` expands collapsed ancestors, selects the node in every
  switching ancestor, and scrolls it into view; palette focus and agent
  navigation use it where appropriate.
- Library pattern "Switchable panels" inserts a selection container plus a
  tab-variant action bar with correct references.
- `@dash-bored/tabs` becomes a migration alias to the pattern.
- Document when to use focus pages (top level, global) versus selection
  (local, nested).

**Done when:** a nested set of switchable panels and the root section switcher
both work without `@dash-bored/tabs`.

## WP9 — Consolidation

**Goal:** Remove what the new atoms replace.

- Merge `card` into `group` (optional `title`, `description`); drop the
  "at least two children" rule or keep it as a lint.
- Replace `conditional` with a source-bound `when` on the parent-child edge.
- Replace `setup-agent` with a starter-dashboard button running `agent:prompt`
  with the setup prompt, keeping the post-run validation and single repair.
- Move `focus-timer` to an example local component.
- One schema-version migration covers every retirement, runs through the
  existing app-driven migration flow, and is reported by `migrate inspect`.
  Earlier additive packages accept the old schema and builtins until this
  migration has a complete replacement for each one.
- Update the skill builtins reference and README in the same change.

**Done when:** retired builtins resolve only as migration aliases and every
shipped starter dashboard validates on the new schema.

## WP10 — Dogfood proof

**Goal:** Prove the atom set against real use.

- Exercise one script → source → view → item action → result path as soon as
  WP4–WP7 support it; record any missing-atom finding before broad migration.
- Rewrite `git-branches`, `package-scripts`, and `project-pulse` as YAML plus
  scripts under `.dash-bored/`; delete the local components.
- Any piece that still needs React is recorded here as a missing-atom finding
  rather than added as a builtin.

**Done when:** the proof-of-done checklist above holds.

## Deferred

Not planned until sources and action results are stable:

- action sequences ("weird deployment button sequence") with failure and
  confirmation rules;
- triggers such as running an action when a source changes or a process exits;
- a data-transform language of any kind (deliberately excluded, not deferred).
