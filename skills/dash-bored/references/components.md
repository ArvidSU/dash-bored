# Component authoring reference

Use this reference when the built-in catalog from `dash-bored inspect .` does
not cover a project-specific need. The catalog is authoritative for built-in
props and slots; this document defines the local component contract.

## Dashboard nodes

Every dashboard is one recursive node:

```yaml
component: "@dash-bored/card"
id: service-health
props:
  title: Service health
slots:
  children:
    component: "./components/service-health"
    props:
      endpoint: http://127.0.0.1:3000/health
```

`component` is required. `id` is optional, but it must be explicit and unique
for stateful or actionable nodes. `props` is validated against the component's
JSON Schema. A slot accepts one node or a list according to the manifest's
`multiple` declaration.

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
schemaVersion: 1
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
slots:
  children:
    required: false
    multiple: true
permissions:
  - network:http
```

`propsSchema` is JSON Schema. Each slot may set `required` and `multiple`.
Declare only capabilities the implementation uses:

- `filesystem:read` exposes `host.filesystem.readText`.
- `filesystem:write` also exposes `host.filesystem.writeText`.
- `network:http` exposes `host.http.request`.
- `process:execute` exposes `host.shell.run`.

All file paths and command working directories remain contained by the project
root associated with the component instance.

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

export default defineComponent<Props>(({ props, slots, host }) => {
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
      {slots.children}
    </section>
  );
});
```

The callback receives typed `props`, rendered slot arrays, and `host`:

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
}
```

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
