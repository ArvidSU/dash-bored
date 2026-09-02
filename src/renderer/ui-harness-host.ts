import Ajv, { type ErrorObject } from "ajv";
import type {
  AppSettings,
  CompiledLocalComponent,
  ComponentAgentLaunch,
  ComponentAgentRequest,
  ComponentCatalogItem,
  ComponentChildEdge,
  ComponentChildLayout,
  ComponentCreationAgentRequest,
  ComponentPropsValidation,
  ComponentNode,
  Diagnostic,
  DashboardConfig,
  DashboardAgentTask,
  DashboardConfigSource,
  DashboardDraftValidation,
  FileReadRequest,
  FileWriteRequest,
  HttpRequest,
  HttpResponsePayload,
  ProcessSnapshot,
  ProjectDeletionPreview,
  ProjectListItem,
  ProjectOutline,
  ProjectSnapshot,
  ProjectTarget,
  ResolvedComponentNode,
  ShellRunRequest,
  ShellRunResult,
} from "../shared/contracts";
import type { DashboardHost, HostEvent } from "./rpc-client";

const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });

const PROJECT_ROOT = "/ui-harness/dash-bored";
const CONFIG_PATH = "/ui-harness/dash-bored/dash-bored.yaml";

function builtin(
  id: string,
  props: Record<string, unknown> = {},
  children?: ResolvedComponentNode["children"],
  reference?: string,
): ResolvedComponentNode {
  return {
    id,
    component: reference ?? (id === "harness-root"
      ? "@dash-bored/tabs"
      : id.startsWith("@") ? id : `@dash-bored/${id}`),
    props,
    ...(children ? { children } : {}),
    source: "builtin",
    sourceConfigPath: CONFIG_PATH,
    sourcePath: id === "harness-root" ? "root" : `harness.${id}`,
  };
}

const tree = builtin("harness-root", { label: "Visual verification fixture" }, {
  type: "managed",
  items: [
    {
      metadata: { label: "Wide layout" },
      node: builtin("group", {}, {
        type: "tiled",
        layout: {
          type: "split",
          axis: "horizontal",
          ratio: 0.42,
          first: {
            type: "child",
            child: {
              node: builtin("renderer-proof-card", {
                title: "Renderer proof",
                description: "This is the real dashboard renderer with an inert fixture host.",
              }, {
                type: "tiled",
                layout: {
                  type: "child",
                  child: { node: builtin("renderer-proof-status", { label: "Fixture status", state: "healthy", detail: "Resize, switch tabs, open the sidebar, and inspect the component library." }, undefined, "@dash-bored/status") },
                },
              }, "@dash-bored/card"),
            },
          },
          second: {
            type: "split",
            axis: "vertical",
            ratio: 0.55,
            first: {
              type: "child",
              child: { node: builtin("status", { label: "Renderer fixture", state: "healthy", detail: "Deterministic local snapshot; no desktop bridge." }) },
            },
            second: {
              type: "child",
              child: { node: builtin("responsive-card", { title: "Responsive tile", description: "Nested tiled composition must remain legible at narrow widths." }, undefined, "@dash-bored/card") },
            },
          },
        },
      }),
    },
    {
      metadata: { label: "Boundary" },
      node: builtin("boundary-card", {
        title: "Native boundary",
        description: "This fixture proves renderer behavior only. Webview overlays, desktop chrome, and native pointer injection require the exact Electrobun app check.",
      }, {
        type: "tiled",
          layout: {
            type: "split",
            axis: "vertical",
            ratio: 0.5,
          first: {
            type: "child",
            child: { node: builtin("renderer-proof-todos", {
              todos: [{ description: "Keep this surface mounted", done: false, tags: ["fixture"] }],
            }, undefined, "@dash-bored/todo-list") },
          },
            second: {
              type: "split",
              axis: "vertical",
              ratio: 0.5,
              first: {
                type: "child",
                child: { node: builtin("boundary-status", { label: "Renderer boundary", state: "healthy", detail: "Use the fixture for responsive review; desktop proof remains separate." }, undefined, "@dash-bored/status") },
              },
              second: {
                type: "child",
                child: { node: builtin("local-host-stability", {}, undefined, "./components/host-stability") },
              },
            },
        },
      }, "@dash-bored/card"),
    },
  ],
});

