# Component authoring reference

Use this reference when neither the catalog from `dash-bored inspect .` nor a
source script feeding a built-in view ([sources.md](sources.md)) covers a
project-specific need. Packaged and local components use the same manifest,
render props, child handles, and permission-shaped host contract; this document
defines the local component contract.

## Dashboard nodes

Every dashboard is one recursive node:

```yaml
component: ./components/service-health
id: service-health
props:
  endpoint: http://127.0.0.1:3000/health
```

`component` is required. `id` is optional, but it must be explicit and unique
for stateful or actionable nodes. `props` is validated against the component's
JSON Schema. Tiled layouts use a direct `{ node, metadata? }` edge or a split
branch; managed layouts use an array of those edges. Dashboard files use schema
version 3; component manifests use schema version 2. Child entries may carry
`metadata` on the parent-child edge.

## Transparent child-surface grouping

`@dash-bored/group` is an ordinary transparent component boundary that accepts
and projects a core-tiled child surface. It is useful when a multi-component
panel needs a component boundary; it is not a layout engine, and it does not
own split topology or resize behavior. A card is not required for grouping.

## Conditional visibility

`@dash-bored/conditional` is a transparent layout boundary for setup and
recovery actions; a later migration replaces it with source-bound visibility
on the edge, so use it only for "show until done" setup steps. It accepts
exactly one tiled child and projects that child when a bounded shell command
exits successfully. Use `invert: true` to show the child until the condition
succeeds:

```yaml
component: "@dash-bored/conditional"
id: show-install-skill
props:
  command: test -f ".agents/skills/dash-bored/SKILL.md"
  invert: true
children:
  node:
    component: "@dash-bored/command"
    id: install-project-skill
    props:
      label: Install the project skill
      command: '"$DASH_BORED_TOOL" install-skill .'
```

Dashboard commands run inside the app, which publishes its bundled agent tool
as `DASH_BORED_TOOL`; nothing named `dash-bored` is on the user's `PATH`.

Optional `cwd`, `env`, `timeoutMs`, and `pollIntervalMs` props use the same
project-contained, bounded shell contract as `host.shell.run`. The component
requires `process:execute`, checks only while its containing panel is visible,
and fails open before trust or if the check fails to run.

## Tiled split layouts

Use a core-owned split branch when two child components should share one
rectangle. Horizontal splits can be resized directly:

```yaml
children:
  axis: horizontal
  first:
    node: ...
  second:
    node: ...
  ratio: 0.4
```

`ratio` is the optional project default fraction for the first pane and must be
between `0.1` and `0.9`; omit it for equal widths (`0.5`). The renderer applies
shared minimum pane sizes while dragging.
Normal-view resizing is a resettable personal override; editor resizing changes the draft
and follows Save/Cancel. A narrow split stacks its children according to its own
container width. Nest horizontal and vertical splits to create tiled layouts;
vertical splits use document flow and reject `ratio`.

Local component roots placed in a split should use fluid sizing: avoid fixed
widths, set `min-width: 0`, and put overflow on an internal scrolling region
when content cannot shrink.

## Local component layout

Create local code inside the standalone bundle that owns the dashboard:

```text
.dash-bored/components/service-health/
├── component.yaml
├── index.tsx
└── styles.css
```

Reference the directory as `./components/service-health`. Leave `renderMode`
out: it defaults to `surface`, a panel with its own height; `layout` is only
for an organizational container whose height must follow its descendants. A
minimal manifest is:

```yaml
schemaVersion: 2
id: service-health
name: Service health
description: Shows whether a project service responds.
entry: ./index.tsx
propsSchema:
  type: object
  additionalProperties: false
  properties:
    endpoint:
      type: string
      pattern: ^https?://
  required:
    - endpoint
children:
  min: 0
  max: 0
  presentation:
    type: tiled
    axes: both
permissions:
  - network:http
```

Any component can declare a supervised process resource. `commandProp` is
required; `cwdProp` and `envProp` are optional. Set `interactive: true` to
launch the command's quick action in a persistent PTY-backed shell:

```yaml
resources:
  process:
    commandProp: command
    interactive: true
    cwdProp: cwd
    envProp: env
permissions:
  - process:execute
```

A process-observing component can reference that resource generically:

```yaml
references:
  processId:
    resource: process
permissions:
  - process:observe
```

Resource nodes require stable IDs. References are validated across the
resolved tree, including config links, and command-palette actions are derived
from resources rather than component IDs.

## Manifest-declared actions

Declare stable component action IDs in `component.yaml`. This makes their
labels available to the palette and Settings before the component mounts, and
lets validation check references before runtime:

