import { BUILTIN_THEME, projectThemeReference, type ThemeCatalogItem } from "../../shared/themes";
import { cloneDefaultAppSettings, DEFAULT_DASH_BORED_AGENT } from "../../shared/app-settings";
import Ajv, { type ErrorObject } from "ajv";
import { permissionsForComponent } from "../../shared/component-permissions";
import fixturePayload from "../../../.cottontail-tmp/core-fixture.json";
const coreFixture = fixturePayload as unknown as { manifests: ComponentManifest[]; components: CompiledLocalComponent[] };
import type {
  AppSettings,
  CompiledLocalComponent,
  ComponentAgentLaunch,
  ComponentAgentRequest,
  ComponentCatalogItem,
  ComponentManifest,
  ComponentChildEdge,
  ComponentChildLayout,
  ComponentPropsValidation,
  ComponentNode,
  Diagnostic,
  DashboardConfig,
  DashboardAgentTask,
  DashboardConfigSource,
  DashboardDraftValidation,
  NodePath,
  FileReadRequest,
  FileWriteRequest,
  HttpRequest,
  HttpResponsePayload,
  ProcessCommand,
  ProcessSnapshot,
  ProjectDeletionPreview,
  ProjectListItem,
  ProjectOutline,
  ProjectSnapshot,
  ProjectTarget,
  ResolvedComponentNode,
  ShellRunRequest,
  ShellRunResult,
} from "../../shared/contracts";
import { childEdges } from "../../shared/child-edges";
import type { DashboardHost, HostEvent } from "./rpc-client";
import type { UpdateState } from "../../shared/updates";
import { envEntries, parseEnv } from "../../shared/env";
import { componentPath, findResolvedNode } from "../../shared/component-agent";
import { builtinPromptTemplates, prepareAgentPrompt, promptTemplateSummary } from "../../shared/prompt-templates";

const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });

const PROJECT_ROOT = "/ui-harness/.dash-bored";
const CONFIG_PATH = "/ui-harness/.dash-bored/dash-bored.yaml";

function builtin(
  id: string,
  props: Record<string, unknown> = {},
  children?: ResolvedComponentNode["children"],
  reference?: string,
): ResolvedComponentNode {
  return {
    id,
    component: reference ?? (id === "harness-root"
      ? "./components/external/core/tabs"
      : id.startsWith("./") ? id : `./components/external/core/${id}`),
    props,
    ...(children ? { children } : {}),
    source: "external",
    sourceConfigPath: CONFIG_PATH,
    sourcePath: id === "harness-root" ? "root" : `harness.${id}`,
    sourceNodePath: [],
  };
}

