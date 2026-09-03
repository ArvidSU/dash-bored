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
  dashboard: { reload(): Promise<void> };
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
calling that component instance's already-shaped host APIs. Component actions
are intentionally unknown before the component is trusted and mounted; their
metadata is neither cached nor declared in `component.yaml` in this version.

The dogfood `package-scripts` component demonstrates dynamic action discovery:
it reads a configured `package.json`, registers one action for each
string-valued `scripts` entry, and invokes the selected package runner through
`host.shell.run` from the manifest's containing directory. It defaults to the
`packageManager` field when that field names Bun, npm, pnpm, or Yarn, while an
explicit runner prop can override it. These are short bounded shell actions.
Long-running workflows use the generic process resource model described below.

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

## Declarative process resources

Any component may declare a supervised process resource. The manifest maps the
resource to props containing its command and, optionally, a project-relative
working directory and string-valued environment:

```yaml
resources:
  process:
    commandProp: command
    interactive: true # optional: runs in a persistent PTY-backed shell
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
ring buffer. An `interactive: true` resource creates one persistent PTY-backed
shell. Its configured command is a remembered quick action: starting or
running that action writes it into the same shell, while terminal input, Ctrl-C,
and subsequent commands remain bidirectional. The owning component receives
raw terminal output and resizes the PTY as its visible surface changes. A node
cannot have duplicate concurrent runs. Unchanged command nodes keep their
terminal across a hot reload, while removed or materially changed command nodes
are stopped. Trust revocation and application exit terminate the shell and its
process tree.