```yaml
actions:
  - id: refresh
    label: Refresh data
    description: Fetch the latest project state.
    args:
      type: object
      properties:
        force:
          type: boolean
```

When a manifest has an `actions` field, `host.actions.register` may register
only those IDs. A component without that field keeps the legacy dynamic
registration contract; this supports components such as `package-scripts`,
which discovers its action IDs from `package.json`.
Declared actions remain listed while their component is collapsed or hidden.
Until its handler mounts, the action is disabled with the reason
`Component is not mounted`.

`propsSchema` and `children.metadataSchema` are JSON Schema. `children` is
optional; when present it declares `min`, optional `max`, and a presentation
of `{type: tiled, axes: horizontal|vertical|both}` or `{type: managed}`.
Declare only capabilities the implementation uses:

- `filesystem:read` exposes `host.filesystem.readText`.
- `filesystem:write` also exposes `host.filesystem.writeText`.
- `network:http` exposes `host.http.request`.
- `process:execute` exposes `host.shell.run` and, for a declared process
  resource, `host.processes.start` and `host.processes.stop`.
- `process:observe` exposes `host.processes.get` snapshots for a referenced
  process.
- `webview:embed` exposes `host.webview.render` for native webview embedding.

All file paths and command working directories remain contained by the project
root associated with the component instance.

## Built-in views

`@dash-bored/status`, `list`, `chart`, and `markdown` read one bounded
`source`; [sources.md](sources.md) has their data shapes, tested scripts, and
the app's shell environment. A local component that only fetches and displays
data is usually a source script plus one of these views.

Keep chart values in YAML only when they are fixed facts:

```yaml
component: "@dash-bored/chart"
props:
  title: Release scope
  type: bar
  labels: [Q1, Q2, Q3, Q4]
  series:
    - label: Planned features
      values: [4, 6, 5, 7]
```

For values that change, give the chart a `source` that returns
`{ labels, series }`, such as an HTTP endpoint that already has that shape:

```yaml
component: "@dash-bored/chart"
id: request-rate
props:
  title: Requests per minute
  type: line
  source:
    http: http://127.0.0.1:3000/metrics/chart.json
    every: 30000
```

`@dash-bored/live-chart` is the older form of the same view; do not add new
ones.

For a small todo list that the user edits in the app, give
`@dash-bored/list` its own `todos`. Every item needs a stable `id`:

```yaml
component: "@dash-bored/list"
id: next-up
props:
  title: Next up
  todos:
    - id: verify-health-endpoint
      description: Verify the service health endpoint
      done: false
      tags: [operations]
```

Todos live in node props, not a separate file. Each item has exactly
`id`, `description`, boolean `done`, and `tags`. The list provides status
sorting, tag filtering, add/remove, and inline editing through the app's
draft Save/Cancel. `@dash-bored/todo-list` is the older form; do not add new
ones.

## TSX contract

