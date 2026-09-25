# dash-bored - Architecture: Security and capabilities

## Trust and host capabilities

An untrusted project may be parsed and may render safe built-in layout and
inline content. It cannot compile local code, start a command, read or write a
project file, make an HTTP request, or instantiate a project webview.

The application presents one project-level trust decision with the complete
requested permission set. Trust is keyed by canonical project root and stores
the approved permission set in Electrobun's user-data directory. Reloading with
the same or a smaller permission set preserves trust; adding any permission
invalidates it and requires a new decision. Trust can also be revoked manually.
The main process checks both project trust and the requested node's declared
permission on every privileged RPC.

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
    setupWithAgent?(): Promise<ComponentAgentLaunch>;
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
  webview?: { render(request: { url: string; title?: string }): ReactNode };
}
```

Packaged and local renderers receive exactly the same `LocalComponentRenderProps`
shape: typed `props`, generic rendered `children` and handles, and a
`LocalComponentHost`. The host is shaped solely by manifest permissions. No
packaged component receives an API that a local component cannot declare.

The optional `dashboard.setupWithAgent` method is exposed only to trusted
nodes declaring `process:execute`. Its RPC rechecks the current node's permission
and owning config before launching; automatic repair never expands project trust.

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
- The app-owned Agent work Diff tab runs only a fixed, argument-vector `git diff`
  scoped to the task's canonical `.dash-bored/` bundle and bounds its output to
  512 KiB. It is not exposed as an arbitrary component shell capability.
- Capability requests from untrusted projects, undeclared components, unknown
  nodes, or escaped paths fail with a permission or validation diagnostic.

The renderer CSP permits revisioned blob modules and the local websocket origins
needed for Vite, while blocking direct application HTTP requests from component
code. Supported HTTP access goes through the checked host RPC. Embedded
application pages use sandboxed `<electrobun-webview>` elements and receive no
dash-bored RPC bridge.

## Agent-control channel

The running app's agent-control channel (see
[Lifecycle and agent tools](./lifecycle-cli.md#app-control)) is a local
automation surface for the user's own agents, not a new capability.

- It listens only on a Unix socket in `~/.config/dash-bored/run/`; the
  directory is 0700 and the socket 0600, so only the user's own processes can
  connect. There is no network listener and no token to leak.
- Request bodies are bounded JSON objects. Selections must map choice ids to
  option ids.
- Actions run through the same renderer action index and `ActionExecutor` as
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
- Opening a dashboard is refused while a draft is open. It loads and registers
  the dashboard but never trusts it.
- Screenshots capture only the app's own window: the NSWindow number (read
  through the Objective-C runtime after an `isKindOfClass:` check) is passed
  to `/usr/sbin/screencapture -l`. When the number is unavailable, capture
  falls back to the window's frame region, which includes anything covering
  it. Capture requires macOS Screen Recording permission; without it the app
  asks macOS once and returns `SCREEN_RECORDING_PERMISSION_REQUIRED`. The PNG
  is returned to the caller and not retained by the app.

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

`@dash-bored/command` is the shipped example of an explicit user-action
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
non-interactive processes receive SIGTERM first. Host-owned agent work sets the
internal `closeAfterRun` so its terminal ends with the agent's run. Unchanged
command nodes keep their terminal across a hot reload, while removed or
materially changed command nodes are stopped. Trust revocation and application
exit terminate the terminal and its process tree.
