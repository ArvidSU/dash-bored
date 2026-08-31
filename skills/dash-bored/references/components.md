# Component authoring reference

Use this reference when the catalog from `dash-bored inspect .` does not cover
a project-specific need. Packaged and local components use the same manifest,
render props, child handles, and permission-shaped host contract; this document
defines the local component contract.

## Dashboard nodes

Every dashboard is one recursive node:

```yaml
component: "@dash-bored/card"
id: service-health
props:
  title: Service health
children:
  type: tiled
  layout:
    type: child
    child:
      node:
        component: "./components/service-health"
        props:
          endpoint: http://127.0.0.1:3000/health
```

`component` is required. `id` is optional, but it must be explicit and unique
for stateful or actionable nodes. `props` is validated against the component's
JSON Schema. Tiled layouts use child leaves or split branches; managed layouts
use an `items` list. Child entries may carry `metadata` on the parent-child edge.

## Transparent child-surface grouping

`@dash-bored/group` is an ordinary transparent component boundary that accepts
and projects a core-tiled child surface. It is useful when a multi-component
panel needs a component boundary; it is not a layout engine, and it does not
own split topology or resize behavior. A card is not required for grouping.

## Tiled split layouts

Use a core-owned split branch when two child components should share one
rectangle. Horizontal and vertical splits can be resized directly:

```yaml
children:
  type: tiled
  layout:
    type: split
    axis: horizontal
    ratio: 0.4
    first: { type: child, child: { node: ... } }
    second: { type: child, child: { node: ... } }
```

`ratio` is the project default fraction for the first pane and must be between
`0.1` and `0.9`. The renderer applies shared minimum pane sizes while dragging.
Normal-view resizing is a resettable personal override; editor resizing changes the draft
and follows Save/Cancel. A narrow split stacks its children according to its own
container width. Nest horizontal and vertical splits to create tiled layouts;
vertical splits use the same core resize contract.

Local component roots placed in a split should use fluid sizing: avoid fixed
widths, set `min-width: 0`, and put overflow on an internal scrolling region
when content cannot shrink.

## Local component layout

Create local code inside the standalone bundle that owns the dashboard:

```text
dash-bored/components/service-health/
├── component.yaml
├── index.tsx
└── styles.css
```

Reference the directory as `./components/service-health`. A minimal manifest is:

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
  max: 10
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

## Built-in charts

Use `@dash-bored/chart` when the values belong in the dashboard YAML:

```yaml
component: "@dash-bored/chart"
props:
  title: Weekly throughput
  type: bar
  labels: [Mon, Tue, Wed, Thu]
  series:
    - label: Checks passed
      values: [18, 24, 21, 29]
```

Use `@dash-bored/live-chart` for an HTTP JSON endpoint. Its `endpoint` may be
an absolute HTTP(S) URL or an app-relative path such as `/metrics/chart.json`.
It accepts the same `labels` and `series` model, an optional dot-separated
`dataPath`, and a `pollIntervalMs` between 1000 and 300000. It requires `network:http`; the
renderer keeps the most recent valid chart when a refresh fails and stops
polling while the containing tab is hidden.

Use `@dash-bored/todo-list` for a small project-owned YAML todo list:

```yaml
component: "@dash-bored/todo-list"
props:
  path: dash-bored/todos.yaml
```

The YAML data model is deliberately limited to `description`, boolean `done`,
and `tags`. The built-in provides status sorting, tag filtering, add/remove,
and inline description and tag editing.

## TSX contract

Import the supported API from `@dash-bored/component`:

```tsx
import {
  defineComponent,
  useEffect,
  useState,
} from "@dash-bored/component";
import "./styles.css";

interface Props {
  endpoint: string;
}

export default defineComponent<Props>(({ props, host }) => {
  const [status, setStatus] = useState("Waiting");

  const refresh = async () => {
    const response = await host.http?.request({ url: props.endpoint });
    setStatus(response?.status === 200 ? "Healthy" : `HTTP ${response?.status ?? "?"}`);
  };

  useEffect(() => {
    void refresh();
  }, [props.endpoint]);

  useEffect(() => host.actions.register({
    id: "refresh",
    label: "Refresh service health",
    run: refresh,
  }), [host.actions, host.http, props.endpoint]);

  return (
    <section className="service-health">
      <strong>{status}</strong>
      {/* Render projected children through the generic child surface. */}
    </section>
  );
});
```

The callback receives typed `props`, a generic child surface (handles,
read-only descriptors, and render/visibility projection), and `host`:

```ts
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

Local components may import contained relative TypeScript, TSX, and CSS files.
They may not use bare package imports, Node or Electrobun APIs, unsupported
assets, absolute imports, or files outside their component directory. React
and its supported hooks come through `@dash-bored/component` so the component
shares the renderer's React runtime.

## Validation loop

1. Run `dash-bored inspect .` and reuse a built-in if it already fits.
2. Add the local manifest and implementation only when necessary.
3. Add the local component node to the owning `dash-bored.yaml`.
4. Run `dash-bored validate .`; this validates and compiles local code.
5. Run `dash-bored inspect .` again. Confirm the catalog entry is available,
   its permissions are expected, and the resolved tree uses it.

Trust is project-wide. Keep privileged behavior visible, bounded, and initiated
by the user where practical.
