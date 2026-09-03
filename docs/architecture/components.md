# dash-bored - Architecture: Component system

The built-in catalog includes inline display and managed-container components,
including `@dash-bored/chart` for YAML-defined static line or bar data and
`@dash-bored/live-chart` for polling a JSON chart model through the
`network:http` capability. These chart components share a dependency-free SVG
renderer and keep the last valid live result when a refresh fails.
It also includes `@dash-bored/conditional`, a generic shell-backed visibility
boundary for keeping setup or recovery actions relevant without special-casing
their component IDs.
Core composition branches are YAML topology and do not appear in the component
catalog.

## Standalone dashboard paths

A component reference outside the built-in `@dash-bored/*` namespace and the
bundle-local `./components/*` directory may resolve to another standalone
dashboard bundle or its `dash-bored.yaml`. For example,
`component: "./arvid"` in the canonical config loads
`.dash-bored/arvid/dash-bored.yaml`. This is a component boundary, not a
preprocessing directive.

Paths may be absolute or relative; relative paths resolve from the directory
containing the source `dash-bored.yaml`. The target uses its own
`dash-bored.yaml`, `dash-bored-lock.yaml`, `.env`, and `components/` directory
and renders inside the space allocated to the referencing component. No nodes,
locks, or component lookup state are merged into the containing config.

Broken paths are expected after users reorganize checked-in files. The
component instance reports that failure locally and leaves the containing
dashboard usable; dash-bored does not search for, rewrite, or repair the path.
Recursive references stop with a localized diagnostic at the component
boundary.

## Resolution

The `@dash-bored/*` namespace is reserved for built-ins. Project components are
referenced by a relative path below `./components/`, for example:

```yaml
component: "./components/service-health"
```

When a reference selects a local React component below `./components/`, the
resolver uses canonical real paths and rejects absolute paths, traversal,
symlinks that escape that bundle's component directory, and reserved-namespace
collisions. Those restrictions do not apply to standalone dashboard paths,
which intentionally allow absolute references.

A local component is a directory with this shape:

```text
components/service-health/
├── component.yaml
├── index.tsx
└── optional relative TS, TSX, and CSS files
```

Its manifest is self-describing:

```yaml
schemaVersion: 2
id: service-health
name: Service health
description: Shows project service health.
entry: ./index.tsx
renderMode: surface
propsSchema:
  type: object
  additionalProperties: false
children:
  min: 0
  max: 10
  presentation:
    type: tiled
    axes: both
permissions:
  - network:http
```

`renderMode` defaults to `surface`; use `layout` when the component is an
organizational boundary whose height must follow its descendants rather than an
independently resizable surface. `propsSchema` and,
for managed children, `children.metadataSchema` are JSON Schema. A component
that accepts children declares one contract with minimum
and maximum cardinality plus either app-owned tiled axes or managed
presentation. Managed presentation uses generic child handles and read-only
descriptors plus edge metadata. Supported permission names are:

- `filesystem:read`
- `filesystem:write`
- `network:http`
- `process:execute`
- `process:observe`
- `webview:embed`

Chart-shaped data uses a shared model:

```yaml
labels: [Mon, Tue, Wed, Thu]
series:
  - label: Checks passed
    values: [18, 24, 21, 29]
```

`@dash-bored/chart` receives that model through its required `labels` and
`series` props. `@dash-bored/live-chart` receives it from an HTTP JSON response.
Its `endpoint` may be absolute HTTP(S) or an app-relative path such as
`/metrics/chart.json`, and may optionally select a nested model with a
dot-separated `dataPath`; it accepts `type: line|bar`,
`pollIntervalMs: 1000..300000`, and `maxPoints: 2..200`. Live polling stops
while the containing tab is hidden.

Generic tree validation runs before component-specific props and children are
validated. The requested project permission set is the union of permissions
declared by every resolved component, packaged, project-local, or external.

## External components

An external component is a git submodule below `components/external/`,
referenced like any local component:

```yaml
component: "./components/external/service-health"
```

The name is the single directory segment below `components/external/`; deeper
paths inside the submodule resolve as external components too (monorepo
layouts). Reserved-namespace collisions are rejected by the same containment
rules as local components. Inside its directory the external component has
the same shape (`component.yaml`, `index.tsx`, contained relative imports),
the same manifest contract, and the same compile, host, and children behavior
as a project-local component. Only provenance and trust differ.

