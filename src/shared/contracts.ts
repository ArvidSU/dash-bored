import type { ReactNode } from "react";

export const CONFIG_DIRECTORY = "dash-bored";
export const CONFIG_FILE = "dash-bored.yaml";
export const LOCK_FILE = "dash-bored-lock.yaml";
export const COMPONENTS_DIRECTORY = "components";

export type Permission =
  | "filesystem:read"
  | "filesystem:write"
  | "network:http"
  | "process:execute"
  | "process:observe"
  | "webview:embed";

export interface ComponentNode {
  id?: string;
  component: string;
  props?: Record<string, unknown>;
  children?: ComponentChildren;
}

export interface ComponentChildEdge<Node = ComponentNode> {
  node: Node;
  metadata?: Record<string, unknown>;
}

export type ComponentChildLayout<Node = ComponentNode> =
  | {
      type: "child";
      child: ComponentChildEdge<Node>;
    }
  | {
      type: "split";
      axis: "horizontal" | "vertical";
      /** Fraction of available space assigned to the first branch. */
      ratio: number;
      first: ComponentChildLayout<Node>;
      second: ComponentChildLayout<Node>;
    };

export type ComponentChildren<Node = ComponentNode> =
  | {
      type: "tiled";
      layout: ComponentChildLayout<Node>;
    }
  | {
      type: "managed";
      items: ComponentChildEdge<Node>[];
    };

export interface DashboardConfig {
  schemaVersion: 2;
  name: string;
  /** Optional image path or HTTP(S) URL shown for this dashboard in the sidebar. */
  icon?: string;
  root: ComponentNode;
}

export interface ExternalComponentLockEntry {
  /** Clone URL or local path the submodule was added from. */
  url: string;
  /** Exact pinned commit SHA checked out for this component. */
  commit: string;
  /** Bundle-relative component path: "components/external/<name>". */
  path: string;
}

export interface DashboardLock {
  lockfileVersion: 1;
  components: Record<string, ExternalComponentLockEntry>;
}

export type ComponentChildPresentation =
  | {
      type: "tiled";
      axes: "horizontal" | "vertical" | "both";
    }
  | {
      type: "managed";
    };

export interface ComponentChildrenDefinition {
  min: number;
  max?: number;
  presentation: ComponentChildPresentation;
  metadataSchema?: Record<string, unknown>;
}

export interface ComponentProcessResourceDefinition {
  /** Prop containing the supervised command string. */
  commandProp: string;
  /** Run the command inside a persistent PTY-backed shell. */
  interactive?: boolean;
  /** Optional prop containing a project-relative working directory. */
  cwdProp?: string;
  /** Optional prop containing string-valued environment variables. */
  envProp?: string;
}

export interface ComponentResourceDefinitions {
  process?: ComponentProcessResourceDefinition;
}

export interface ComponentReferenceDefinition {
  resource: "process";
}

export interface ComponentManifest {
  schemaVersion: 2;
  id: string;
  name: string;
  description: string;
  entry: string;
  /** Whether this node owns a resizable surface or follows descendant layout. */
  renderMode?: "surface" | "layout";
  propsSchema: Record<string, unknown>;
  children?: ComponentChildrenDefinition;
  /** App-owned resources configured declaratively from component props. */
  resources?: ComponentResourceDefinitions;
  /** Props that reference resources supplied by other component nodes. */
  references?: Record<string, ComponentReferenceDefinition>;
  permissions?: Permission[];
}

export interface ComponentCatalogItem {
  reference: string;
  source: "builtin" | "local" | "config" | "external";
  available: boolean;
  manifest: ComponentManifest | null;
  diagnostics: Diagnostic[];
}

export type DiagnosticSeverity = "error" | "warning";

export interface Diagnostic {
  severity: DiagnosticSeverity;
  code: string;
  message: string;
  file?: string;
  path?: string;
  line?: number;
  column?: number;
}

