# Updates and dashboard migrations

The user discovers, installs, and authorizes releases in the app's Updates
surface; do not try to install the app. Use `dash-bored migrate inspect
<dashboard>` (the skill's agent tool) to learn whether a dashboard needs
migration to the installed app's contract and which recipes apply. You may
migrate a dashboard directly when the user asks; the app can also run a
migration agent for dashboards the user selected during an update.

Migration guidance is cumulative and version matched with the app and its agent tool.
Only apply the recipes selected by the host for the exact dashboard path.
The current dashboard contract is 3 and the minimum migratable contract is 2.
Schema version 1 and unknown schemas are unsupported.
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
dashboard `schemaVersion` to `3` after converting it. Component manifests stay
at version `2`; lock files, themes, and linked bundles are independent and are
not converted with the selected dashboard. Validate with the agent tool and
review the diff against the host snapshot, or against Git when you migrated
without one.