const initialConfig: DashboardConfig = {
  schemaVersion: 2,
  name: "Visual verification fixture",
  root: {
    id: tree.id,
    component: tree.component,
    children: tree.children,
  },
};

const catalog: ComponentCatalogItem[] = ["group", "conditional", "tabs", "card", "markdown", "status", "command", "todo-list"].map((name) => ({
  reference: `@dash-bored/${name}`,
  source: "builtin" as const,
  available: true,
  diagnostics: [],
  manifest: {
    schemaVersion: 2,
    id: `@dash-bored/${name}`,
    name: name[0]!.toUpperCase() + name.slice(1),
    description: `Fixture ${name} component.`,
    entry: `builtin:${name}`,
    ...(name === "group" || name === "conditional" || name === "tabs" ? { renderMode: "layout" as const } : {}),
    ...(name === "command" || name === "conditional" ? { permissions: ["process:execute" as const] } : {}),
    ...(name === "markdown" ? { permissions: ["filesystem:read" as const, "filesystem:write" as const] } : {}),
    propsSchema: name === "markdown"
      ? {
          type: "object",
          additionalProperties: false,
          properties: { content: { type: "string" }, path: { type: "string", minLength: 1 } },
          anyOf: [{ required: ["content"] }, { required: ["path"] }],
        }
      : name === "status"
        ? { type: "object", additionalProperties: false, properties: { label: { type: "string", minLength: 1 }, state: { enum: ["unknown", "healthy", "warning", "error"] }, detail: { type: "string" } }, required: ["label", "state"] }
        : name === "card"
          ? { type: "object", additionalProperties: false, properties: { title: { type: "string" }, description: { type: "string" } } }
          : name === "tabs"
            ? { type: "object", additionalProperties: false, properties: { defaultTab: { type: "integer", minimum: 0 } } }
            : name === "command"
              ? {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    label: { type: "string" },
                    command: { type: "string", minLength: 1 },
                    cwd: { type: "string", minLength: 1 },
                    env: { type: "object", additionalProperties: { type: "string" } },
                  },
                  required: ["command"],
                }
              : name === "todo-list"
                ? {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      todos: {
                        type: "array",
                        maxItems: 500,
                        items: {
                          type: "object",
                          additionalProperties: false,
                          properties: {
                            description: { type: "string", minLength: 1 },
                            done: { type: "boolean" },
                            tags: { type: "array", maxItems: 32, items: { type: "string", minLength: 1 } },
                          },
                          required: ["description", "done", "tags"],
                        },
                      },
                    },
                  }
              : name === "conditional"
                ? {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      command: { type: "string", minLength: 1 },
                      cwd: { type: "string", minLength: 1 },
                      env: { type: "object", additionalProperties: { type: "string" } },
                      invert: { type: "boolean" },
                      pollIntervalMs: { type: "integer", minimum: 1000, maximum: 300000 },
                      timeoutMs: { type: "integer", minimum: 1, maximum: 30000 },
                    },
                    required: ["command"],
                  }
              : { type: "object", additionalProperties: false },
    ...(name === "tabs" ? {
      children: {
        min: 1,
        presentation: { type: "managed" as const },
        metadataSchema: {
          type: "object",
          properties: { label: { type: "string" } },
          required: ["label"],
        },
      },
    } : name === "group" || name === "card" || name === "conditional" ? {
      children: {
        min: name === "conditional" ? 1 : 0,
        ...(name === "conditional" ? { max: 1 } : {}),
        presentation: { type: "tiled" as const, axes: "both" as const },
      },
    } : {}),
  },
}));

