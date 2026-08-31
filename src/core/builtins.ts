import type { ComponentManifest } from "../shared/contracts";

const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  additionalProperties: false,
  properties,
  ...(required.length === 0 ? {} : { required }),
});

const string = { type: "string", minLength: 1 } as const;
const chartSeriesSchema = objectSchema(
  {
    label: string,
    values: {
      type: "array",
      minItems: 1,
      maxItems: 500,
      items: { type: ["number", "null"] },
    },
    color: string,
  },
  ["label", "values"],
);
const chartCommonProperties = {
  title: { type: "string" },
  type: { enum: ["line", "bar"] },
  maxPoints: { type: "integer", minimum: 2, maximum: 200 },
};

const manifests: ComponentManifest[] = [
  {
    schemaVersion: 2,
    id: "@dash-bored/tabs",
    name: "Tabs",
    description: "Switches between labeled dashboard panels.",
    entry: "builtin:tabs",
    renderMode: "layout",
    propsSchema: objectSchema({ defaultTab: { type: "integer", minimum: 0 } }),
    children: {
      min: 1,
      presentation: { type: "managed" },
      metadataSchema: objectSchema({ label: string }, ["label"]),
    },
  },
  {
    schemaVersion: 2,
    id: "@dash-bored/group",
    name: "Group",
    description: "Provides a neutral composition boundary for tiled dashboard content.",
    entry: "builtin:group",
    renderMode: "layout",
    propsSchema: objectSchema({}),
    children: {
      min: 0,
      presentation: { type: "tiled", axes: "both" },
    },
  },
  {
    schemaVersion: 2,
    id: "@dash-bored/card",
    name: "Card",
    description: "Frames dashboard content with an optional title.",
    entry: "builtin:card",
    propsSchema: objectSchema({ title: { type: "string" }, description: { type: "string" } }),
    children: {
      min: 0,
      presentation: { type: "tiled", axes: "both" },
    },
  },
  {
    schemaVersion: 2,
    id: "@dash-bored/text",
    name: "Text",
    description: "Displays plain text.",
    entry: "builtin:text",
    propsSchema: objectSchema(
      {
        content: { type: "string" },
        variant: { enum: ["title", "heading", "body", "muted", "code"] },
      },
      ["content"],
    ),
  },
  {
    schemaVersion: 2,
    id: "@dash-bored/markdown",
    name: "Markdown",
    description: "Displays Markdown with raw HTML disabled.",
    entry: "builtin:markdown",
    propsSchema: objectSchema({ content: { type: "string" } }, ["content"]),
  },
  {
    schemaVersion: 2,
    id: "@dash-bored/status",
    name: "Status",
    description: "Displays a labeled status indicator.",
    entry: "builtin:status",
    propsSchema: objectSchema(
      {
        label: string,
        state: { enum: ["unknown", "healthy", "warning", "error"] },
        detail: { type: "string" },
      },
      ["label", "state"],
    ),
  },
  {
    schemaVersion: 2,
    id: "@dash-bored/chart",
    name: "Chart",
    description: "Plots static line or bar data declared in dashboard YAML.",
    entry: "builtin:chart",
    propsSchema: objectSchema(
      {
        ...chartCommonProperties,
        labels: {
          type: "array",
          minItems: 1,
          maxItems: 500,
          items: { type: "string" },
        },
        series: {
          type: "array",
          minItems: 1,
          maxItems: 12,
          items: chartSeriesSchema,
        },
      },
      ["labels", "series"],
    ),
  },
  {
    schemaVersion: 2,
    id: "@dash-bored/live-chart",
    name: "Live chart",
    description: "Polls a JSON endpoint and plots its chart-shaped response.",
    entry: "builtin:live-chart",
    propsSchema: objectSchema(
      {
        ...chartCommonProperties,
        endpoint: { type: "string", pattern: "^(https?://|/|\\./)" },
        dataPath: { type: "string" },
        pollIntervalMs: { type: "integer", minimum: 1000, maximum: 300000 },
      },
      ["endpoint"],
    ),
    permissions: ["network:http"],
  },
  {
    schemaVersion: 2,
    id: "@dash-bored/command",
    name: "Command",
    description: "Starts or stops an explicitly configured project command.",
    entry: "builtin:command",
    propsSchema: objectSchema(
      {
        label: string,
        command: string,
        cwd: { type: "string", minLength: 1 },
        env: { type: "object", additionalProperties: { type: "string" } },
      },
      ["label", "command"],
    ),
    resources: {
      process: {
        commandProp: "command",
        cwdProp: "cwd",
        envProp: "env",
      },
    },
    permissions: ["process:execute"],
  },
  {
    schemaVersion: 2,
    id: "@dash-bored/terminal",
    name: "Terminal output",
    description: "Displays bounded output from a configured command.",
    entry: "builtin:terminal",
    propsSchema: objectSchema({ processId: string }, ["processId"]),
    references: { processId: { resource: "process" } },
    permissions: ["process:observe"],
  },
  {
    schemaVersion: 2,
    id: "@dash-bored/file",
    name: "File",
    description: "Displays a bounded UTF-8 project file.",
    entry: "builtin:file",
    propsSchema: objectSchema({ path: string }, ["path"]),
    permissions: ["filesystem:read"],
  },
  {
    schemaVersion: 2,
    id: "@dash-bored/env",
    name: "Environment editor",
    description: "Edits a project-local .env file as key-value pairs or raw text.",
    entry: "builtin:env",
    propsSchema: objectSchema({ path: string }, ["path"]),
    permissions: ["filesystem:read", "filesystem:write"],
  },
  {
    schemaVersion: 2,
    id: "@dash-bored/todo-list",
    name: "YAML todo list",
    description: "Keeps a small todo list in a project-owned YAML file.",
    entry: "builtin:todo-list",
    propsSchema: objectSchema({ path: string }, ["path"]),
    permissions: ["filesystem:read", "filesystem:write"],
  },
  {
    schemaVersion: 2,
    id: "@dash-bored/webview",
    name: "Webview",
    description: "Embeds an HTTP or HTTPS application page.",
    entry: "builtin:webview",
    propsSchema: objectSchema({ url: { type: "string", pattern: "^https?://" } }, ["url"]),
    permissions: ["webview:embed"],
  },
];

export const BUILTIN_COMPONENTS: ReadonlyMap<string, ComponentManifest> = new Map(
  manifests.map((manifest) => [manifest.id, manifest]),
);

export function getBuiltinManifest(reference: string): ComponentManifest | undefined {
  return BUILTIN_COMPONENTS.get(reference);
}

export function listBuiltinManifests(): ComponentManifest[] {
  return [...BUILTIN_COMPONENTS.values()];
}
