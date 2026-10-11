# App runtime behavior

Read this only when the requested dashboard work involves editing, presentation
state, agent-task lifecycle, or trust/reload behavior.

These are renderer/app state, never YAML — do not try to configure them:

- **Window attention.** `app:focus-window` restores a minimized window and
  brings dash-bored to the foreground with keyboard focus. Agents may invoke it
  for a meaningful completion or blocker. It preserves dashboard focus, panel
  selections, trust, and unsaved drafts, and remains available during pending work.

- **Draft Save/Cancel.** The component-library flyout opens read-only; the
  first insertion, move, removal, replacement, metadata edit, or ratio resize
  starts a draft. Save validates and atomically publishes the owning bundle's
  YAML; Cancel discards it. The per-node Edit dialog edits declared props and
  child metadata through the same boundary. Clean settings sessions need no
  Save/Cancel and agents remain free to edit.
  Reverting every change makes the session clean; external YAML reloads release
  its preview. When switching dashboards with a
  dirty draft, the confirmation offers Keep editing, Save dashboard, and
  Discard changes. Save validates and writes the draft before continuing the
  requested navigation; a failed save leaves the draft and confirmation open.
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
- **Action buttons.** `./components/external/core/button` uses `{ name, action }`. References
  target explicit node IDs, such as `focus:yaml-todo` or
  `component:project-pulse:refresh-project-pulse`; the editor picker assigns an
  ID when needed. Schema-v3 dashboards still resolve positional references
  with a deprecation warning until the v4 migration. Buttons, shortcuts, and the palette share execution,
  confirmation, choices, trust, running locks, and unavailable reasons.
- **Node menu.** Every rendered node offers Focus, Edit component, Collapse /
  Expand, Copy component path (a YAML locator for agent prompts), and Change
  with agent.
- **Agent integration.** The app is an Agent Client Protocol (ACP) client.
  Change-with-agent, Fix-with-agent (in diagnostics details), setup, the
  flyout's "build a component" fallback, and `agent:prompt` each start one ACP
  session with the user's agent in the project root. The agent is the app
  setting (Settings → General → Dashboard agent), else the bundle `.env`'s
  optional `DASH_BORED_AGENT` (an ACP launch command such as `codex-acp`,
  `claude-agent-acp`, or `gemini --acp`), else the first known agent detected on
  PATH; the app never installs agents or holds provider keys. Change with agent
  and `agent:prompt` render a prompt template (`dashboard`, `project`, or the
  bundle's `prompts/<name>.md`); the user may switch template and fill its
  declared vars, and the composer shows the full rendered prompt before Send.
  The prompt is sent over ACP, not through the environment. The Agent work
  drawer shows each session's messages, plan, tool calls (touched paths with
  line counts, no diffs), and permission requests, which only the user answers
  in the app; the agent-control channel cannot. Dashboard work is validated
  when a turn ends, with at most one automatic repair as a follow-up in the
  same session. Sessions stay open for follow-ups until closed or handed off to
  the agent's own app.
- **Trust.** One project-level decision over the union of all resolved
  component permissions, keyed by canonical project root. Untrusted projects
  still parse and render safe layout/inline content but cannot compile local
  code, run commands, touch files, fetch HTTP, or embed webviews. Adding a
  permission invalidates trust and asks again. Approved permissions persist
  across installed-app restarts. Nonfatal validation errors permit normal trust
  review when capability inspection is complete, then diagnostics repair with
  the configured agent. Fatal inspection errors block approval; invalid code
  stays unloaded until fixed.
- **Reload vs recovery.** `Reload dashboard` rereads config and keeps the
  last-known-good tree on validation failure. `Reload app` only reloads the
  renderer window.