catalog.push({
  reference: "./components/host-stability",
  source: "local",
  available: true,
  diagnostics: [],
  manifest: {
    schemaVersion: 2,
    id: "host-stability",
    name: "Host stability fixture",
    description: "Verifies process updates do not restart unrelated local-component effects.",
    entry: "./index.tsx",
    propsSchema: { type: "object", additionalProperties: false },
  },
});

const hostStabilityComponent: CompiledLocalComponent = {
  componentId: "host-stability",
  revision: "fixture-host-stability-1",
  javascript: `
    const runtime = globalThis.__DASH_BORED_COMPONENT_RUNTIME__;
    const { createElement, defineComponent, useEffect, useState } = runtime;
    export default defineComponent(({ host }) => {
      const [effectRuns, setEffectRuns] = useState(0);
      useEffect(() => { setEffectRuns((runs) => runs + 1); }, [host]);
      return createElement("p", { "data-testid": "local-host-effect-runs" }, "Host effects " + effectRuns);
    });
  `,
  css: "",
};

function fixtureDiagnostic(code: string, message: string, path?: string): Diagnostic {
  return { severity: "error", code, message, ...(path === undefined ? {} : { path }) };
}

function fixtureSchemaDiagnostic(error: ErrorObject, path: string, code: string): Diagnostic {
  return fixtureDiagnostic(code, error.message ?? "Invalid value.", `${path}${error.instancePath.replaceAll("/", ".")}`);
}

function fixtureChildEdges(children: ComponentNode["children"]): ComponentChildEdge[] {
  if (!children) return [];
  if (children.type === "managed") return children.items;
  const visit = (layout: ComponentChildLayout): ComponentChildEdge[] => layout.type === "child"
    ? [layout.child]
    : [...visit(layout.first), ...visit(layout.second)];
  return visit(children.layout);
}

/**
 * Browser-safe, conservative mirror of the DashboardHost draft boundary.
 * The main-process loader remains the source of truth for disk, lock, and
 * local-component validation; this fixture covers the config/catalog contract
 * which is meaningful in a browser-only test host.
 */