Import `defineComponent` and hooks from `@dash-bored/component`; export
`defineComponent<Props>(({ props, children, host }) => ...)` as the default.
The complete [worked example](#worked-example-poll-git-status) below includes
manifest, TSX, CSS, and dashboard YAML, including cleanup and failure handling.

The callback receives typed `props`, a generic child surface (handles,
read-only descriptors, and render/visibility projection), and `host`:

```ts
interface LocalComponentHost {
  // Read-only public configuration; arbitrary environment values are not exposed.
  environment?: {
    values: Array<{ key: "DASH_BORED_AGENT"; value: string; source: "app" | "process" | "bundle" | "component" | "unset" }>;
    error?: string;
  };
  dashboard: {
    reload(): Promise<void>;
    updateProps(props: Record<string, unknown>): Promise<void>;
    // Requires trust and process:execute; starts a tracked setup request.
    setupWithAgent?(): Promise<{ taskId: string; command: string; componentPath: string; pid: number | null }>;
  };
  actions: { register(action: ComponentAction): () => void };
  filesystem?: {
    readText(path: string): Promise<string>;
    writeText?(path: string, content: string): Promise<void>;
  };
  http?: { request(request: Omit<HttpRequest, "nodeId">): Promise<HttpResponsePayload> };
  shell?: { run(request: Omit<ShellRunRequest, "nodeId">): Promise<ShellRunResult> };
  processes?: {
    get(nodeId?: string): ProcessSnapshot | undefined;
    start?(): Promise<ProcessSnapshot>;
    open?(): Promise<ProcessSnapshot>;
    runQuickAction?(): Promise<ProcessSnapshot>;
    write?(input: string): Promise<ProcessSnapshot>;
    resize?(cols: number, rows: number): Promise<ProcessSnapshot>;
    stop?(): Promise<ProcessSnapshot>;
  };
  webview?: {
    render(request: { url: string; title?: string }): ReactNode;
  };
}
```

The callback always receives exactly `LocalComponentRenderProps`: `props`,
generic rendered children/handles, and `host`. Shipped examples such as
`@dash-bored/command` and `@dash-bored/webview` are not special component types;
local components may declare the same resources and
permissions.

`host.actions.register` returns an effect cleanup function. Action IDs start
with a letter and contain only letters, digits, underscores, or hyphens.
An action may also declare ordered `choices`; each has an ID, label, and static
options or an options resolver that receives earlier selections. Its `run`
callback receives the completed selection map only after the user finishes the
palette flow.

Local components may import contained relative `.ts`, `.tsx`, and `.css`
files, `@dash-bored/component`, `react`, `react/jsx-runtime`, and
`react/jsx-dev-runtime`. These shared runtime modules do not require a local
`node_modules` directory. Other bare package imports, Node or Electrobun APIs,
absolute imports, paths outside the component directory (including escaping
symlinks), and CSS asset URLs are unsupported. Do not import types from an
application source path; the interfaces here describe the contract, not extra
runtime exports.

`@dash-bored/component` exports `defineComponent`, `createElement`, `Fragment`,
`useCallback`, `useContext`, `useDebugValue`, `useDeferredValue`, `useEffect`,
`useId`, `useImperativeHandle`, `useInsertionEffect`, `useLayoutEffect`,
`useMemo`, `useReducer`, `useRef`, `useState`, `useSyncExternalStore`, and
`useTransition`. Use the shared React runtime instead of bundling another copy.

## Validation loop

1. Run `dash-bored inspect . --summary` and reuse a built-in view, fed by a
   source script where needed, if it already fits.
2. When nothing fits the project need, add a small local manifest and implementation.
3. Add the local component node to the owning `dash-bored.yaml`.
4. Run `dash-bored validate . --json`; this validates and compiles local code.
5. Run `dash-bored inspect . --summary` again. Confirm the catalog entry is
   available, its permissions are expected, and the resolved tree uses it.
6. When the app is running and trusted, run
   `dash-bored app screenshot --focus <node-id>` and check the rendered result.

Trust is project-wide. Keep privileged behavior visible, bounded, and initiated
by the user where practical.

## HTTP and bounded shell payloads

The host supplies `nodeId`; local code sends only these fields:

```ts
interface HttpRequest {
  nodeId: string; // Supplied by the host, omitted in local calls.
  url: string; // Absolute http:// or https:// URL.
  method?: string; // GET by default.
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}
interface HttpResponsePayload {
  status: number;
  headers: Record<string, string>;
  body: string;
}
interface ShellRunRequest {
  nodeId: string; // Supplied by the host, omitted in local calls.
  command: string;
  cwd?: string; // Relative to the owning project root; defaults to that root.
  env?: Record<string, string>; // Overrides app, inherited, and owning-bundle defaults.
  timeoutMs?: number;
}
interface ShellRunResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}
```

HTTP returns a serializable payload, not a browser `Response`: check
`status >= 200 && status < 300`, then parse `JSON.parse(response.body)` and
validate the resulting data. There is no `response.ok` or `response.json()`.
Unlike the live-chart built-in's endpoint convenience, `host.http.request`
requires an absolute HTTP(S) URL. Network errors, invalid URLs, timeouts, and
oversized responses reject the promise; HTTP error statuses still return a
payload. Preserve the last useful result and show the latest refresh error.

`host.shell.run` is a bounded, noninteractive command. On macOS/Linux it uses
`/bin/sh -lc`; on Windows it uses `cmd.exe /d /s /c`. Check `timedOut`, `signal`,
and `exitCode`; a nonzero exit is a result, while launch, permission, and output
limit failures can reject. Keep read-only polling commands separate from
user-initiated mutations. Use declared process resources for long-running
services or interactive terminals. A contained `cwd` is not a shell sandbox:
commands retain the user's OS access. Do not interpolate untrusted strings
into command text; use fixed commands and validated inputs.

Default limits are 10 seconds per request (explicit `timeoutMs` up to 30000),
2 MiB for HTTP request/response bodies, and 1 MiB for each shell output stream.
Filesystem text reads/writes are limited to 1 MiB. The runtime may configure
stricter limits. Neither HTTP nor shell requests accept an `AbortSignal`;
cleanup should stop future polls and ignore late results. A running request
finishes or reaches its host timeout.

Host capabilities are optional according to manifest permissions, and calls
can still fail when project trust is absent or revoked. Handle both cases.
`host.dashboard.updateProps(nextProps)` replaces the whole props object in the
owning dashboard draft, where Save/Cancel applies; it does not silently write
YAML. `host.filesystem.writeText` is a direct file write and has a different
persistence boundary.

## Child projection and managed tabs

Tiled children are already composed by the core. Project them without
rebuilding the topology:

```tsx
return <section>{children?.type === "tiled" ? children.surface : null}</section>;
```

Managed children have this shape:

```ts
type ComponentRenderedChildren =
  | { type: "tiled"; surface: ReactNode }
  | { type: "managed"; items: ComponentChildHandle[] };
interface ComponentChildHandle {
  id: string;
  reference: string;
  displayName: string;
  metadata: Record<string, unknown>;
  render(options?: { visible?: boolean }): ReactNode;
}
```

For switchable panels, pair a tab-styled action bar with
`@dash-bored/selection`. Labels belong on the managed-child edges:

```yaml
schemaVersion: 3
name: Service dashboard
root:
  component: "@dash-bored/group"
  id: service-layout
  children:
    axis: vertical
    first:
      node:
        component: "@dash-bored/button"
        id: service-tabs
        props:
          variant: tabs
          items:
            - { name: Overview, action: "select:service-panels/service-state" }
            - { name: Tasks, action: "select:service-panels/service-tasks" }
    second:
      node:
        component: "@dash-bored/selection"
        id: service-panels
        props: { defaultChild: service-state }
        children:
          - metadata: { label: Overview }
            node:
              component: "@dash-bored/status"
              id: service-state
              props:
                label: Service
                source:
                  shell: curl -fsS --max-time 3 http://127.0.0.1:3000/health >/dev/null && echo '{"state":"healthy"}'
                  every: 15000
          - metadata: { label: Tasks }
            node:
              component: "@dash-bored/list"
              id: service-tasks
              props:
                todos: []
```

A custom managed container declares `children.presentation: { type: managed }`
and, if used, `children.metadataSchema` for its edge metadata. Iterate
`children.items`, key by `item.id`, read `item.metadata`, and call
`item.render({ visible: selected })`. This projects visibility to built-ins
that support it. CSS `display: none` alone does not convey that contract.

Local component props have no public visibility flag or hook. Built-in tabs
keep panels mounted, so arbitrary local effects do not automatically stop in
hidden tabs. A custom container can omit rendering inactive child handles to
unmount them (losing their local state), or a polling component can expose an
explicit Pause control. Always clean up timers and action registrations when
unmounted; collapse, replacement, and dashboard reload can unmount a component.

## Theme and sizing

Use the renderer's semantic CSS variables so the component fits its dashboard:

| Purpose | Variables |
| --- | --- |
| Backgrounds | `--bg`, `--surface`, `--surface-raised`, `--surface-hover` |
| Text | `--text`, `--muted`, `--faint` |
| Borders | `--border`, `--border-bright` |
| Accent | `--accent`, `--accent-strong`, `--accent-ink` |
| Status | `--positive`, `--warning`, `--negative` |
| Corners and shadow | `--radius-sm`, `--radius`, `--radius-lg`, `--shadow` |

Scope selectors under a component-specific class; local CSS shares the
renderer document. Inherit fonts, use semantic HTML and text status alongside
color, and keep keyboard focus visible. Do not redefine `:root`, `body`, or
app tokens from a component. Theme packages are separate from component nodes; see [theme tokens](theme-tokens.md). The reactive `useTheme()` hook returns the active `reference`, `appearance`, and resolved `tokens`. Use `min-width: 0`, fluid widths, and an internal scroll
region for large output rather than fixed tile dimensions.

## Worked example: poll git status

This example shows local-component mechanics (a bounded shell call, a
declared action, polling, cleanup, and failure handling) on a familiar
command. For a real Git panel, prefer a `list` or `status` fed by a source
script ([sources.md](sources.md)); write a component like this only when the
panel needs behavior no view provides.

This component provides a bounded read-only Git observer, Refresh in both the
panel and command palette, and an explicit Pause polling control. It needs
Git in the host environment and a Git repository at the owning project root.
The empty stdout from a clean repository is success. Command errors retain
the previous output and display the failure separately.

Create these three files under `.dash-bored/components/git-summary/` (or the
owning named bundle's `components/git-summary/`). No npm install is needed.

`component.yaml`:

```yaml
schemaVersion: 2
id: git-summary
name: Git summary
description: Polls a read-only Git status command and offers manual refresh.
entry: ./index.tsx
propsSchema:
  type: object
  additionalProperties: false
  properties:
    pollIntervalMs:
      type: integer
      minimum: 1000
      maximum: 300000
  required: []
children:
  min: 0
  max: 0
  presentation:
    type: tiled
    axes: both
permissions:
  - process:execute
```

`index.tsx`:

```tsx
import { defineComponent, useEffect, useRef, useState } from "@dash-bored/component";
import "./styles.css";

interface Props { pollIntervalMs?: number }

export default defineComponent<Props>(({ props, host }) => {
  const [output, setOutput] = useState("Waiting for the first result.");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [polling, setPolling] = useState(true);
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const interval = props.pollIntervalMs ?? 10000;

  useEffect(() => {
    let active = true;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const shell = host.shell;

    const refresh = async () => {
      if (!active || inFlight) return;
      if (!shell) {
        setError("Shell capability unavailable; check component permissions.");
        return;
      }
      inFlight = true;
      setBusy(true);
      try {
        const result = await shell.run({
          command: "git status --short",
          timeoutMs: 5000,
        });
        if (!active) return;
        if (result.timedOut) throw new Error("Git status timed out.");
        if (result.signal) throw new Error(`Git status stopped: ${result.signal}`);
        if (result.exitCode !== 0) {
          throw new Error(result.stderr.trim() || `Git exited with ${result.exitCode}`);
        }
        setOutput(result.stdout.trim() || "Working tree clean.");
        setError("");
      } catch (failure) {
        if (active) setError(failure instanceof Error ? failure.message : String(failure));
      } finally {
        inFlight = false;
        if (active) setBusy(false);
      }
    };
    refreshRef.current = refresh;
    setBusy(false);
    const unregister = host.actions.register({
      id: "refresh",
      label: "Refresh Git summary",
      description: "Run a bounded, read-only git status command.",
      enabled: Boolean(shell),
      disabledReason: shell ? undefined : "Shell capability unavailable",
      run: refresh,
    });
    const poll = async () => {
      await refresh();
      if (active && polling) timer = setTimeout(poll, interval);
    };
    if (polling) void poll();
    return () => {
      active = false;
      clearTimeout(timer);
      refreshRef.current = async () => {};
      unregister();
    };
  }, [host.shell, host.actions, interval, polling]);

  return (
    <section className="git-summary" aria-label="Git summary">
      <div className="git-summary__controls">
        <button type="button" disabled={busy} onClick={() => void refreshRef.current()}>
          {busy ? "Refreshing…" : "Refresh"}
        </button>
        <button type="button" aria-pressed={polling} onClick={() => setPolling(!polling)}>
          {polling ? "Pause polling" : "Resume polling"}
        </button>
        <small>{polling ? `Polling every ${interval / 1000}s` : "Polling paused"}</small>
      </div>
      {error && <p className="git-summary__error" role="status">{error}</p>}
      <pre className="git-summary__output" aria-busy={busy}>{output}</pre>
    </section>
  );
});
```

`styles.css`:

```css
.git-summary {
  min-width: 0;
  padding: 0.75rem;
  color: var(--text);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}
.git-summary__controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
}
.git-summary__controls button {
  padding: 0.4rem 0.65rem;
  color: var(--text);
  background: var(--surface-raised);
  border: 1px solid var(--border-bright);
  border-radius: var(--radius-sm);
}
.git-summary__controls button:hover { background: var(--surface-hover); }
.git-summary__controls button:focus-visible { outline: 2px solid var(--accent); }
.git-summary__controls button:disabled { opacity: 0.6; }
.git-summary__controls small { color: var(--muted); }
.git-summary__error { color: var(--negative); overflow-wrap: anywhere; }
.git-summary__output {
  min-width: 0;
  max-height: 20rem;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  margin-bottom: 0;
}
```

For an isolated dashboard, this is the complete `dash-bored.yaml`. In an
existing dashboard insert only its `root` node at the intended child edge;
preserve the rest of the tree.

```yaml
schemaVersion: 3
name: Git overview
root:
  component: ./components/git-summary
  id: git-summary
  props:
    pollIntervalMs: 10000
```

Run `dash-bored validate .` and `dash-bored inspect .` from the project root.
Validation checks manifests, props, tree references, and TSX/CSS compilation;
it does not execute the component or fully type-check TSX. Confirm the
`git-summary` catalog entry is available with only `process:execute` and its
node has the stable ID above. Reload the dashboard, then verify clean and
dirty repository output, manual/palette Refresh, Pause/Resume, failure text,
and a narrow tile. Do not claim runtime behavior from compilation alone.
Polling never overlaps within an effect, and cleanup ignores late responses;
changing props or toggling polling can leave an older bounded request finishing
while the new effect starts. Pausing stops future polls, not that request.
