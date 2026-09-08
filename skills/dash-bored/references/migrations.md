# Updates and dashboard migrations

Use `dash-bored update check` to discover a published release, release notes,
and required dashboard changes. `dash-bored update status` reads persisted
progress without a network request. Canary is the only available channel.
Use `dash-bored migrate inspect <dashboard>` for the current bundled contract.
The first updater-capable release must be installed manually.

Migration guidance is cumulative and version matched with the app and CLI.
Only apply the recipes selected by the host for the exact dashboard path.
Historical schema v1-to-v2 conversion and unknown schemas are unsupported.
Read the read-only handoff SKILL.md and references from the target release,
even if a customized global/project skill could not be refreshed. Never
silently overwrite customized guidance.

Before edits, verify the host-created snapshot exists. Preserve unrelated
files, user edits, environment files, component checkouts, and exact lock-file
pins. Do not rename dashboards. Follow each applicable recipe in order and
change schemaVersion only after that step is implemented. Inspect the
matching CLI's component schemas before authoring. Do not grant trust or
run project commands to evade permission checks.

Run the exact matching CLI's `validate <dashboard> --json` after edits. A
successful agent exit is followed by host validation; repairable errors may
receive one corrective attempt. Cancellation, failed execution, unavailable
tools, and permission changes never authorize a blind retry. Interrupted
migration work needs an explicit retry after reviewing the snapshot and diff.
