import type { ReactNode } from "react";

export const CONFIG_DIRECTORY = "dash-bored";
export const CONFIG_FILE = "dash-bored.yaml";
export const LOCK_FILE = "dash-bored-lock.yaml";
export const COMPONENTS_DIRECTORY = "components";

export type Permission =
  | "filesystem:read"
  | "filesystem:write"
  | "network:http"
  | "process:execute";

export interface ComponentNode {
  id?: string;
  component: string;
  props?: Record<string, unknown>;
  slots?: Record<string, ComponentNode | ComponentNode[]>;
}

export interface DashboardConfig {
  schemaVersion: 1;
  name: string;
  root: ComponentNode;
}

export interface DashboardLock {
  lockfileVersion: 1;
  components: Record<string, never>;
}

export interface SlotDefinition {
  required?: boolean;
  multiple?: boolean;
}

export interface ComponentManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  description: string;
  entry: string;
  propsSchema: Record<string, unknown>;
  slots?: Record<string, SlotDefinition>;
  permissions?: Permission[];
}

export interface ComponentCatalogItem {
  reference: string;
  source: "builtin" | "local" | "config";
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
  slots: Record<string, ResolvedComponentNode[]>;
  source: "builtin" | "local" | "config";
  manifest?: ComponentManifest;
  /** Canonical source path for a standalone config-link component. */
  configPath?: string;
  configName?: string;
  configError?: string;
  /** YAML file that owns this node and must receive structural edits. */
  sourceConfigPath?: string;
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
  dashboardName: string | null;
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

export interface ProjectListItem {
  projectRoot: string;
  dashboardName: string | null;
}

export interface ProjectOutline {
  projectRoot: string;
  dashboardName: string | null;
  tree: ResolvedComponentNode | null;
  diagnostics: Diagnostic[];
}

export interface ProjectDeletionDependency {
  projectRoot: string;
  dashboardName: string | null;
  configPaths: string[];
}

export interface ProjectDeletionPreview {
  projectRoot: string;
  dashboardName: string | null;
  filesDirectory: string;
  filesExist: boolean;
  dependencies: ProjectDeletionDependency[];
  analysisComplete: boolean;
  analysisIssues: string[];
}

export interface DeleteProjectRequest {
  projectRoot: string;
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

export interface LocalComponentRenderProps<Props = Record<string, unknown>> {
  props: Props;
  slots: Record<string, ReactNode[]>;
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
  dashboard: { reload(): Promise<void> };
  actions: { register(action: ComponentAction): () => void };
  filesystem?: {
    readText(path: string): Promise<string>;
    writeText?(path: string, content: string): Promise<void>;
  };
  http?: { request(request: Omit<HttpRequest, "nodeId">): Promise<HttpResponsePayload> };
  shell?: { run(request: Omit<ShellRunRequest, "nodeId">): Promise<ShellRunResult> };
}
