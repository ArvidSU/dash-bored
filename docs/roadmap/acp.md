# Agent Client Protocol (ACP) agents

Product intent: [IDEA.md — Agents as first-class clients](../IDEA.md#agents-as-first-class-clients).
This page is the implementation plan; once shipped, the contracts live in
[docs/architecture/agents.md](../architecture/agents.md) and this page only
records what was deferred.

## Decisions

1. ACP is the only integrated agent path. The PTY CLI harness, the agent
   terminal and its resting shell, `DASH_BORED_AGENT_PROMPT`, and
   `componentAgentInvocation` are removed. A plain CLI can still run in a
   command component.
2. Detect first. A data table of known agents (`src/shared/agent-catalog.ts`)
   is matched against the app's normalized PATH. A custom ACP launch command is
   always accepted. The app never downloads or installs agents (no registry
   fetch, no implicit `npx`; a user may still type an `npx …` custom command).
3. Hand-off resumes the same session in the agent's own app: the known agent's
   `resume` template run from the project root in the user's terminal. The app
   closes its side of the session first so two clients never drive it.
4. No diffs. `main/dashboard-agent-diff.ts`, the Diff tab, and
   `getDashboardAgentDiff` are removed for both scopes. ACP tool-call diffs are
   summarized as touched paths with added/removed line counts.

## Contracts

`src/shared/agent-session.ts` (app-internal, not in the component SDK) defines
the known-agent table types, `AgentCommandChoice`/`AgentCommandOptions`, the
launch requests, `AgentSessionTask`, and `AgentTaskCommand`. They replace
`DashboardAgentTask`, the old `AgentTaskCommand`, and the agent launch request
types in `contracts.ts`. `ComponentAgentLaunch` and
`ComponentEnvironmentSnapshot` stay in `contracts.ts` unchanged: they are
reachable from the component SDK. `DASH_BORED_AGENT` keeps its name and now
holds an ACP launch command.

RPC (`src/shared/rpc.ts`):

| Old | New |
| --- | --- |
| `getDashboardAgentTasks` → `DashboardAgentTask[]` | `getAgentTasks` → `AgentSessionTask[]` |
| message `agentTask: DashboardAgentTask` | message `agentTask: AgentSessionTask` |
| `agentTaskCommand` (stop/write/resize) | `agentTaskCommand` with the new `AgentTaskCommand` |
| `getDashboardAgentDiff` | removed |
| — | `getAgentOptions: { configPath?: string } → AgentCommandOptions` (Settings) |

## Behavior

- **Launch.** Resolve the command (choice → app setting → bundle `.env` →
  first detected agent → `AGENT_UNAVAILABLE` with Settings guidance). Preflight
  the first token on PATH as today. Spawn `/bin/sh -c 'exec <command>'` with
  piped stdio, the existing launch environment (minus the removed prompt
  variable), `cwd` = project root, in its own process group so close kills the
  tree. `initialize` with protocol version from the SDK and client capabilities
  `fs` read/write false, `terminal` false, `auth.terminal` false. Time out
  `initialize` (60 s, first-run adapters are slow) and report a non-ACP command
  clearly; when the command's executable is a known agent's `cli`, suggest that
  agent's ACP command. `session/new` with `cwd` = project root and no MCP
  servers. An auth-required error moves the task to `auth-required` with the
  agent's methods; `authenticate` retries `session/new`.
- **Prompt.** One text content block with the rendered template. Bounds: 16 KiB
  prompt as today; transcript ≤ 400 entries (drop oldest, count `truncated`),
  entry text ≤ 64 KiB, tool output ≤ 8 KiB, stderr tail ≤ 200 lines. Coalesce
  task emissions (~50 ms per task).
- **Updates.** Merge `agent_message_chunk`/`agent_thought_chunk`/
  `user_message_chunk` by message id (or consecutive run when absent); upsert
  `tool_call`/`tool_call_update` by `toolCallId`; `plan` replaces `plan`;
  `config_option_update` replaces `configOptions`; fall back to `modes` as a
  `mode` select when the agent sends no config options; ignore unknown update
  kinds without failing.
- **Permissions.** Every request becomes `permission` and state `waiting`; the
  user answers in the app. A newer request never replaces an unanswered one
  (queue them). Cancelling the turn answers pending requests `cancelled`. The
  agent-control channel has no path to answer, list as actionable, or approve
  permissions. Untrusted repair auto-rejects (`reject_once`) requests whose
  kind is `execute`, `fetch`, or `other`, or that touch a location outside the
  bundle directory, and records a notice; this narrows but does not sandbox
  the agent, and docs must say so.
- **Turns and validation.** Dashboard-scope tasks validate after every turn
  that ends with `end_turn` (the supervisor's `finish` is keyed on turn end,
  not process exit). The single automatic repair is a follow-up prompt in the
  same session (`buildDiagnosticsAgentPrompt`), not a new process. Other stop
  reasons report `failed`/`cancelled` like a non-clean exit did. The untrusted
  diagnostics repair remains its own task without the bundle environment.
  Migration waits on validation exactly as before.
- **Lifecycle.** Sessions stay open for follow-ups until the user closes the
  task, hands it off, revokes project trust, or quits. `close` sends
  `session/close` when advertised, then terminates the process group. Keep at
  most 20 tasks; prune closed/failed ones first, never one that is working,
  waiting, checking, or repairing. App quit and trust revocation close the
  owning tasks.
- **Hand-off.** Available when the task has a `sessionId`, the known agent has
  `resume`, at least one turn completed (Codex and Cline persist a session only
  after its first turn), and the session is idle. The agent runs with the
  project root as both process and session cwd, because some agents key their
  session store by process cwd (Cursor) or require it on resume (Kimi,
  OpenCode). `{sessionId}` and `{cwd}` are substituted as shell-quoted words.
  Known limitation: Claude's plan-mode "clear context" keeps the ACP id but
  starts a new native session, so hand-off resumes the earlier conversation. Validate the session id
  (`^[A-Za-z0-9._:-]{1,200}$`), write a 0700 `.command` script under the app's
  user-data directory (`cd '<projectRoot>' && exec <resume>`) and `open` it,
  so the user's default terminal app runs it without Automation permissions.
  Close the app's session first. The UI can also copy the resolved command.
- **Settings.** `dashBoredAgent: string | null` stays. A stored legacy default
  (`codex exec`) migrates to `null`. The Settings field becomes a picker:
  bundle default, each detected agent, or a custom command.
- **Starter and docs.** New bundles stop writing `DASH_BORED_AGENT="codex exec"`;
  the starter `.env` documents the variable as an optional ACP command, and the
  setup status script reports when it is unset that the app picks a detected
  agent. Update this repository's own `.dash-bored/.env`.

## UI

- **Agent work drawer** rows: summary, agent name, state chip (Starting,
  Working, Needs permission, Idle, Sign-in required, Closed, Failed), and
  validation chip. A waiting task opens the drawer even when the user closed it
  earlier (it needs the user); other updates keep the current rule.
- **Task modal** tabs: **Session** and **Prompt**. Session shows the plan (when
  present), the transcript (agent Markdown rendered by a small safe subset
  renderer: paragraphs, emphasis, inline and fenced code, lists, links as text;
  no raw HTML), compact tool-call rows (status glyph plus text, kind, title,
  touched paths with +/− counts, expandable bounded output), notices, the
  permission card (one button per option, keyboard reachable), and a follow-up
  composer. The header holds config option selects, Stop (cancel turn), Resume
  in <agent> (hand-off, with copy command), and Close session. Failed launches
  show `error` plus the stderr tail. Prompt shows the full first prompt and the
  launch command with copy, replacing the Command tab.
- **Composer and Settings** pickers list App default, Project `.env`, each
  detected agent, and Custom, always showing the command that will run, plus
  install links for known agents that are not detected.

## Work packages

1. **Core (main + shared).** Dependency `@agentclientprotocol/sdk` pinned
   exactly; catalog; detection; ACP connection and session manager replacing
   `DashboardAgentHarness`; supervisor and launcher changes; hand-off; settings
   migration; migration-agent; starter files; RPC; removal of PTY agent code
   and the diff module; fake ACP agent fixture and tests; architecture docs
   (new `agents.md`, runtime, security, project-contract, lifecycle-cli,
   distribution) and README.
2. **Renderer.** Drawer, task modal, Markdown subset, composer and Settings
   pickers, `use-agent-work`, UI fixture host, CSS, interaction tests,
   `renderer.md`.
3. **Integration.** Merge, `qa:fast`, regenerate SDK declarations, dashboard
   validation, dev-app proof against the fake agent and one real detected
   agent handshake, project dashboard dogfooding and deferred todos.

## Deferred

Tracked in the project dashboard's `yaml-todo` once integration lands.
