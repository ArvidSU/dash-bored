# App runtime behavior

Read this only when the requested dashboard work involves editing, presentation
state, agent-task lifecycle, or trust/reload behavior.

These are renderer/app state, never YAML — do not try to configure them:

- **Draft Save/Cancel.** The component-library flyout opens read-only; the
  first insertion, move, removal, replacement, metadata edit, or ratio resize
  starts a draft. Save validates and atomically publishes the owning bundle's
  YAML; Cancel discards it. The per-node Edit dialog edits declared props and
  child metadata through the same boundary.
- **Presentation state.** Collapse/expand, the selected Focus target (with
  breadcrumbs back), runtime split-ratio drags, and surface height caps are
  per-user, keyed by config path and node ID, persisted locally. The target
  selection never changes YAML. `persistOnFocus: true` is different: it is a
  portable node composition marker in YAML that retains marked ancestors and
  direct sibling rails around the focused target. Collapsing unmounts a subtree
  (stops polling/views) but does not stop a running command process.
- **Command palette** (`Command/Ctrl+K`) merges app navigation/lifecycle,
  per-node Focus actions, process start/stop derived from declared resources,
  and actions registered by mounted local components. Known actions stay
  searchable while unavailable, with a reason. Users favorite actions and
  assign shortcuts in Settings (General/Actions tabs); favorites sort first
  without bypassing trust or availability.
- **Action buttons.** `@dash-bored/button` uses `{ name, action }`. Action props
  may interpolate owning-bundle YAML paths such as
  `focus:${root.children.first.node}`; validation resolves the path and linked
  bundle namespace. Buttons, shortcuts, and the palette share execution,
  confirmation, choices, trust, running locks, and unavailable reasons.
- **Node menu.** Every rendered node offers Focus, Edit component, Collapse /
  Expand, Copy component path (a YAML locator for agent prompts), and Change
  with agent.
- **Agent integration.** The app-wide `DASH_BORED_AGENT` setting (Settings →
  General; starter `.env` holds an editable default) selects the CLI used by
  Change-with-agent, Fix-with-agent (in diagnostics details), the Agent work
  drawer (Working/Not working items with terminal / bundle-diff / full-command
  tabs), and the flyout's natural-language "build a component" fallback. Agent
context travels in `DASH_BORED_AGENT_PROMPT` as one quoted argument. Saving an
empty app setting field lets the owning bundle's `.env` command select the CLI. This
  is a narrow harness around the user's CLI, not a provider integration.
- **Trust.** One project-level decision over the union of all resolved
  component permissions, keyed by canonical project root. Untrusted projects
  still parse and render safe layout/inline content but cannot compile local
  code, run commands, touch files, fetch HTTP, or embed webviews. Adding a
  permission invalidates trust and asks again.
- **Reload vs recovery.** `Reload dashboard` rereads config and keeps the
  last-known-good tree on validation failure. `Reload app` only reloads the
  renderer window.
