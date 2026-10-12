# Updates and dashboard migrations

The user discovers, installs, and authorizes releases in the app's Updates
surface; do not try to install the app. Use `dash-bored migrate inspect
<dashboard>` (the skill's agent tool) to learn whether a dashboard needs
migration to the installed app's contract and which recipes apply. You may
migrate a dashboard directly when the user asks; the app can also run a
migration agent for dashboards the user selected during an update.

Migration guidance is cumulative and version matched with the app and its agent tool.
Only apply the recipes selected by the host for the exact dashboard path.
The current dashboard contract is 4 and the minimum migratable contract is 2.
Schema version 1 and unknown schemas are unsupported. Dashboard recipes never
convert component manifests: a local manifest still at `schemaVersion: 2`
reports `MANIFEST_SCHEMA_MIGRATION_REQUIRED` and needs its own update to
`schemaVersion: 3` with an explicit `apiVersion` (see
[components.md](components.md)), only when the user asks for it.
Read the read-only handoff SKILL.md and references from the target release,
even if a customized global/project skill could not be refreshed. Never
silently overwrite customized guidance.

Before edits, verify the host-created snapshot exists. Preserve unrelated
files, user edits, environment files, component checkouts, and exact lock-file
pins. Do not rename dashboards. Follow each applicable recipe in order and
change schemaVersion only after that step is implemented. Inspect the
agent tool's component schemas before authoring. Do not grant trust or
run project commands to evade permission checks.

Run the agent tool's `validate <dashboard> --json` after edits, then
screenshot the migrated dashboard in the app when it is running. A
successful agent exit is followed by host validation; repairable errors may
receive one corrective attempt. Cancellation, failed execution, unavailable
tools, and permission changes never authorize a blind retry. Interrupted
migration work needs an explicit retry after reviewing the snapshot and diff.

## Dashboard v2 to v3

For each component node in the selected dashboard:

- Replace `children: { type: managed, items: [...] }` with the items array.
- Replace `children: { type: tiled, layout: ... }` with that layout.
- Within tiled layouts, replace `{ type: child, child: edge }` with `edge`,
  and remove `type: split` from split branches.
- Preserve each split's axis, first and second branches. Omit a horizontal
  ratio of `0.5`, preserve other horizontal ratios, and remove vertical ratios.

Preserve all nodes, IDs, component references, props, metadata, child order,
binary grouping, and dashboard settings. Traverse only topology; data inside
props and metadata may contain similar names and must remain intact. Set the
dashboard `schemaVersion` to `3` after converting it. Lock files, themes, and
linked bundles are independent and are not converted with the selected
dashboard. Validate with the agent tool and review the diff against the host
snapshot, or against Git when you migrated without one.

## Dashboard v3 to v4

The standard components moved from the app into the pinned core package.

- Replace each recognized `@dash-bored/<name>` component reference (button,
  card, chart, command, conditional, env, focus-timer, group, list,
  live-chart, markdown, selection, setup-agent, status, tabs, todo-list,
  webview) with `./components/external/core/<name>`.
- Add the release-owned core pin to the bundle's `dash-bored-lock.yaml` under
  `components.core` (`url`, exact `commit`, `path`), exactly as the host's
  recipe states, preserving every other pin. Restore a missing checkout with
  `component restore`.

Preserve IDs, props, metadata, topology, and action references, and do not
rewrite strings inside props as component references. Set `schemaVersion` to
`4`. Lock files stay at version 1 and linked dashboards are independent
targets. Package ownership migration is a separate explicit operation; never
remove parent-owned gitlinks as part of this recipe. Validate with the agent
tool and review the diff as above.
