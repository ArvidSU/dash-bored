# dash-bored - Architecture: Agents (ACP client)

Product intent: [IDEA.md — Agents as first-class clients](../IDEA.md#agents-as-first-class-clients).

dash-bored is an [Agent Client Protocol](https://agentclientprotocol.com) (ACP)
client. Every agent request in the app (setup, Change with agent, component
creation, Fix with agent, `agent:prompt`, and migrations) is one ACP session
with the user's chosen agent, running as a local subprocess in the owning
project. The agent owns its model, credentials, tools, and loop; the app holds
no provider keys and has no agent-specific code paths. A plain CLI can still
run in a command component's terminal; it is not an integrated agent.

## Modules

| Module | Responsibility |
| --- | --- |
| `shared/agent-catalog.ts` | Known ACP agents, as data. |
| `shared/agent-session.ts` | App-internal task projection, launch requests, and task commands. Not part of `contracts.ts` or the component SDK. |
| `shared/agent-setup.ts` | Pure enabled-agent and setup-status projection; package-runner commands require explicit enablement. |
| `main/agent-detection.ts` | Matches commands against the catalog; detects known agents on PATH. |
| `main/agent-launch.ts` | `AgentLauncher`: command resolution, prompt preparation, and every launch kind. |
| `main/dashboard-setup.ts` | `DashboardSetupSupervisor`: validation when a turn ends and the single repair. |
| `main/agent-sessions.ts` | `AgentSessions`: one process and one ACP session per task, permissions, lifecycle. |
| `main/agent-session-updates.ts` | Pure reducer from `session/update` into the bounded transcript. |
| `main/acp-connection.ts` | `AcpAgentProcess`: spawn, JSON-RPC connection, timeouts, termination. |
| `main/agent-handoff.ts` | Resume-command quoting and the hand-off script. |
| `main/agent-config-memory.ts` | `AgentConfigMemory`: config options remembered per launch command for the composer. |

RPC (`src/shared/rpc.ts`): `previewComponentAgent`, `launchAgent` (component,
creation, diagnostics, setup), `getAgentTasks`, `getAgentOptions` (Settings, or
one bundle's composer), and `agentTaskCommand` with `prompt`, `cancel`,
`permission`, `config`, `authenticate`, `handoff`, or `close`. A task command
answers with the task; the renderer's store still updates from the `agentTask`
push, which carries the whole `AgentSessionTask`.

## Choosing the agent

`AgentLauncher.resolve` picks the launch command in this order:

1. An explicit per-request choice. `custom` is normalized like the setting;
   `detected` names an enabled, available catalog id and is re-resolved from setup, so the
   renderer never supplies that command; `app` and `project` require that
   source to be set.
2. The app setting `dashBoredAgent` (Settings → General → Dashboard agent).
3. `DASH_BORED_AGENT` in the owning bundle's `.env`. An untrusted repair skips
   this step, so a project cannot select its own repair agent.
4. The first enabled, available known agent, in catalog order.
5. Otherwise `AGENT_UNAVAILABLE`, naming example agents and the Settings field.

`DASH_BORED_AGENT` keeps its name and now holds an ACP launch command. The
setting defaults to `null`; app settings version 4 migrates a stored legacy
default (`codex exec` from versions 1–3) to `null`. Before spawning, the
read-only preflight checks a simple command's literal first word on PATH
(`DASHBOARD_AGENT_UNAVAILABLE`); shell expressions are not interpreted.

## Detection catalog

`KNOWN_AGENTS` is a data table: `id`, display `name`, ACP launch `command`, the
agent's own `cli`, an optional `resume` template, and `homepage`. No code path
branches on an id.

- **Detection** looks up the first word of each `command` on the app's
  normalized PATH (see [Runtime](./runtime.md)); shell startup files are not
  read. Detected agents keep catalog order.
- **Matching** treats a command as a known agent when its executable's base
  name equals the launch executable and it carries the launch command's other
  words, so `/opt/homebrew/bin/gemini --acp --debug` is Gemini CLI. An
  `npx`/`bunx` launch of an entry's `package` (any version) is that agent too,
  so `npx -y @agentclientprotocol/codex-acp@2.2.2` is Codex and can hand off.
  Unknown commands display their executable name.
- **Hints.** A command that runs a known agent's own CLI instead of its ACP
  command (for example `codex exec` or `claude -p`) fails the handshake; the
  error names the agent's ACP command and, for adapters, where to install it.

Settings → General → Dashboard agent shows a checkbox for every catalog entry.
`enabledAgentIds` is an optional app-settings field: omission preserves legacy
PATH detection; an explicit array (including an empty array) is authoritative.
The setting is normalized to unique known IDs in catalog order. Discovery is
read-only and returns `setup` status for all entries; `detected` now projects
the enabled, available picker choices, including opted-in package commands.

Installed PATH executables win. For an explicitly enabled entry with `package`,
a missing executable uses `npx -y <package> <ACP args>`, or `bunx` when npx is
absent. Like executable detection, the runner lookup passes the app's
normalized PATH to `Bun.which` explicitly: without it, Bun reads the launch-time
PATH, which a Finder-launched app lacks. The package runner downloads and
caches the package on first launch; checking a box only saves configuration. No registry is fetched. Without a
runner, or for entries without a package, setup names the missing prerequisite
and links to the agent's instructions. Refresh rechecks PATH without reopening
Settings. There is no global install, uninstall, or automatic upgrade policy.

Checkbox changes save immediately. Disabling the currently selected exact
catalog/setup command clears the app default; custom and bundle commands remain
explicit overrides. Disabling does not stop an existing session. Per-request
catalog choices are checked again in main so stale or forged disabled IDs cannot
launch. The composer links to Settings instead of repeating installation lists.
Signing in belongs to the agent; setup availability does not prove sign-in or
an ACP handshake.

## Process and connection

- One agent process per task, spawned through `/bin/sh -c` so the configured
  command keeps its shell syntax. A plain invocation runs as `exec <command>`
  and replaces the shell; a command that starts with an assignment, builtin, or
  keyword, or uses operators or redirections (`FOO=1 agent`,
  `source ~/.nvm/nvm.sh && agent`), runs as written. Stdio is piped; `cwd` is
  the project root; the shell or agent leads its own process group, which is
  what termination signals.
- The environment is the owning bundle's launch environment (the same
  resolution as commands, see [Project contract](./project-contract.md)), or
  for an untrusted repair the app-published environment without the bundle
  `.env`. The app adds `DASH_BORED_AGENT` (the command that runs) and
  `DASH_BORED_COMPONENT_PATH` (the first target's locator when several were
  picked; the prompt lists every target), and sets `ENV` and `BASH_ENV` to `/dev/null` so
  shell startup hooks cannot replace the preflighted PATH. `DASH_BORED_TOOL`
  and `DASH_BORED_APP_INSTANCE` are inherited from main. The prompt travels
  over ACP, not in the environment.
- Stdout and stdin carry newline-delimited JSON-RPC through the exactly pinned
  `@agentclientprotocol/sdk`. Stderr is split into lines of at most 2,000
  characters; the task keeps the last 200 as `log`.
- The SDK has no request timeouts, so every request races the process exit and
  an optional timer; a timer that fires stops the process.

| Request | Timeout |
| --- | --- |
| `initialize` | 60 s (first-run adapters are slow) |
| `session/new` | 60 s |
| `authenticate` | 120 s; the user can stop waiting earlier (`$/cancel_request`) |
| `session/set_config_option`, `session/set_mode` | 30 s each, including the launch choices |
| `session/close` | 5 s |
| `session/prompt` | none: a turn runs until it ends, is cancelled, or the process exits |

- **Termination** closes stdin and the connection, waits 1.5 s, sends SIGTERM
  to the process group, waits again, then SIGKILL; a final SIGTERM to the group
  reaches adapter children left behind by an exited leader.

## Handshake and sign-in

`initialize` sends the SDK's `PROTOCOL_VERSION`, `clientInfo`, and these client
capabilities: `fs.readTextFile` and `fs.writeTextFile` false, `terminal` false,
`auth.terminal` false, `session.configOptions.boolean`, and `session.notices`.
The unstable `plan` capability (`plan_update`, `plan_removed`) is not
advertised: it would let agents send markdown or file plans, which the app does
not show. The agent works on files and runs commands with its own tools. A different protocol version in the
answer fails the task. A timeout or an exit before the answer fails with "did
not answer as an ACP agent" plus the catalog hint above.

`session/new` uses the project root as `cwd` and an empty `mcpServers` list; the
app injects no MCP servers. The answer's config options become the task's
selects (grouped choices flattened, keeping the group name). An agent that
sends only legacy `modes` gets one synthesized `mode` select, set through
`session/set_mode`.

### Options before the first prompt

ACP lists config options only in the `session/new` answer, so the composer
cannot ask the agent before a session exists. Instead, `AgentConfigMemory`
keeps, per launch command, the options the agent offered when the app last
created a session with it, and the composer's last choices. It lives in
`<user data>/agent-config-v1.json` (0600), keeps the 10 most recently used
commands, and starts empty when the file is missing or unreadable; entries of
the wrong shape are dropped. `AgentCommandOptions.config` carries it to the
composer.

- **Offered.** After every `session/new` answer, the options as the agent
  offered them are remembered, before any launch choice is applied. An
  untrusted repair's session is not remembered, so an untrusted project's
  agent configuration does not shape app-wide state.
- **Composer.** Each remembered option is a select whose first choice,
  **Default**, sets nothing; booleans offer Default, On, and Off. The composer
  never shows the agent's default value, because agents may default
  differently per project. A remembered choice the option no longer offers
  shows as Default. A command with no remembered options shows a hint instead.
- **Launch.** Component launches carry `config`, the non-default choices
  (an object of at most 20 ids with string or boolean values;
  `COMPONENT_AGENT_CONFIG_INVALID` otherwise). When the composer showed
  options, a successful launch replaces that command's remembered choices,
  so returning an option to Default forgets it. Other launch kinds (setup,
  creation, diagnostics, migrations) carry no choices and use the agent's
  defaults.
- **Apply.** While the task is still `starting`, after `session/new` and
  before the first prompt, each choice that differs from the session's value
  is set in the order the agent lists its options (a model change can change
  the effort choices), through the same checks as a `config` task command. A
  choice the agent does not offer, or refuses, leaves that option at the
  agent's default with a warning notice. A timeout or connection failure fails
  the task.

An auth-required error (`-32000`) on `session/new` or `session/prompt` moves the
task to `auth-required` with the agent-handled sign-in methods; terminal methods
need `auth.terminal`, which the app does not offer. With no usable method the
task fails and tells the user to sign in with the agent's own CLI.
`authenticate` then creates the session, or resends the interrupted prompt.

## Session lifecycle

| State | Meaning |
| --- | --- |
| `starting` | Spawning, `initialize`, `session/new`, or sign-in in progress. |
| `auth-required` | The agent needs sign-in before the session or turn can continue. |
| `working` | A prompt turn is running. |
| `waiting` | A turn is blocked on a permission request. |
| `idle` | The last turn ended; follow-ups are accepted. |
| `closed` | Closed by the user, handed off, or stopped by the app. |
| `failed` | Process or protocol failure; `error` and `log` explain it. |

- **Prompts.** Each prompt is one text content block of 1 to 16,384 characters
  after trimming. The first prompt is the reviewed, rendered template; it is
  sent once the session exists and shown in the Prompt tab rather than as a
  transcript entry. Follow-ups, including the automatic repair, are `user`
  entries. A user follow-up is accepted only while the
  task is `idle`, the turn-end hook is not running, and validation is not
  `checking`; otherwise `AGENT_SESSION_BUSY`.
- **Turn end.** A stop reason sets `stopReason`, increments `turns` (every stop
  reason counts, including `cancelled`), answers pending permissions
  `cancelled`, and returns to `idle`. A JSON-RPC error from a live agent keeps
  the session `idle` with an error notice and does not count a turn. A process
  exit or timeout fails the task. An exit while `idle` or `auth-required` also
  fails it.
- **Cancel** during a turn sends `session/cancel` and answers pending
  permissions `cancelled`; permission requests that arrive later in that turn
  are answered `cancelled` without being shown. The session stays open. During
  `starting` or `auth-required` it closes the task; while sign-in is running
  it only stops waiting for sign-in.
- **Close** sends `session/cancel` when a turn is running, answers pending
  permissions, marks the task `closed`, sends `session/close` when the agent
  advertises it, then terminates the process. A user close marks the task
  `cancelled`; when a migration ends, the app closes its sessions without it.
- Sessions end when the user closes or hands off the task, when the owning
  project's trust is revoked or the project is removed from the app
  (`stopProject`, for the whole project or one removed dashboard), when the app
  quits (`shutdown` closes every session and publishes the final state), or
  when pruning closes them. They live in memory only; nothing is persisted
  across app restarts.
- **Busy.** `isAgentTaskBusy` in `shared/agent-session.ts` is the one
  definition of work in progress: `starting`, `auth-required` (a prompt is
  pending and runs right after sign-in), `working`, `waiting`, or validation
  `checking` or `repairing`. An `idle` session is not busy.
- **Pruning** keeps at most 20 tasks. Ended tasks go first, oldest first; then
  the oldest quiet sessions are closed and leave once closed. A busy task, or
  one running its turn-end hook or being handed off, is never pruned. Every
  pruned task publishes its final (`closed` or `failed`) snapshot before it
  leaves, so the renderer can keep it in its own list, trimmed to the same
  bound.
- **Emission.** Streaming updates push each task at most once per 50 ms as a
  structured clone. A launch and every task command flush the task's pending
  push before they resolve, so the renderer sees the change (for example the
  next queued permission request) before the answer. A dashboard snapshot while
  a turn runs sets `dashboardChanged`, which is not a success claim.

## Transcript reduction

`agent-session-updates.ts` reduces each `session/update` into the task:

- `user_message_chunk`, `agent_message_chunk`, and `agent_thought_chunk` merge
  by message id, or into the current run of id-less chunks of the same kind; any
  other update ends that run. Images and audio appear as `[image]`/`[audio]`;
  resource links as their title and URI; embedded text resources as text.
- `tool_call` and `tool_call_update` upsert by `toolCallId`. Unknown tool kinds
  become `other`. Text content becomes `output`. Terminal content is ignored,
  because the app offers no terminal capability.
- `plan` and `plan_update` replace the plan; `plan_removed` clears it.
  `config_option_update` replaces the selects; `current_mode_update` moves the
  synthesized `mode` select. `notice` becomes a notice entry.
- Unknown update kinds are ignored. The SDK drops kinds it cannot parse (it logs
  to the console), and the connection survives.

Bounds keep every emission small, whatever the agent sends:

| What | Bound |
| --- | --- |
| Transcript | 400 entries and 1 MiB of text in total (UTF-16 code units); the oldest entries are dropped and counted in `truncated`, the newest is kept |
| Entry text | 64 KiB; notices and error messages 4 KiB |
| Tool output | 8 KiB, keeping the tail, where failures usually are |
| Tool calls | 50 locations and 50 edited files; paths 1 KiB, cut with `…` |
| Titles | 2,000 characters for tool and permission titles; 4,000 per plan entry |
| Plan | 100 entries |
| Config options | 20 options with 200 choices each; names and descriptions 1 KiB |
| Permission options, sign-in methods | 10 each |
| Stderr | 200 lines of at most 2,000 characters |

### No diffs

The app shows no file diffs of the bundle or the project, for either scope. An
ACP `diff` tool content item is reduced to `{ path, added, removed }` by a
multiset line count, and its text is discarded. Dashboard work is reviewed by
validation; diffs belong to custom components or external apps.

## Permissions

- Each `session/request_permission` upserts its tool call and becomes an
  `AgentPermissionRequest` with an app-generated id. Requests queue in arrival
  order; `task.permission` shows the oldest, and the task is `waiting` while
  any request is unanswered. A newer request never replaces an older one.
- Only the user answers, through the `permission` task command: one of that
  request's option ids, or `null` for `cancelled`. An answered or withdrawn
  request is `AGENT_PERMISSION_STALE`.
- An agent that withdraws a request (`$/cancel_request`) gets `cancelled`. Turn
  end, cancel, close, and failure answer every pending request `cancelled`. A
  request that arrives outside a turn, or while the session closes, is
  answered `cancelled` at once.
- Nothing approves automatically. The agent-control channel has no route to
  list, answer, or approve permissions, or to prompt or close a session, and it
  refuses every `agent:*` palette action (see [Security](./security.md#agent-control-channel)).

### Untrusted repair policy

Fix with agent on a project without a trust grant runs as an untrusted repair
(`untrusted: true`). Its command never comes from the bundle `.env`, its
environment excludes the bundle `.env`, and its prompt treats project files as
data. Permission requests are refused automatically when:

- the tool kind is `fetch`, `switch_mode`, or `other`
  (unclassified);
- an edit, delete, or move location, or any explicit edited path, resolves
  outside the bundle directory. Read locations and command locations can be
  outside the bundle. Paths are
  resolved as the OS would: one component at a time through every symlink, so
  a link inside the bundle that points out, or `link/..`, counts as outside.
  Components that do not exist yet are appended as written; relative paths
  resolve against the project root;
- the request names 50 or more locations or edited files, or a path of 1 KiB
  or more, because the bounded copy may have been cut and cannot be checked
  whole; or
- a `read`, `edit`, `delete`, or `move` request names no path, so containment
  cannot be checked.

Reads (including installed skills outside the bundle) and commands (including
API discovery and validation) reach the user for one-time approval. This lets
repair proceed before trust review is possible. Command approval authorizes
the whole command; the app does not parse shell text or constrain its effects.
The repair prompt forbids project commands and dependency installation.

A refusal selects `reject_once`, else `reject_always`, else answers
`cancelled`, and adds a warning notice. Other requests reach the user without
their `allow_always` options, and an `allow_always` answer is refused, so
every approval covers one call. Changing a config option in the `mode`
category is refused (`AGENT_CONFIG_REFUSED`), because a mode can let the agent
act without asking.

**This narrows the agent; it does not sandbox it.** ACP agents need not ask
before acting, and many read, write, and run commands under their own
permission modes without a request. The agent process runs as the user with the
user's file system and network, and its working directory is the untrusted
project, so the agent's own configuration there (for example
`.claude/settings.json` hooks or `.gemini/settings.json` MCP servers) may
run code before any permission request reaches the app. The policy narrows
what the agent is asked to do; it does not contain it. What the untrusted
repair guarantees is that no dash-bored project input (the bundle `.env`)
selects or configures the agent, nothing is granted, and validation reports the
trust review instead of repairing.

## Validation and repair

`DashboardSetupSupervisor.launchRequest` preflights the command, rechecks that
the same dashboard is active and trusted (except for an untrusted repair), and
launches. Dashboard work (setup, dashboard-template edits, creation,
diagnostics, migrations) receives an `onTurnEnd` hook; project work from the
`project` template does not and is the user's to review.

`onTurnEnd` runs exactly once per turn, including once when the session ends
with a turn outstanding. It reports `checking`, loads the definition with local
compilation, and then:

- the task was stopped or the dashboard changed → `cancelled`;
- new permissions → `trust-required` (reloaded when error-free; never granted);
- the project is untrusted → `trust-required`, no repair;
- the turn did not end cleanly (`idle` with `end_turn`) → `failed` or
  `cancelled`, no repair;
- no errors → reload, then `valid` (or `trust-required`, `failed`, `cancelled`);
- errors that are all bundle-repairable, with no repair used yet →
  `repairing`, and the repair is a follow-up prompt in the **same session**
  (`buildDiagnosticsAgentPrompt` with `followUp`), so the agent keeps its
  context. That turn is validated again; remaining errors report `failed`.
- otherwise `failed` with the diagnostics. Later user follow-ups are still
  validated, but the automatic repair runs at most once per task.

The migration agent (`superviseMigrationSession`) wraps launch and follow-up
to recheck trust and cancellation before each. A failing turn-end hook (for
example an unreadable trust store) rejects the migration, not only the task's
validation. Once the migration has an outcome, later validations are ignored,
and every session it started is closed. The update coordinator blocks an
install while any task is busy, and a migration while a task for that dashboard
is busy; setup refuses to start while another agent task for the same
dashboard is busy.

## Hand-off

Hand-off resumes the same session in the agent's own app. It is available when:

- the known agent defines `resume`, the task has a `sessionId` of 1 to 200
  characters from `[A-Za-z0-9._:-]` that does not start with `-` (so it is
  never read as a CLI option), and at least one turn completed (some agents
  persist a session only after its first turn);
- the task is `idle`, its turn-end hook is not running, and validation is not
  `checking` or `repairing`;
- the platform is macOS; elsewhere the error carries the command to run.

`{sessionId}` and `{cwd}` (the project root) are substituted as single-quoted
POSIX words. The task's `handoff.command` is `cd '<root>' && <resume>`, ready
to copy. Hand-off writes `<user data>/agent-handoff/<task-id>.command` (the
directory and file are 0700) containing `cd '<root>' || exit 1` and
`exec <resume>`, closes the app's session first so two clients never drive one
session, then opens the script with `/usr/bin/open`, so the user's default
terminal app runs it without Automation permission. The hand-off is claimed
before its first await: a second hand-off, a prompt, or a config change while
it runs is refused. The task ends `closed` with `handedOff`.

The process cwd and the session cwd are both the project root, because some
agents key their session store by process cwd or require it on resume.

Known limitation: Claude Code's plan-mode "clear context" keeps the ACP session
id but starts a new native session, so hand-off resumes the conversation from
before the clear.

## Out of scope

Global agent installation, binary archive installation, registry downloads, provider keys, MCP-server injection,
the `fs` and `terminal` client capabilities, file diffs, and session
persistence across app restarts. See [Distribution](./distribution.md#deliberate-exclusions).
