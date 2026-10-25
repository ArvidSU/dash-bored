# dash-bored - Architecture: Security and capabilities

## Trust and host capabilities

An untrusted project may be parsed and its manifests inspected. Missing locked
packages may be restored on opening before trust. Component code, including core,
does not execute until project trust. It cannot start a command, read or write a
project file, make an HTTP request, or instantiate a project webview.

Manifest `apiVersion` validation happens during discovery before local
compilation and component execution. Missing and unsupported versions produce
`COMPONENT_API_REQUIRED` and `COMPONENT_API_UNSUPPORTED`; schema-v2 manifests
produce `MANIFEST_SCHEMA_MIGRATION_REQUIRED`. The bundled authoring checker and
its `.d.ts` files are offline development tools, not grants of authority.
Capability-shaped host members depend on manifest declarations and trust.
Their presence does not grant authority: for example, a write-only filesystem
host still exposes `readText`, but read calls are denied without
`filesystem:read`. Each host RPC independently rechecks trust, node permissions,
and path bounds.

The application presents one project-level trust decision with the complete
requested permission set. Trust is keyed by canonical project root and stores
the approved permission set in Electrobun's user-data directory. Restarting the
app or reloading with the same or a smaller permission set preserves trust;
adding any permission
invalidates it and requires a new decision. Trust can also be revoked manually.
The main process checks both project trust and the requested node's declared
permission on every privileged RPC.

Trust review is independent of render validation. The bounded YAML parser can
inspect a structurally understood tree even when its version marker or other
presentation metadata is invalid; it does not modify or render that config.
Resolution inspects all referenced manifests and configured props to compute
the complete effective permission union and local-code disclosure. Known
nonfatal validation errors (props, action references, topology contracts,
prompt templates, and compilation) leave this review available. Unreadable or
structurally unknown config, invalid locks, unsafe paths, unavailable manifests,
and traversal limits block a new trust decision. Broken config links remain
quarantined placeholders; resolving them later rechecks the permission union.
Unknown error codes fail closed for trust review.

`background:watch` is the one permission that composition, not a manifest,
requests: every node with a `watch` adds it, and manifests cannot declare it.
It makes background work part of the trust decision, so a project's first
watch requires approval again, and trust review lists each watch with what it
runs and how often. The watch runner (`src/main/watches.ts`) executes a
watched node's own `shell`, `file`, or `http` source through a dedicated
`CapabilityService` per dashboard, configured exactly like the active
runtime's (`definitionCapabilityContext`), so the node's declared permissions,
path containment, environment assembly, timeouts, and output bounds apply
unchanged. It runs only for registered dashboards whose definition validates
and passes the runtime's own rule (`ProjectRuntime.isDefinitionTrusted`,
including session revocation), rechecks registration and trust before every
read, never touches the active runtime's capability context, and stops on quit.

`ProjectSnapshot.trustReview` exposes availability and local-code disclosure
separately from `tree`. Nonfatal errors can withhold the tree while retaining
the permission union and persisted trust. Trust re-reads the current definition
before approval and rejects a changed permission set or fatal inspection error.
A successful decision persists the grant even when rendering is still invalid,
so diagnostics repair uses the ordinary trusted agent launcher and bundle
environment. Component code and configured processes remain withheld until
validation and compilation succeed. Added permissions still require review.
The palette retains `project:trust` after approval as a disabled action with
the reason "This project is already trusted." A new approval is available
only when `trustReview.available` is explicitly true.
Failed reloads can keep the last valid dashboard running; a newly inspected
permission expansion restricts it until approval. Fatal reloads do not grant
any capabilities from the broken config.