const tree = builtin("harness-root", { label: "Visual verification fixture" }, [
  {
    metadata: { label: "Wide layout" },
    node: builtin("group", {}, {
      axis: "horizontal",
      ratio: 0.42,
      first: {
        node: builtin("renderer-proof-card", {
          title: "Renderer proof",
          description: "This is the real dashboard renderer with an inert fixture host.",
        }, {
          axis: "vertical",
          first: {
            node: builtin("renderer-proof-status", { label: "Fixture status", state: "healthy", detail: "Resize, switch tabs, open the sidebar, and inspect the component library." }, undefined, "./components/external/core/status"),
          },
          second: {
            node: builtin("renderer-proof-detail", { label: "Card composition", state: "healthy", detail: "Cards frame related component groups, not a single component." }, undefined, "./components/external/core/status"),
          },
        }, "./components/external/core/card"),
      },
      second: {
        axis: "vertical",
        first: {
          node: builtin("status", { label: "Renderer fixture", state: "healthy", detail: "Deterministic local snapshot; no desktop bridge." }),
        },
        second: {
          node: builtin("responsive-card", { title: "Responsive tile", description: "Nested tiled composition must remain legible at narrow widths." }, {
            axis: "vertical",
            first: {
              node: builtin("responsive-card-status", { label: "Responsive surface", state: "healthy", detail: "The tile remains valid with two related children." }, undefined, "./components/external/core/status"),
            },
            second: {
              node: builtin("responsive-card-detail", { label: "Responsive detail", state: "healthy", detail: "Inspect this card at the narrow viewport." }, undefined, "./components/external/core/status"),
            },
          }, "./components/external/core/card"),
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
      axis: "vertical",
      first: {
        node: builtin("renderer-proof-todos", {
          todos: [{ description: "Keep this surface mounted", done: false, tags: ["fixture"] }],
        }, undefined, "./components/external/core/todo-list"),
      },
      second: {
        axis: "vertical",
        first: {
          node: builtin("boundary-status", { label: "Renderer boundary", state: "healthy", detail: "Use the fixture for responsive review; desktop proof remains separate." }, undefined, "./components/external/core/status"),
        },
        second: {
          node: builtin("local-host-stability", {}, undefined, "./components/host-stability"),
        },
      },
    }, "./components/external/core/card"),
  },
]);

const initialConfig: DashboardConfig = {
  schemaVersion: 4,
  name: "Visual verification fixture",
  root: {
    id: tree.id,
    component: tree.component,
    children: tree.children,
  },
};

const catalog: ComponentCatalogItem[] = coreFixture.manifests.map((manifest) => ({ reference: `./components/external/core/${manifest.id.slice(5)}`, source: "external", available: true, diagnostics: [], manifest }));

catalog.push({
  reference: "./components/host-stability",
  source: "local",
  available: true,
  diagnostics: [],
  manifest: {
    schemaVersion: 3,
    apiVersion: "1.0.0",
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
      const [refreshes, setRefreshes] = useState(0);
      useEffect(() => host.actions.register({
        id: "refresh",
        label: "Refresh fixture component",
        run: () => setRefreshes((count) => count + 1),
      }), [host]);
      return createElement("div", {},
        createElement("p", { "data-testid": "local-host-effect-runs" }, "Host effects " + effectRuns),
        createElement("p", { "data-testid": "local-host-refreshes" }, "Fixture refreshes " + refreshes),
      );
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

/**
 * Browser-safe, conservative mirror of the DashboardHost draft boundary.
 * The main-process loader remains the source of truth for disk, lock, and
 * local-component validation; this fixture covers the config/catalog contract
 * which is meaningful in a browser-only test host.
 */
const FIXTURE_THEMES: ThemeCatalogItem[] = [BUILTIN_THEME,
  { reference: 'global:ocean', name: 'Ocean', manifest: { schemaVersion: 1, id: 'ocean', name: 'Ocean', light: { accent: '#285fbb' }, dark: { accent: '#8fb8ff' } } },
  { reference: './themes/plum', name: 'Plum', manifest: { schemaVersion: 1, id: 'plum', name: 'Plum', light: { accent: '#843ea3' }, dark: { accent: '#d19aff' } } },
];
const FIXTURE_APPLICATION_THEMES: ThemeCatalogItem[] = [
  FIXTURE_THEMES[0]!,
  FIXTURE_THEMES[1]!,
  {
    ...FIXTURE_THEMES[2]!,
    reference: projectThemeReference(CONFIG_PATH, './themes/plum'),
    displayReference: 'UI harness · ./themes/plum',
  },
];
function validateFixtureDraft(config: DashboardConfig): DashboardDraftValidation {
  const diagnostics: Diagnostic[] = [];
  if (config.schemaVersion !== 4) diagnostics.push(fixtureDiagnostic("CONFIG_SCHEMA_INVALID", "schemaVersion must be 4.", "schemaVersion"));
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
    for (const permission of permissionsForComponent(manifest, node.props ?? {})) permissions.add(permission);
    const validateProps = ajv.compile(manifest.propsSchema);
    if (!validateProps(node.props ?? {})) {
      diagnostics.push(...(validateProps.errors ?? []).map((error) => fixtureSchemaDiagnostic(error, `${path}.props`, "COMPONENT_PROPS_INVALID")));
    }
    const definition = manifest.children;
    const edges = childEdges(node.children);
    if (!definition && node.children) diagnostics.push(fixtureDiagnostic("COMPONENT_CHILDREN_UNSUPPORTED", `${manifest.name} does not accept children.`, `${path}.children`));
    if (definition && node.children && definition.presentation.type !== (Array.isArray(node.children) ? "managed" : "tiled")) {
      diagnostics.push(fixtureDiagnostic("COMPONENT_CHILD_PRESENTATION_INVALID", `${manifest.name} requires ${definition.presentation.type} children.`, `${path}.children`));
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
      if ("node" in layout) return visitEdge(layout, layoutPath);
      if (layout.ratio !== undefined && (layout.axis !== "horizontal" || !Number.isFinite(layout.ratio) || layout.ratio < 0.1 || layout.ratio > 0.9)) diagnostics.push(fixtureDiagnostic("COMPONENT_CHILD_RATIO_INVALID", "Tiled split ratios must be between 0.1 and 0.9.", `${layoutPath}.ratio`));
      if (definition?.presentation.type === "tiled" && definition.presentation.axes !== "both" && layout.axis !== definition.presentation.axes) {
        diagnostics.push(fixtureDiagnostic("COMPONENT_CHILD_AXIS_INVALID", `${manifest.name} only allows ${definition.presentation.axes} tiled splits.`, `${layoutPath}.axis`));
      }
      visitLayout(layout.first, `${layoutPath}.first`);
      visitLayout(layout.second, `${layoutPath}.second`);
    };
    if (Array.isArray(node.children)) node.children.forEach((edge, index) => visitEdge(edge, `${path}.children[${index}]`));
    if (node.children !== undefined && !Array.isArray(node.children)) visitLayout(node.children, `${path}.children`);
  };
  visit(config.root, "root", 0);
  const ok = diagnostics.length === 0;
  const references = new Set<string>();
  const collectReferences = (node: ComponentNode): void => {
    references.add(node.component);
    for (const edge of childEdges(node.children)) collectReferences(edge.node);
  };
  collectReferences(config.root);
  return {
    ok,
    diagnostics,
    requestedPermissions: [...permissions],
    tree: ok ? resolveFixtureNode(config.root) : null,
    components: ok ? [...coreFixture.components.filter(component => references.has(`./components/external/${component.componentId}`)), ...(references.has("./components/host-stability") ? [structuredClone(hostStabilityComponent)] : [])] : [],
    trusted: true,
  };
}

function resolveFixtureNode(
  node: ComponentNode,
  path = "root",
  sourceNodePath: NodePath = [],
): ResolvedComponentNode {
  const item = catalog.find((entry) => entry.reference === node.component);
  const resolved: ResolvedComponentNode = {
    id: node.id ?? path,
    component: node.component,
    props: structuredClone(node.props ?? {}),
    // External catalog sources are core-owned and ResolvedComponentNode does
    // not carry them yet; the fixture falls back without inventing a mapping.
    source: (item?.source === "external" ? undefined : item?.source) ?? "external",
    sourceConfigPath: CONFIG_PATH,
    sourcePath: path,
    sourceNodePath,
    ...(node.persistOnFocus === undefined ? {} : { persistOnFocus: node.persistOnFocus }),
    ...(item?.manifest ? { manifest: { ...structuredClone(item.manifest), permissions: permissionsForComponent(item.manifest, node.props ?? {}) } } : {}),
  };
  if (Array.isArray(node.children)) {
    resolved.children = node.children.map((edge, index) => ({
      node: resolveFixtureNode(edge.node, `${path}.children[${index}].node`, [
        ...sourceNodePath,
        { type: "managed", index },
      ]),
      ...(edge.metadata === undefined ? {} : { metadata: structuredClone(edge.metadata) }),
    }));
  } else if (node.children !== undefined) {
    const resolveLayout = (
      layout: ComponentChildLayout,
      layoutPath: string,
      branches: Array<"first" | "second">,
    ): ComponentChildLayout<ResolvedComponentNode> => "node" in layout
      ? {
          node: resolveFixtureNode(layout.node, `${layoutPath}.node`, [
            ...sourceNodePath,
            { type: "tiled", path: [...branches] },
          ]),
          ...(layout.metadata === undefined ? {} : { metadata: structuredClone(layout.metadata) }),
        }
      : {
          ...layout,
          first: resolveLayout(layout.first, `${layoutPath}.first`, [...branches, "first"]),
          second: resolveLayout(layout.second, `${layoutPath}.second`, [...branches, "second"]),
        };
    resolved.children = resolveLayout(node.children, `${path}.children`, []);
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
  finishAgentTask(taskId: string, validation: NonNullable<DashboardAgentTask["validation"]>, keepShell?: boolean): Promise<void>;
  appendAgentOutput(taskId: string, text: string): Promise<void>;
  getAgentTerminalResizes(): readonly { taskId: string; cols: number; rows: number }[];
  getAgentTerminalInputs(): readonly { taskId: string; input: string }[];
  /** Test-only record of package operations the UI asked the app to run. */
  getPackageOperations(): readonly unknown[];
  /** Test-only override for the Updates panel state; null restores the idle fixture. */
  setUpdateState(state: Partial<UpdateState> | null): void;
}

export function createUiHarnessHost(): UiHarnessHost {
  const listeners = new Set<(event: HostEvent) => void>();
  let settings: AppSettings = cloneDefaultAppSettings();
  let persistedConfig = structuredClone(initialConfig);
  let configRevision = 1;
  let snapshotRevision = 1;
  let currentDiagnostics: Diagnostic[] = [];
  let updateOverride: Partial<UpdateState> | null = null;
  const packageOperations: unknown[] = [];
  const processSnapshots = new Map<string, ProcessSnapshot>();
  const files = new Map<string, string>([
    ["README.md", "# Fixture document\n\nThis file is loaded by the Markdown component.\n"],
    [".dash-bored/.env", "DASH_BORED_AGENT=bundle-agent\n"],
  ]);
  const emit = (event: HostEvent): void => listeners.forEach((listener) => listener(event));
  const snapshot = (): ProjectSnapshot => {
  const tree = resolveFixtureNode(persistedConfig.root);
  const environmentByNode: NonNullable<ProjectSnapshot["environmentByNode"]> = {};
  const bundleAgent = envEntries(parseEnv(files.get(".dash-bored/.env") ?? ""))
    .find(({ entry }) => entry.key === "DASH_BORED_AGENT")?.entry.value;
  const visitEnvironment = (node: ResolvedComponentNode): void => {
    environmentByNode[node.id] = {
      values: [{
        key: "DASH_BORED_AGENT",
        value: settings.dashBoredAgent ?? bundleAgent ?? "",
        source: settings.dashBoredAgent !== null ? "app" : bundleAgent !== undefined ? "bundle" : "unset",
      }],
    };
    for (const edge of childEdges(node.children)) visitEnvironment(edge.node as ResolvedComponentNode);
  };
  visitEnvironment(tree);
  return {
    themeCatalog: structuredClone(FIXTURE_THEMES),
    environmentByNode,
    projectRoot: PROJECT_ROOT,
    configPath: CONFIG_PATH,
    dashboardName: persistedConfig.name,
    iconDataUrl: null,
    config: structuredClone(persistedConfig),
    configRevision: `ui-harness-${configRevision}`,
    componentCatalog: structuredClone(catalog),
    trusted: true,
    requestedPermissions: validateFixtureDraft(persistedConfig).requestedPermissions,
    tree,
    components: validateFixtureDraft(persistedConfig).components,
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
  const agentTerminalResizes: { taskId: string; cols: number; rows: number }[] = [];
  const agentTerminalInputs: { taskId: string; input: string }[] = [];
  const launch = (request?: { prompt: string; componentPath?: string }): ComponentAgentLaunch => {
    const task: DashboardAgentTask = {
      id: `agent-task-${agentTasks.length + 1}`,
      command: DEFAULT_DASH_BORED_AGENT,
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
    async finishAgentTask(taskId, validation, keepShell = false) {
      const task = agentTasks.find((candidate) => candidate.id === taskId);
      if (!task) throw new Error("Fixture agent task not found.");
      task.process = { ...task.process, phase: "exited", exitCode: 0,
        logs: [{ sequence: 1, stream: "stdout", text: "Created project workflows and checked the dashboard.\n" }] };
      if (keepShell) task.process = { ...task.process, phase: "running", exitCode: null, interactive: true,
        run: { phase: "exited", exitCode: 0, signal: null, startedAt: task.startedAt! } };
      task.validation = validation;
      emit({ type: "agent-task", task: structuredClone(task) });
    },
    async appendAgentOutput(taskId, text) {
      const task = agentTasks.find((candidate) => candidate.id === taskId);
      if (!task) throw new Error("Fixture agent task not found.");
      task.process.logs.push({ sequence: (task.process.logs.at(-1)?.sequence ?? 0) + 1, stream: "stdout", text });
      emit({ type: "agent-task", task: structuredClone(task) });
    },
    getAgentTerminalResizes() { return structuredClone(agentTerminalResizes); },
    getAgentTerminalInputs() { return structuredClone(agentTerminalInputs); },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getPersistedConfig() { return structuredClone(persistedConfig); },
    async getSnapshot() { return snapshot(); },
    async getThemes() { return structuredClone(FIXTURE_APPLICATION_THEMES); },
    async getUpdateState(): Promise<UpdateState> { return { currentVersion: "0.2.6", settings: { channel: "canary" as const, automaticChecks: true }, release: null, receipt: null, dashboards: [], phase: "idle" as const, message: "UI fixture: no network check performed.", ...structuredClone(updateOverride ?? {}) }; },
    async updateAction(action) {
      if (action.type === "settings") updateOverride = { ...updateOverride, settings: action.settings };
      if (action.type === "check") updateOverride = { ...updateOverride, checkedAt: new Date().toISOString() };
      return { ...await this.getUpdateState(), message: "UI fixture: update action received; no installation performed." };
    },
    setUpdateState(state) { updateOverride = state && structuredClone(state); },
    async getAppSettings() { return structuredClone(settings); },
    async updateAppSettings(next) { settings = structuredClone(next); emitSnapshot(); return structuredClone(settings); },
    async previewComponentAgent(request: ComponentAgentRequest) {
      // The fixture has no bundle templates; it renders the shipped defaults.
      const node = findResolvedNode(snapshot().tree!, request.nodeId);
      if (!node) throw new Error("That component is no longer present.");
      const { template, prompt } = prepareAgentPrompt({ templates: builtinPromptTemplates(), diagnostics: [] }, {
        ...(request.template ? { template: request.template } : {}),
        input: request.prompt,
        ...(request.vars ? { vars: request.vars } : {}),
        projectRoot: "/ui-harness",
        configPath: CONFIG_PATH,
        configDirectory: PROJECT_ROOT,
        component: { id: node.id, reference: node.component, path: componentPath(node), name: node.configName?.trim() || node.manifest?.name || node.component },
        allowEmptyInput: true,
      });
      return { template: promptTemplateSummary(template), prompt };
    },
    async launchAgent(request) {
      if (request.kind === "diagnostics") {
        return launch({ prompt: "Fix dashboard configuration diagnostics.", componentPath: `${CONFIG_PATH}#diagnostics` });
      }
      if (request.kind === "setup") {
        return launch({ prompt: "Set up the fixture dashboard.", componentPath: `${CONFIG_PATH}#setup-agent` });
      }
      return launch(request);
    },
    async repairInstalledTools() {
      currentDiagnostics = [];
      emitSnapshot();
      return { conflictsRemain: false };
    },
    async manageExternalComponent(operation) {
      packageOperations.push({ kind: "external", ...operation });
      emitSnapshot();
      return { message: `Ran external ${operation.op}.` };
    },
    async manageThemePackage(operation) {
      packageOperations.push({ kind: "theme", ...operation });
      return { message: `Ran theme ${operation.op}.` };
    },
    getPackageOperations() { return structuredClone(packageOperations); },
    async getDashboardAgentTasks() { return structuredClone(agentTasks); },
    async getDashboardAgentDiff(taskId: string) {
      const task = agentTasks.find((item) => item.id === taskId);
      if (!task) throw new Error("That dashboard agent task is no longer available.");
      return `diff --git a/.dash-bored/dash-bored.yaml b/.dash-bored/dash-bored.yaml\nindex fixture..updated 100644\n--- a/.dash-bored/dash-bored.yaml\n+++ b/.dash-bored/dash-bored.yaml\n@@ -1,3 +1,3 @@\n-# Fixture dashboard\n+# Updated by ${task.request}\n`;
    },
    async setDiagnostics(next) {
      currentDiagnostics = structuredClone(next);
      emitSnapshot();
    },
    async agentTaskCommand(taskId, command) {
      const task = agentTasks.find((item) => item.id === taskId);
      if (!task) throw new Error("That dashboard agent task is no longer available.");
      if (command.type === "stop") {
        task.process = { ...task.process, phase: "exited", signal: "SIGTERM" };
        emit({ type: "agent-task", task: structuredClone(task) });
      } else if (command.type === "write") {
        if (task.process.phase !== "running") throw new Error("That dashboard agent terminal is closed.");
        agentTerminalInputs.push({ taskId, input: command.input });
      } else {
        agentTerminalResizes.push({ taskId, cols: command.cols, rows: command.rows });
      }
      return structuredClone(task);
    },
    async listProjects() { return [project(persistedConfig)]; },
    async moveProject() { return [project(persistedConfig)]; },
    async getProjectOutline(_project: ProjectListItem): Promise<ProjectOutline> {
      return { ...project(persistedConfig), tree: resolveFixtureNode(persistedConfig.root), diagnostics: [] };
    },
    async chooseProject() { emitSnapshot(); return { opened: true }; },
    async openProject(_project: ProjectTarget) { emitSnapshot(); },
    async getProjectDeletionPreview(_project: ProjectListItem): Promise<ProjectDeletionPreview> {
      return { ...project(persistedConfig), filesDirectory: PROJECT_ROOT, filesExist: false, dependencies: [], analysisComplete: true, analysisIssues: [] };
    },
    async deleteProject(_project: ProjectListItem, _removeFiles: boolean) { emitSnapshot(); },
    async setTrust(_trusted: boolean) { emitSnapshot(); },
    async reloadProject() { emitSnapshot(); },
    async getDashboardConfigSource(_configPath?: string): Promise<DashboardConfigSource> {
      return {
        configPath: CONFIG_PATH,
        config: structuredClone(persistedConfig),
        configRevision: `ui-harness-${configRevision}`,
        componentCatalog: structuredClone(catalog),
      };
    },
    async validateDashboardDraft(config: DashboardConfig, _configPath?: string, _sourceNodeId?: string): Promise<DashboardDraftValidation> {
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
      emitSnapshot();
    },
    async processCommand(nodeId: string, command: ProcessCommand): Promise<ProcessSnapshot> {
      // Like the desktop host, only commands that change a process push it.
      if (command.type === "write" || command.type === "resize") {
        return processSnapshots.get(nodeId)
          ?? { id: nodeId, phase: "idle", pid: null, exitCode: null, signal: null, logs: [] };
      }
      const starter = nodeId === "setup-dashboard-with-agent";
      const process: ProcessSnapshot = command.type === "stop"
        ? starter
          ? { id: nodeId, phase: "exited", pid: null, exitCode: null, signal: "SIGTERM", logs: [] }
          : { id: nodeId, phase: "idle", pid: null, exitCode: null, signal: null, logs: [] }
        : { id: nodeId, phase: starter ? "running" : "idle", pid: null, exitCode: null, signal: null, logs: [] };
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