export interface ResolvedComponentNode {
  id: string;
  component: string;
  props: Record<string, unknown>;
  children?: ComponentChildren<ResolvedComponentNode>;
  source: "builtin" | "local" | "config";
  manifest?: ComponentManifest;
  /** Canonical source path for a standalone config-link component. */
  configPath?: string;
  configName?: string;
  configError?: string;
  /** YAML file that owns this node and must receive structural edits. */
  sourceConfigPath?: string;
  /** Stable YAML-style path to this node within its owning config. */
  sourcePath?: string;
}

export interface AppSettings {
  /** App-wide CLI command used for natural-language dashboard changes. */
  dashBoredAgent: string;
  /** Action ids promoted ahead of other matching command-palette results. */
  favoriteActionIds: string[];
  /** App-local keyboard shortcut that opens the command palette. */
  commandPaletteShortcut: string | null;
  /** App-local keyboard shortcuts keyed by stable action id. */
  actionShortcuts: Record<string, string>;
}

export interface ComponentAgentRequest {
  nodeId: string;
  prompt: string;
}

/** Starts the generated dashboard's one built-in setup request. */

export type ComponentChildLocator =
  | { type: "managed"; index: number }
  | { type: "tiled"; path: Array<"first" | "second"> };

export type ComponentChildPlacement =
  | {
      type: "managed";
      index: number;
      metadata?: Record<string, unknown>;
    }
  | {
      type: "tiled";
      path: Array<"first" | "second">;
      axis: "horizontal" | "vertical";
      position: "first" | "second";
      ratio?: number;
      metadata?: Record<string, unknown>;
    };

export interface DashboardInsertionTarget {
  parentPath: ComponentChildLocator[];
  placement: ComponentChildPlacement;
}

export interface ComponentCreationAgentRequest {
  configPath: string;
  target: DashboardInsertionTarget;
  prompt: string;
}

export interface ComponentAgentLaunch {
  taskId: string;
  command: string;
  componentPath: string;
  pid: number | null;
}

/** A dashboard-only invocation of the user's configured CLI agent. */
export interface DashboardAgentTask {
  id: string;
  command: string;
  /** Fully contextualized prompt passed as the configured command's argument. */
  prompt: string;
  componentPath: string;
  request: string;
  configPath: string;
  startedAt?: string;
  /** The dashboard changed while this task was running; it is not a success claim. */
  dashboardChanged: boolean;
  process: ProcessSnapshot;
}

export interface CompiledLocalComponent {
  componentId: string;
  revision: string;
  javascript: string;
  css: string;
}

export type ProcessPhase = "idle" | "running" | "stopping" | "exited" | "failed";

export interface ProcessLogEntry {
  sequence: number;
  stream: "stdout" | "stderr" | "system";
  text: string;
}

export interface ProcessSnapshot {
  id: string;
  phase: ProcessPhase;
  pid: number | null;
  exitCode: number | null;
  signal: string | null;
  logs: ProcessLogEntry[];
}

export interface ProjectSnapshot {
  projectRoot: string | null;
  /** Canonical YAML currently rendered, including standalone named bundles. */
  configPath?: string | null;
  dashboardName: string | null;
  /** Resolved data URL for the configured dashboard icon, or null when unavailable. */
  iconDataUrl: string | null;
  config: DashboardConfig | null;
  configRevision: string | null;
  componentCatalog: ComponentCatalogItem[];
  trusted: boolean;
  requestedPermissions: Permission[];
  tree: ResolvedComponentNode | null;
  components: CompiledLocalComponent[];
  processes: ProcessSnapshot[];
  diagnostics: Diagnostic[];
  revision: number;
}

export interface DashboardDraftValidation {
  ok: boolean;
  diagnostics: Diagnostic[];
  requestedPermissions: Permission[];
}

export interface DashboardConfigSource {
  configPath: string;
  config: DashboardConfig;
  configRevision: string;
  componentCatalog: ComponentCatalogItem[];
}

export interface ComponentPropsValidation {
  ok: boolean;
  diagnostics: Diagnostic[];
}

export interface SaveDashboardConfigRequest {
  config: DashboardConfig;
  expectedConfigRevision: string;
  configPath?: string;
}

export interface ProjectTarget {
  projectRoot: string;
  configPath: string;
}