function validateFixtureDraft(config: DashboardConfig): DashboardDraftValidation {
  const diagnostics: Diagnostic[] = [];
  if (config.schemaVersion !== 2) diagnostics.push(fixtureDiagnostic("CONFIG_SCHEMA_INVALID", "schemaVersion must be 2.", "schemaVersion"));
  if (typeof config.name !== "string" || config.name.trim() === "") diagnostics.push(fixtureDiagnostic("CONFIG_SCHEMA_INVALID", "name is required.", "name"));
  const ids = new Set<string>();
  const permissions = new Set<DashboardDraftValidation["requestedPermissions"][number]>();
  let nodeCount = 0;
  const visit = (node: ComponentNode, path: string, depth: number): void => {
    nodeCount += 1;
    if (nodeCount > 1024) {
      diagnostics.push(fixtureDiagnostic("TREE_TOO_LARGE", "Dashboard trees may contain at most 1024 nodes.", path));
      return;
    }
    if (depth > 64) {
      diagnostics.push(fixtureDiagnostic("TREE_TOO_DEEP", "Dashboard trees may be at most 64 levels deep.", path));
      return;
    }
    if (!node.component?.trim()) {
      diagnostics.push(fixtureDiagnostic("CONFIG_SCHEMA_INVALID", "component is required.", `${path}.component`));
      return;
    }
    if (node.id) {
      if (ids.has(node.id)) diagnostics.push(fixtureDiagnostic("NODE_ID_DUPLICATE", `Duplicate node id: ${node.id}`, path));
      ids.add(node.id);
    }
    const item = catalog.find((entry) => entry.reference === node.component);
    if (!item?.available || !item.manifest) {
      diagnostics.push(fixtureDiagnostic("COMPONENT_UNAVAILABLE", `Component ${node.component} is unavailable.`, `${path}.component`));
      return;
    }
    const manifest = item.manifest;
    for (const permission of manifest.permissions ?? []) permissions.add(permission);
    const validateProps = ajv.compile(manifest.propsSchema);
    if (!validateProps(node.props ?? {})) {
      diagnostics.push(...(validateProps.errors ?? []).map((error) => fixtureSchemaDiagnostic(error, `${path}.props`, "COMPONENT_PROPS_INVALID")));
    }
    const definition = manifest.children;
    const edges = fixtureChildEdges(node.children);
    if (!definition && node.children) diagnostics.push(fixtureDiagnostic("COMPONENT_CHILDREN_UNSUPPORTED", `${manifest.name} does not accept children.`, `${path}.children`));
    if (definition && node.children && definition.presentation.type !== node.children.type) {
      diagnostics.push(fixtureDiagnostic("COMPONENT_CHILD_PRESENTATION_INVALID", `${manifest.name} requires ${definition.presentation.type} children.`, `${path}.children.type`));
    }
    if (definition && edges.length < definition.min) diagnostics.push(fixtureDiagnostic("COMPONENT_CHILD_CARDINALITY", `${manifest.name} requires at least ${definition.min} children.`, `${path}.children`));
    if (definition?.max !== undefined && edges.length > definition.max) diagnostics.push(fixtureDiagnostic("COMPONENT_CHILD_CARDINALITY", `${manifest.name} accepts at most ${definition.max} children.`, `${path}.children`));
    const visitEdge = (edge: ComponentChildEdge, edgePath: string): void => {
      if (!definition?.metadataSchema && edge.metadata !== undefined) {
        diagnostics.push(fixtureDiagnostic("COMPONENT_CHILD_METADATA_UNSUPPORTED", `${manifest.name} does not declare child metadata.`, `${edgePath}.metadata`));
      } else if (definition?.metadataSchema) {
        const validateMetadata = ajv.compile(definition.metadataSchema);
        if (!validateMetadata(edge.metadata ?? {})) diagnostics.push(...(validateMetadata.errors ?? []).map((error) => fixtureSchemaDiagnostic(error, `${edgePath}.metadata`, "COMPONENT_CHILD_METADATA_INVALID")));
      }
      visit(edge.node, `${edgePath}.node`, depth + 1);
    };
    const visitLayout = (layout: ComponentChildLayout, layoutPath: string): void => {
      if (layout.type === "child") return visitEdge(layout.child, `${layoutPath}.child`);
      if (layout.ratio < 0.1 || layout.ratio > 0.9) diagnostics.push(fixtureDiagnostic("COMPONENT_CHILD_RATIO_INVALID", "Tiled split ratios must be between 0.1 and 0.9.", `${layoutPath}.ratio`));
      if (definition?.presentation.type === "tiled" && definition.presentation.axes !== "both" && layout.axis !== definition.presentation.axes) {
        diagnostics.push(fixtureDiagnostic("COMPONENT_CHILD_AXIS_INVALID", `${manifest.name} only allows ${definition.presentation.axes} tiled splits.`, `${layoutPath}.axis`));
      }
      visitLayout(layout.first, `${layoutPath}.first`);
      visitLayout(layout.second, `${layoutPath}.second`);
    };
    if (node.children?.type === "managed") node.children.items.forEach((edge, index) => visitEdge(edge, `${path}.children.items[${index}]`));
    if (node.children?.type === "tiled") visitLayout(node.children.layout, `${path}.children.layout`);
  };
  visit(config.root, "root", 0);
  return { ok: diagnostics.length === 0, diagnostics, requestedPermissions: [...permissions] };
}