When no grant exists and capability inspection fails, diagnostics repair still
runs as an untrusted repair. It launches only the app-selected agent (the app
setting or a detected agent), resolved and executed without the bundle `.env`,
so no project-controlled environment or agent selection reaches the process.
Its prompt frames project files as untrusted data, confines edits to the
dashboard bundle, and forbids project commands and dependency installation.
The app lets the user approve reads and commands once, including installed
skill references, API discovery, and validation, so repair can proceed before
trust review. Commands are approved as a whole; their effects are not sandboxed.
It automatically refuses permission requests to fetch, switch modes, use
unclassified tools, or edit paths that resolve outside the bundle (symlinks
are followed component by component). It never offers "always allow", and it refuses mode changes, so every approval covers
one call. That narrows the agent but does not sandbox it: an ACP agent need not
ask before acting, and because it runs with the untrusted project as its
working directory, the agent's own configuration there (for example
`.claude/settings.json` hooks or `.gemini/settings.json` MCP servers) may run
code before any permission request (see
[Agents](./acp-client.md#untrusted-repair-policy)). Validation when the turn ends
reports the trust review the fix now needs and never launches the automatic
repair while the project is untrusted. The repair grants nothing: component
code, commands, and configured processes stay withheld, and the ordinary trust
review follows
once inspection succeeds. Like every configured agent launch it is driven only
by the user's explicit in-app request; the agent-control channel still cannot
start it.

The native host enables process-local automatic trust only when Electrobun's
reported channel is `dev`, never from an environment flag. Development loads
and new permission sets are trusted without writing a grant. Node capability
declarations and path checks still apply. Explicit revocation disables the
project for the remainder of that app session; restarting dev restores automatic
trust. Canary/release builds use persisted approval as before.

Per-node permissions shape the host API, protect against accidental use, and
constrain every component equally. They do not isolate trusted local components from one
another: all local code shares one renderer and could forge another node ID by
speaking the internal RPC protocol directly. Project trust is the security
boundary for local code. Strong per-component isolation would require
separate execution realms and authenticated capability channels.

Manifests may use `permissionsByProp` for capabilities activated by configured
props. The resolved tree includes only the permissions whose prop paths are
present in that node's props. Those effective permissions drive the project
trust union, the renderer host shape, and the main-process capability check.
They cannot be selected by renderer code at request time.

Local components receive only the host methods allowed by their manifest:

```ts
interface ComponentAction {
  id: string;
  label: string;
  description?: string;
  keywords?: string[];
  enabled?: boolean;
  disabledReason?: string;
  confirmation?: {
    title: string;
    message?: string;
    confirmLabel?: string;
  };
  run(): void | Promise<void>;
}

interface LocalComponentHost {
  /** Only the configured agent command is exposed; arbitrary environment values stay in the main process. */
  environment?: {
    values: Array<{ key: "DASH_BORED_AGENT"; value: string; source: "app" | "process" | "bundle" | "component" | "unset" }>;
    error?: string;
  };
  dashboard: {
    reload(): Promise<void>;
    updateProps(props: Record<string, unknown>): Promise<void>;
  };
  actions: { register(action: ComponentAction): () => void };
  filesystem?: {
    readText(path: string): Promise<string>;
    writeText?(path: string, content: string): Promise<void>;
  };
  http?: { request(request: HttpRequest): Promise<HttpResponsePayload> };
  shell?: { run(request: ShellRunRequest): Promise<ShellRunResult> };
  processes?: {
    get(nodeId?: string): ProcessSnapshot | undefined;
    start?(): Promise<ProcessSnapshot>;
    stop?(): Promise<ProcessSnapshot>;
  };
  webview?: { render(request: { url: string; style?: CSSProperties; reloadKey?: string | number; renderer?: "iframe" | "native" }): ReactNode };
}
```

External and local renderers receive exactly the same `LocalComponentRenderProps`
shape: typed `props`, generic rendered `children` and handles, and a
`LocalComponentHost`. The host is shaped solely by manifest permissions. No
external component receives an API that a local component cannot declare.

Agent composition uses ordinary declared actions and the public `agent:prompt`
flow. Components do not receive a starter-specific launch API. Agent approval,
launch, validation, and bounded repair remain app-owned.

Action registration is renderer-local and grants no host permission. A local
action ID begins with an ASCII letter and contains only letters, digits,
underscores, or hyphens. The renderer namespaces it by project revision, node
ID, and local action ID, and rejects simultaneous duplicates from one owner.
Registration returns a disposer intended for a React effect cleanup. The host
also clears all actions owned by an instance when that instance unmounts, the
project reloads, trust is revoked, or the active project changes.

An action may provide a description, search keywords, an unavailable state and
reason, and optional confirmation copy. Its callback runs as trusted local
component code in the shared renderer and can perform privileged work only by
calling that component instance's already-shaped host APIs. Manifests may
declare `actions` with stable IDs, labels, descriptions, and optional JSON
Schema `args`; declaring the field opts the component into checking runtime
registrations against that list. Omit the field to retain the legacy dynamic
registration contract for older local components. An undeclared registration becomes a
component action diagnostic and is not added to the registry.

The dogfood package-script catalog now demonstrates declared actions: a
project script emits stable-ID list items from `package.json`, and each Run
button invokes the declared action on a static command node. Item values pass
through bounded `DASH_ITEM_*` environment variables at process start. The
process resource model below supplies the authoritative exit snapshot.

Capability behavior is bounded:

- File reads are UTF-8, confined to the canonical project root, and limited to
  1 MiB.
- Dashboard icon reads are limited to 2 MiB and support SVG, PNG, JPEG, GIF, and
  WebP. Relative icon paths resolve from the owning config bundle and may point
  outside the project root; absolute paths and HTTP(S) URLs are also accepted.
  The main process returns a data URL to the renderer, and icon failures fall
  back to the generic sidebar glyph.
- HTTP accepts only `http:` and `https:` URLs and bounds response size and
  request time.
- Short shell calls bound output and execution time; an optional relative
  working directory must remain inside the project root.
- Markdown sources use those same bounds. Source polling is limited to
  1–300 seconds, stops while the view is hidden, and reports process snapshots
  only through a validated `process` resource reference and
  `process:observe` permission.
- Process and shell launches receive a fresh environment assembled in this
  order: component-declared values, app-published settings when configured,
  inherited process values, then the owning bundle's `.env` defaults. Bundle files are parsed as
  dotenv data; they are never evaluated as shell code or copied into
  `process.env`. The inherited desktop PATH is normalized with conventional
  user CLI directories without evaluating shell startup files. The renderer
  receives only the allowlisted effective
  `DASH_BORED_AGENT` value and its winning source, never arbitrary bundle or
  process secrets.
- Agent work reads no Git state and shows no file diffs. ACP diff content is
  reduced to touched paths with added/removed line counts, and its text is
  discarded (see [Agents](./acp-client.md#no-diffs)).
- Capability requests from untrusted projects, undeclared components, unknown
  nodes, or escaped paths fail with a permission or validation diagnostic.

The renderer CSP permits revisioned blob modules and the local websocket origins
needed for Vite, while blocking direct application HTTP requests from component
code. Supported HTTP access goes through the checked host RPC. Embedded
application pages default to iframes with `frame-src http: https:`. Both renderer
choices require the trusted `webview:embed` capability and absolute HTTP(S) URLs.

**Accepted temporary runtime risk (2026-10-25):** native proof with Electrobun
2.0.4 showed privileged preload globals, an RPC credential global, and WK message
handlers in iframe documents. The user explicitly accepted this exposure to
enable iframe rendering. The iframe sandbox does not isolate Electrobun's native
bridge; embedded pages must be treated as trusted code with potential access to
the application's privileges. Exposure was verified by inspecting presence and
types, without reading credential values or attempting privileged operations.

Track the upgrade under dashboard todo `iframe-runtime-isolation`. Adopt an
Electrobun runtime that supports main-frame-only privileged preload injection
AND rejection of subframe calls in all privileged native message handlers,
including handlers with replies. Before considering the risk resolved, prove
that iframe documents have neither credentials nor privileged initialization,
direct bridge calls from subframes are rejected, and ordinary dashboard RPC
still works. Browser-only tests cannot establish this boundary.

Iframes enable scripts, forms, downloads, and the page's own origin so module
scripts and storage work. Direct renderer-origin URLs are rejected. Production
uses a `views:` renderer origin excluded by `frame-src`; the privileged Vite
server sends `frame-ancestors 'none'` on every response to block iframe redirects
back into the dashboard origin. Fixture servers have no privileged bridge and
remain frameable. Browser origin isolation blocks parent-document access;
top navigation and popups are blocked. These restrictions do not fix native
bridge exposure. Framing restrictions from target pages are respected and never
proxied or stripped. The explicit `renderer: native` compatibility mode uses a
separate sandboxed `<electrobun-webview>` without a dash-bored RPC bridge.

The app never opens secondary windows. New-window requests from the main
webview (`target="_blank"` links, Cmd-click, `window.open`) are handed to the
user's default browser by `src/main/external-links.ts`, but only for `http:`,
`https:`, and `mailto:` URLs; other schemes are dropped. Embedded application
webviews are not covered.

## Agent-control channel

The running app's agent-control channel (see
[Lifecycle and agent tools](./lifecycle-cli.md#app-control)) is a local
automation surface for the user's own agents, not a new capability.

- It listens only on a Unix socket in `~/.config/dash-bored/run/`; the
  directory is 0700 and the socket 0600, so only the user's own processes can
  connect. There is no network listener and no token to leak.
- Request bodies are bounded JSON objects. Selections must map choice ids to
  option ids.
- Actions run through the same renderer `ActionStore` as
  the command palette, with the same availability and duplicate-run rules.
  Component actions still flow through their declared host APIs and project
  trust.
- `src/shared/agent-control.ts` refuses trust changes (`project:trust`,
  `project:revoke-trust`), the user's draft lifecycle (`project:edit`,
  `project:save-draft`, `project:cancel-edit`), the native Add dashboard
  chooser, and any action that declares a palette confirmation. The listing
  marks these with the refusal reason so agents can ask the user instead. It
  also refuses every `agent:*` action because configured prompts require a
  visible user review and explicit Send.
- The channel has no route to agent sessions. It cannot list, answer, or
  approve an agent's permission requests, and it cannot prompt, cancel, close,
  or hand off a session; only the user does that in the app.
- The read surfaces add no capability. Status reports the visible diagnostics
  (first 50, messages capped) and whether the project is trusted with the
  permissions awaiting approval; there is no route to change trust. `processes`
  and `logs` read the bounded snapshot main already holds for the process UI
  (tail capped at 1,000 lines, 2,000 characters per line), take no input, and
  cannot start, stop, or write to a process. Output can contain whatever a
  command printed, so it is as sensitive as the terminal panel the user sees;
  the same user-private socket guards it.
- Opening a dashboard is refused while there are unsaved dashboard changes or
  a save in progress (`editing: true`). Clean sessions do not block agents.
  It loads and registers
  the dashboard but never trusts it.
- `attention:<node>` is agent-callable without confirmation and accepts only
  `animation`, `message`, and `item` strings, validated in main before they
  reach the renderer. It changes presentation (reveal, a bounded animation, a
  notice) and never moves keyboard focus. Animation packages are data; main
  reads them only from built-ins, the personal animation directory, or a
  bundle in the open snapshot.
- `notify:<node>` is agent-callable without confirmation and accepts only a
  required `message` and an optional `item`, validated in main before they
  reach the renderer. It records a decision in the user's notification inbox
  about a node of the open dashboard and may show a system notification; it
  runs nothing, and more than one per dashboard within 30 seconds is recorded
  without being presented. Runs an agent starts through the channel never
  raise run notifications, so agents report their own results.
  `app status` adds the open decisions (at most 20, newest first, with
  whether the user read them) and the 10 most recently closed ones as
  `notifications`.
- `app:focus-window` is agent-callable without project trust or confirmation.
  It only restores, shows, and activates this instance's window, and remains
  available during unsaved or pending work. It cannot change drafts or select
  another application window.
- Screenshots capture only the app's own window: the NSWindow number (read
  through the Objective-C runtime after an `isKindOfClass:` check) is passed
  to `/usr/sbin/screencapture -l`. When the number is unavailable, capture
  falls back to the window's frame region, which includes anything covering
  it. Capture requires macOS Screen Recording permission; without it the app
  asks macOS once and returns `SCREEN_RECORDING_PERMISSION_REQUIRED`. The PNG
  is returned to the caller and not retained by the app. Stale grants after an
  ad hoc signed update have a desktop-only, confirmed, app-scoped reset; see
  [Screen Recording recovery](./lifecycle-cli.md#screen-recording-recovery).
  This never grants access or runs through an agent action. Keeping the webview
  rendering while covered (see
  [App control](./lifecycle-cli.md#app-control)) changes only WebKit's
  occlusion heuristic; it adds no capture path.
  A node screenshot is
  the same window capture cropped in process to the node's rectangle; it never
  captures anything outside the app's own window, and the temporary reveal it
  may perform runs through the same action path and is undone afterwards.

## Declarative process resources

Any component may declare a supervised process resource. The manifest maps the
resource to props containing its command and, optionally, a project-relative
working directory and string-valued environment:

```yaml
resources:
  process:
    commandProp: command
    interactive: true # optional: runs in a persistent PTY-backed terminal
    cwdProp: cwd
    envProp: env
permissions:
  - process:execute
```

Another component can reference that resource through a prop:

```yaml
references:
  processId:
    resource: process
permissions:
  - process:observe
```

The main process extracts and supervises every declared process resource
generically. Resource nodes require stable IDs; cross-node references are
validated against the resolved tree and IDs are remapped across config links.
Command-palette start/stop actions are derived from these resources, never
from component IDs or a special built-in list.

## Long-running commands

`./components/external/core/command` is the shipped example of an explicit user-action
component. A command never runs
just because a project was opened, trusted, or reloaded.

The main process owns each subprocess and streams stdout/stderr into a bounded
ring buffer. An `interactive: true` resource is one persistent PTY-backed
terminal whose configured command is a remembered quick action. Each run of that
command is its own PTY session, `$SHELL -i -c <command>` (`cmd.exe /d /s /c` on
Windows), so the run's completion and exit status come from the operating
system rather than from parsing terminal output, and command output cannot
forge them. When a run ends, the same terminal continues in a resting
interactive `$SHELL -i` for typed commands. Terminal input and Ctrl-C go to
whichever session is in front: the run while it executes, then the resting
shell. Commands typed into the resting shell are not runs and never change run
state. Starting another run replaces an idle resting shell by hanging it up;
a resting shell with a command of its own in the foreground (or whose state
cannot be read, as on Windows after the user typed into it) refuses the run
with `PROCESS_TERMINAL_BUSY` rather than end that work. Item values
(`DASH_ITEM_*`) enter only the run they were given to; the resting shell and
later plain quick actions never inherit them. The terminal keeps its size and
one continuous output buffer across sessions; the host frames each run with a
command header and exit line in the system stream. Shell state changed in the
resting shell, such as `cd` or `export`, does not carry into the next run.
Input typed while a run is finishing reaches that run, not the resting shell.

`ProcessSnapshot.phase`, `pid`, `exitCode`, and timing describe the process or
the whole interactive terminal; `run` records the latest run's phase, exit code
or signal, start, and duration and survives closing the terminal. Views,
status parsing, palette actions, and item feedback observe `run`. A node cannot
have duplicate concurrent runs, while a finished run can start again without
closing the terminal. Closing an interactive terminal hangs up the session in
front and its foreground job, then force-kills after a grace period;
non-interactive processes receive SIGTERM first. Agent work does not use these
terminals. Each ACP agent runs in its own process group through `/bin/sh -c`
(`exec` only for a plain invocation, so shell expressions run as written), and
the whole group is stopped on close, trust revocation, project removal, and app
exit. Everything the agent supplies is bounded before it reaches the renderer:
1 MiB of transcript text, capped lists, and cut paths and labels (see
[Agents](./acp-client.md#transcript-reduction)). Unchanged
command nodes keep their terminal across a hot reload, while removed or
materially changed command nodes are stopped. Trust revocation and application
exit terminate the terminal and its process tree.