export interface ProjectListItem extends ProjectTarget {
  dashboardName: string | null;
  /** Cached resolved data URL for the dashboard's configured sidebar icon. */
  iconDataUrl?: string | null;
}

export interface ProjectOutline extends ProjectTarget {
  dashboardName: string | null;
  tree: ResolvedComponentNode | null;
  diagnostics: Diagnostic[];
}

export interface ProjectDeletionDependency {
  projectRoot: string;
  dashboardName: string | null;
  configPaths: string[];
}

export interface ProjectDeletionPreview extends ProjectTarget {
  dashboardName: string | null;
  filesDirectory: string;
  filesExist: boolean;
  dependencies: ProjectDeletionDependency[];
  analysisComplete: boolean;
  analysisIssues: string[];
}

export interface DeleteProjectRequest {
  projectRoot: string;
  configPath: string;
  removeFiles: boolean;
}

export interface InspectResult {
  ok: boolean;
  projectRoot: string;
  config: DashboardConfig | null;
  lock: DashboardLock | null;
  tree: ResolvedComponentNode | null;
  componentCatalog: ComponentCatalogItem[];
  components: ComponentManifest[];
  permissions: Permission[];
  diagnostics: Diagnostic[];
}

export interface HostRequestContext {
  /**
   * Renderer-supplied node identity used for permission lookup. Local
   * components share one trusted renderer, so this is API shaping and
   * defense-in-depth rather than authentication between components.
   */
  nodeId: string;
}

export interface FileReadRequest extends HostRequestContext {
  path: string;
}

export interface FileWriteRequest extends HostRequestContext {
  path: string;
  content: string;
}

export interface ImageReadRequest extends HostRequestContext {
  source: string;
  timeoutMs?: number;
}

export interface ImageReadPayload {
  dataUrl: string;
  mediaType: string;
}

export interface HttpRequest extends HostRequestContext {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export interface HttpResponsePayload {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface ShellRunRequest extends HostRequestContext {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface ShellRunResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ComponentChildHandle {
  id: string;
  reference: string;
  displayName: string;
  metadata: Record<string, unknown>;
  render(options?: { visible?: boolean }): ReactNode;
}

export type ComponentRenderedChildren =
  | { type: "tiled"; surface: ReactNode }
  | { type: "managed"; items: ComponentChildHandle[] };

export interface LocalComponentRenderProps<Props = Record<string, unknown>> {
  props: Props;
  children?: ComponentRenderedChildren;
  host: LocalComponentHost;
}

export interface ComponentActionConfirmation {
  title: string;
  message?: string;
  confirmLabel?: string;
}

export interface ComponentAction {
  id: string;
  label: string;
  description?: string;
  keywords?: string[];
  enabled?: boolean;
  disabledReason?: string;
  confirmation?: ComponentActionConfirmation;
  run(): void | Promise<void>;
}

export interface LocalComponentHost {
  dashboard: {
    reload(): Promise<void>;
    /** Replaces this component's props in the owning dashboard draft. */
    updateProps(props: Record<string, unknown>): Promise<void>;
  };
  actions: { register(action: ComponentAction): () => void };
  filesystem?: {
    readText(path: string): Promise<string>;
    writeText?(path: string, content: string): Promise<void>;
  };
  http?: { request(request: Omit<HttpRequest, "nodeId">): Promise<HttpResponsePayload> };
  shell?: { run(request: Omit<ShellRunRequest, "nodeId">): Promise<ShellRunResult> };
  processes?: {
    /** Allows a host-owned process surface to attach to an existing process without rerunning it. */
    attachOnly?: boolean;
    get(nodeId?: string): ProcessSnapshot | undefined;
    start?(): Promise<ProcessSnapshot>;
    /** Starts the shell without running its configured quick action. */
    open?(): Promise<ProcessSnapshot>;
    /** Runs the configured quick action in the existing shell. */
    runQuickAction?(): Promise<ProcessSnapshot>;
    write?(input: string): Promise<ProcessSnapshot>;
    resize?(cols: number, rows: number): Promise<ProcessSnapshot>;
    stop?(): Promise<ProcessSnapshot>;
  };
  webview?: {
    render(request: { url: string; title?: string }): ReactNode;
  };
}