function resolveFixtureNode(node: ComponentNode, path = "root"): ResolvedComponentNode {
  const item = catalog.find((entry) => entry.reference === node.component);
  const resolved: ResolvedComponentNode = {
    id: node.id ?? path,
    component: node.component,
    props: structuredClone(node.props ?? {}),
    source: item?.source ?? "builtin",
    sourceConfigPath: CONFIG_PATH,
    sourcePath: path,
    ...(item?.manifest ? { manifest: structuredClone(item.manifest) } : {}),
  };
  if (node.children?.type === "managed") {
    resolved.children = { type: "managed", items: node.children.items.map((edge, index) => ({
      node: resolveFixtureNode(edge.node, `${path}.children.items[${index}].node`),
      ...(edge.metadata === undefined ? {} : { metadata: structuredClone(edge.metadata) }),
    })) };
  } else if (node.children?.type === "tiled") {
    const resolveLayout = (layout: ComponentChildLayout, layoutPath: string): ComponentChildLayout<ResolvedComponentNode> => layout.type === "child"
      ? { type: "child", child: { node: resolveFixtureNode(layout.child.node, `${layoutPath}.child.node`), ...(layout.child.metadata === undefined ? {} : { metadata: structuredClone(layout.child.metadata) }) } }
      : { type: "split", axis: layout.axis, ratio: layout.ratio, first: resolveLayout(layout.first, `${layoutPath}.first`), second: resolveLayout(layout.second, `${layoutPath}.second`) };
    resolved.children = { type: "tiled", layout: resolveLayout(node.children.layout, `${path}.children.layout`) };
  }
  return resolved;
}

function project(config: DashboardConfig): ProjectListItem {
  return { projectRoot: PROJECT_ROOT, configPath: CONFIG_PATH, dashboardName: config.name };
}

export interface UiHarnessHost extends DashboardHost {
  /** Test-only inspection is exposed only on the ui-harness page. */
  getPersistedConfig(): DashboardConfig;
  /** Test-only diagnostics control is exposed only on the ui-harness page. */
  setDiagnostics(diagnostics: Diagnostic[]): Promise<void>;
}