The pin lives in `dash-bored-lock.yaml`:

```yaml
lockfileVersion: 1
components:
  service-health:
    url: https://example.com/service-health.git
    commit: 0123456789abcdef0123456789abcdef01234567
    path: components/external/service-health
```

The lock entry path must match its key (`components/<name>` pins
`components/external/<name>`); mismatches are reported as diagnostics. A pin
change alters the code under trust, so every reload re-runs the
permission-union trust check against the manifests at the pinned commits: a
pin whose manifests declare a new permission invalidates the existing grant
and requires a new TrustPanel decision, exactly like adding a permission
(regression test "a pin update declaring new permissions invalidates trust"
in `tests/core/external-components.test.ts`). A pin that changes code without
declaring new permissions stays trusted; reviewing the pinned commit is the
control for that case.

An external directory without a manifest at its root is not necessarily
broken: discovery descends into initialized checkouts, so monorepo-style
repos may provide components deeper inside (referenced as
`./components/external/<name>/<path…>`, all labeled `external`). Only an
actually empty directory is an uninitialized checkout and stays in the
catalog as unavailable with a `COMPONENT_EXTERNAL_UNINITIALIZED` diagnostic
pointing at `dash-bored component sync`. A checked-out tree with no manifest
anywhere reports `COMPONENT_EXTERNAL_NO_MANIFEST` instead, so the library
flyout can show the Sync hint and the dashboard keeps rendering around it.
The renderer never runs git: add, update, remove, and sync are CLI operations
(`dash-bored component add|update|remove|sync`), and the flyout previews those
exact commands with a one-click copy.

## Local React contract and compilation

Local TSX imports its supported API from a virtual module:

```tsx
import {
  defineComponent,
  useEffect,
  useState,
} from "@dash-bored/component";

interface Props {
  endpoint: string;
}

export default defineComponent<Props>(({ props, children, host }) => {
  const [status, setStatus] = useState("waiting");

  useEffect(() => {
    void host.http?.request({ url: props.endpoint }).then(() => setStatus("ok"));
  }, [host.http, props.endpoint]);

  useEffect(() => host.actions.register({
    id: "refresh",
    label: "Refresh service health",
    run: async () => {
      await host.http?.request({ url: props.endpoint });
    },
  }), [host.actions, host.http, props.endpoint]);

  return (
    <section>
      {status}
      {children?.type === "tiled" ? children.surface : null}
    </section>
  );
});
```

`defineComponent` gives the component typed props, generic child handles and
read-only descriptors, a render/visibility projection, and a host object. The
virtual API re-exports the supported React hooks and ensures local
bundles share the renderer's one React runtime.

After the project is trusted, the main process compiles an entry with:

```ts
Bun.build({
  target: "browser",
  format: "esm",
  splitting: false,
});
```

A bundler plugin maps React and `@dash-bored/component` to renderer-owned
runtime modules. No output directory is configured, so the runtime consumes
the build's in-memory outputs without writing component bundles to disk. A
component may use contained relative TS, TSX, and CSS imports. Bare package
imports, Node or Electrobun APIs, files outside that component directory, and
unsupported asset types are rejected.

The compiled JavaScript and CSS travel in the project snapshot. The renderer
imports JavaScript through a revisioned blob URL and owns a replaceable style
element for its CSS. Each instance has an error boundary, so one failed local
component does not take down the dashboard.

Local-component hot reload is incremental within one dashboard bundle. An
unchanged compiled revision keeps its mounted component and stylesheet; a
changed revision keeps the previous component visible while the new blob module
loads, installs the replacement stylesheet before the React swap, and removes
the prior stylesheet on the following frame. Other local components therefore
do not pass through loading placeholders just because one bundle changed. A
dashboard switch clears the old bundle scope instead of reusing code across
projects.

This is a convenience boundary, not a hostile-code sandbox. Trusting a project
allows its local component code to execute in the shared application renderer.
The main process still rejects host requests unless their supplied node ID has
the requested permission, but that renderer-supplied identity is not an
authenticated boundary between mutually hostile local components.