export function createUiHarnessHost(): UiHarnessHost {
  const listeners = new Set<(event: HostEvent) => void>();
  let settings: AppSettings = {
    dashBoredAgent: "codex exec",
    favoriteActionIds: [],
    commandPaletteShortcut: "Mod+K",
    actionShortcuts: { "app:reload": "Mod+Shift+R" },
  };
  let persistedConfig = structuredClone(initialConfig);
  let configRevision = 1;
  let snapshotRevision = 1;
  let currentDiagnostics: Diagnostic[] = [];
  const processSnapshots = new Map<string, ProcessSnapshot>();
  const files = new Map<string, string>([
    ["README.md", "# Fixture document\n\nThis file is loaded by the Markdown component.\n"],
  ]);
  const emit = (event: HostEvent): void => listeners.forEach((listener) => listener(event));
  const snapshot = (): ProjectSnapshot => {
  return {
    projectRoot: PROJECT_ROOT,
    configPath: CONFIG_PATH,
    dashboardName: persistedConfig.name,
    iconDataUrl: null,
    config: structuredClone(persistedConfig),
    configRevision: `ui-harness-${configRevision}`,
    componentCatalog: structuredClone(catalog),
    trusted: true,
    requestedPermissions: validateFixtureDraft(persistedConfig).requestedPermissions,
    tree: resolveFixtureNode(persistedConfig.root),
    components: [hostStabilityComponent],
    processes: [...processSnapshots.values()].map((process) => structuredClone(process)),
    diagnostics: structuredClone(currentDiagnostics),
    revision: snapshotRevision,
  };
  };
  const emitSnapshot = (): ProjectSnapshot => {
    const currentSnapshot = snapshot();
    emit({ type: "snapshot", snapshot: currentSnapshot });
    return currentSnapshot;
  };
  const agentTasks: DashboardAgentTask[] = [];
  const launch = (request?: { prompt: string; componentPath?: string }): ComponentAgentLaunch => {
    const task: DashboardAgentTask = {
      id: `agent-task-${agentTasks.length + 1}`,
      command: "codex exec",
      prompt: request?.prompt ?? "Fixture agent request",
      componentPath: request?.componentPath ?? "harness.root",
      request: request?.prompt ?? "Fixture agent request",
      configPath: CONFIG_PATH,
      startedAt: new Date().toISOString(),
      dashboardChanged: false,
      process: { id: `agent-task-${agentTasks.length + 1}`, phase: "running", pid: null, exitCode: null, signal: null, logs: [] },
    };
    agentTasks.unshift(task);
    emit({ type: "agent-task", task });
    return { taskId: task.id, command: task.command, componentPath: task.componentPath, pid: null };
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getPersistedConfig() { return structuredClone(persistedConfig); },
    async getSnapshot() { return snapshot(); },
    async getAppSettings() { return structuredClone(settings); },
    async updateAppSettings(next) { settings = structuredClone(next); return structuredClone(settings); },
    async runComponentAgent(request: ComponentAgentRequest) { return launch(request); },
    async runComponentCreationAgent(request: ComponentCreationAgentRequest) { return launch(request); },
    async runDiagnosticsAgent() {
      return launch({
        prompt: "Fix dashboard configuration diagnostics.",
        componentPath: `${CONFIG_PATH}#diagnostics`,
      });
    },
    async getDashboardAgentTasks() { return structuredClone(agentTasks); },
    async getDashboardAgentDiff(taskId: string) {
      const task = agentTasks.find((item) => item.id === taskId);
      if (!task) throw new Error("That dashboard agent task is no longer available.");
      return `diff --git a/dash-bored/dash-bored.yaml b/dash-bored/dash-bored.yaml\nindex fixture..updated 100644\n--- a/dash-bored/dash-bored.yaml\n+++ b/dash-bored/dash-bored.yaml\n@@ -1,3 +1,3 @@\n-# Fixture dashboard\n+# Updated by ${task.request}\n`;
    },
    async setDiagnostics(next) {
      currentDiagnostics = structuredClone(next);
      emitSnapshot();
    },
    async stopDashboardAgentTask(taskId: string) {
      const task = agentTasks.find((item) => item.id === taskId);
      if (!task) throw new Error("That dashboard agent task is no longer available.");
      task.process = { ...task.process, phase: "exited", signal: "SIGTERM" };
      emit({ type: "agent-task", task: structuredClone(task) });
      return structuredClone(task);
    },
    async writeDashboardAgentTerminal(taskId: string, _input: string) {
      const task = agentTasks.find((item) => item.id === taskId);
      if (!task) throw new Error("That dashboard agent task is no longer available.");
      return structuredClone(task);
    },
    async resizeDashboardAgentTerminal(taskId: string, _cols: number, _rows: number) {
      const task = agentTasks.find((item) => item.id === taskId);
      if (!task) throw new Error("That dashboard agent task is no longer available.");
      return structuredClone(task);
    },
    async listProjects() { return [project(persistedConfig)]; },
    async getProjectOutline(_project: ProjectListItem): Promise<ProjectOutline> {
      return { ...project(persistedConfig), tree: resolveFixtureNode(persistedConfig.root), diagnostics: [] };
    },
    async chooseProject() { return emitSnapshot(); },
    async openProject(_project: ProjectTarget) { return emitSnapshot(); },
    async getProjectDeletionPreview(_project: ProjectListItem): Promise<ProjectDeletionPreview> {
      return { ...project(persistedConfig), filesDirectory: PROJECT_ROOT, filesExist: false, dependencies: [], analysisComplete: true, analysisIssues: [] };
    },
    async deleteProject(_project: ProjectListItem, _removeFiles: boolean) { return emitSnapshot(); },
    async trustProject() { return emitSnapshot(); },
    async revokeTrust() { return emitSnapshot(); },
    async reloadProject() { return emitSnapshot(); },
    async getDashboardConfigSource(_configPath?: string): Promise<DashboardConfigSource> {
      return {
        configPath: CONFIG_PATH,
        config: structuredClone(persistedConfig),
        configRevision: `ui-harness-${configRevision}`,
        componentCatalog: structuredClone(catalog),
      };
    },
    async validateDashboardDraft(config: DashboardConfig, _configPath?: string): Promise<DashboardDraftValidation> {
      return validateFixtureDraft(structuredClone(config));
    },
    async validateComponentProps(reference: string, props: Record<string, unknown>): Promise<ComponentPropsValidation> {
      const item = catalog.find((entry) => entry.reference === reference);
      if (!item?.manifest) return { ok: false, diagnostics: [fixtureDiagnostic("COMPONENT_UNAVAILABLE", "That component is not available.", reference)] };
      const validate = ajv.compile(item.manifest.propsSchema);
      return validate(props)
        ? { ok: true, diagnostics: [] }
        : { ok: false, diagnostics: (validate.errors ?? []).map((error) => fixtureSchemaDiagnostic(error, "props", "COMPONENT_PROPS_INVALID")) };
    },
    async saveDashboardConfig(config: DashboardConfig, expectedRevision: string, _configPath?: string) {
      if (expectedRevision !== `ui-harness-${configRevision}`) {
        throw new Error("DASHBOARD_CONFIG_CONFLICT: dash-bored.yaml changed after editing started. Cancel this draft and reopen edit mode before saving.");
      }
      const validation = validateFixtureDraft(structuredClone(config));
      if (!validation.ok) throw new Error(`DASHBOARD_CONFIG_INVALID: ${validation.diagnostics[0]?.message ?? "The dashboard draft is invalid."}`);
      persistedConfig = structuredClone(config);
      configRevision += 1;
      snapshotRevision += 1;
      return emitSnapshot();
    },
    async startProcess(nodeId: string): Promise<ProcessSnapshot> {
      const process: ProcessSnapshot = { id: nodeId, phase: nodeId === "setup-dashboard-with-agent" ? "running" : "idle", pid: null, exitCode: null, signal: null, logs: [] };
      processSnapshots.set(nodeId, process);
      emit({ type: "process", process });
      return process;
    },
    async openProcessTerminal(nodeId: string): Promise<ProcessSnapshot> {
      const process: ProcessSnapshot = { id: nodeId, phase: nodeId === "setup-dashboard-with-agent" ? "running" : "idle", pid: null, exitCode: null, signal: null, logs: [] };
      processSnapshots.set(nodeId, process);
      emit({ type: "process", process });
      return process;
    },
    async runProcessQuickAction(nodeId: string): Promise<ProcessSnapshot> {
      const process: ProcessSnapshot = { id: nodeId, phase: nodeId === "setup-dashboard-with-agent" ? "running" : "idle", pid: null, exitCode: null, signal: null, logs: [] };
      processSnapshots.set(nodeId, process);
      emit({ type: "process", process });
      return process;
    },
    async writeProcessTerminal(nodeId: string, _input: string): Promise<ProcessSnapshot> {
      const process = processSnapshots.get(nodeId)
        ?? { id: nodeId, phase: "idle" as const, pid: null, exitCode: null, signal: null, logs: [] };
      emit({ type: "process", process });
      return process;
    },
    async resizeProcessTerminal(nodeId: string, _cols: number, _rows: number): Promise<ProcessSnapshot> {
      const process = processSnapshots.get(nodeId)
        ?? { id: nodeId, phase: "idle" as const, pid: null, exitCode: null, signal: null, logs: [] };
      emit({ type: "process", process });
      return process;
    },
    async stopProcess(nodeId: string): Promise<ProcessSnapshot> {
      const process: ProcessSnapshot = nodeId === "setup-dashboard-with-agent"
        ? { id: nodeId, phase: "exited", pid: null, exitCode: null, signal: "SIGTERM", logs: [] }
        : { id: nodeId, phase: "idle", pid: null, exitCode: null, signal: null, logs: [] };
      processSnapshots.set(nodeId, process);
      emit({ type: "process", process });
      return process;
    },
    async readTextFile(request: FileReadRequest) {
      const content = files.get(request.path);
      if (content === undefined) throw new Error(`Fixture file not found: ${request.path}`);
      return content;
    },
    async writeTextFile(request: FileWriteRequest) {
      files.set(request.path, request.content);
    },
    async httpRequest(_request: HttpRequest): Promise<HttpResponsePayload> {
      return { status: 204, headers: {}, body: "" };
    },
    async runShell(_request: ShellRunRequest): Promise<ShellRunResult> {
      return { exitCode: 0, signal: null, stdout: "UI harness: no command was run.", stderr: "", timedOut: false };
    },
  };
}
