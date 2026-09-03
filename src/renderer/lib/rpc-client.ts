import { Electroview } from "electrobun/view";
import type {
  AppSettings,
  ComponentAgentLaunch,
  ComponentAgentRequest,
  ComponentCreationAgentRequest,
  DashboardConfig,
  DashboardAgentTask,
  DashboardConfigSource,
  DashboardDraftValidation,
  ComponentPropsValidation,
  FileReadRequest,
  FileWriteRequest,
  HttpRequest,
  HttpResponsePayload,
  ProcessSnapshot,
  ProjectOutline,
  ProjectDeletionPreview,
  ProjectListItem,
  ProjectTarget,
  ProjectSnapshot,
  ShellRunRequest,
  ShellRunResult,
} from "../../shared/contracts";
import type { DashboardRPC } from "../../shared/rpc";
import { createUiHarnessHost } from "./ui-harness-host";

export type HostEvent =
  | { type: "snapshot"; snapshot: ProjectSnapshot }
  | { type: "process"; process: ProcessSnapshot }
  | { type: "agent-task"; task: DashboardAgentTask }
  | { type: "open-command-palette" };

type HostEventListener = (event: HostEvent) => void;

export interface DashboardHost {
  subscribe(listener: HostEventListener): () => void;
  getSnapshot(): Promise<ProjectSnapshot>;
  getAppSettings(): Promise<AppSettings>;
  updateAppSettings(settings: AppSettings): Promise<AppSettings>;
  runComponentAgent(request: ComponentAgentRequest): Promise<ComponentAgentLaunch>;
  runComponentCreationAgent(request: ComponentCreationAgentRequest): Promise<ComponentAgentLaunch>;
  runDiagnosticsAgent(): Promise<ComponentAgentLaunch>;
  getDashboardAgentTasks(): Promise<DashboardAgentTask[]>;
  getDashboardAgentDiff(taskId: string): Promise<string>;
  stopDashboardAgentTask(taskId: string): Promise<DashboardAgentTask>;
  writeDashboardAgentTerminal(taskId: string, input: string): Promise<DashboardAgentTask>;
  resizeDashboardAgentTerminal(taskId: string, cols: number, rows: number): Promise<DashboardAgentTask>;
  listProjects(): Promise<ProjectListItem[]>;
  getProjectOutline(project: ProjectListItem): Promise<ProjectOutline>;
  chooseProject(): Promise<ProjectSnapshot>;
  openProject(project: ProjectTarget): Promise<ProjectSnapshot>;
  getProjectDeletionPreview(project: ProjectListItem): Promise<ProjectDeletionPreview>;
  deleteProject(project: ProjectListItem, removeFiles: boolean): Promise<ProjectSnapshot>;
  trustProject(): Promise<ProjectSnapshot>;
  revokeTrust(): Promise<ProjectSnapshot>;
  reloadProject(): Promise<ProjectSnapshot>;
  getDashboardConfigSource(configPath?: string): Promise<DashboardConfigSource>;
  validateDashboardDraft(config: DashboardConfig, configPath?: string): Promise<DashboardDraftValidation>;
  validateComponentProps(reference: string, props: Record<string, unknown>): Promise<ComponentPropsValidation>;
  saveDashboardConfig(config: DashboardConfig, expectedConfigRevision: string, configPath?: string): Promise<ProjectSnapshot>;
  startProcess(nodeId: string): Promise<ProcessSnapshot>;
  openProcessTerminal(nodeId: string): Promise<ProcessSnapshot>;
  runProcessQuickAction(nodeId: string): Promise<ProcessSnapshot>;
  writeProcessTerminal(nodeId: string, input: string): Promise<ProcessSnapshot>;
  resizeProcessTerminal(nodeId: string, cols: number, rows: number): Promise<ProcessSnapshot>;
  stopProcess(nodeId: string): Promise<ProcessSnapshot>;
  readTextFile(request: FileReadRequest): Promise<string>;
  writeTextFile(request: FileWriteRequest): Promise<void>;
  httpRequest(request: HttpRequest): Promise<HttpResponsePayload>;
  runShell(request: ShellRunRequest): Promise<ShellRunResult>;
}

const listeners = new Set<HostEventListener>();

function emit(event: HostEvent): void {
  for (const listener of listeners) {
    listener(event);
  }
}

const rpc = Electroview.defineRPC<DashboardRPC>({
  // Capability calls may legitimately run for 30 seconds; leave transport and
  // process-cleanup headroom beyond that backend limit.
  maxRequestTime: 65_000,
  handlers: {
    messages: {
      snapshot: (snapshot) => emit({ type: "snapshot", snapshot }),
      process: (process) => emit({ type: "process", process }),
      agentTask: (task) => emit({ type: "agent-task", task }),
      openCommandPalette: () => emit({ type: "open-command-palette" }),
    },
  },
});

let electroview: Electroview<typeof rpc> | null = null;

function ensureTransport(): void {
  if (electroview) return;

  const hostWindow = window as Window & { __electrobun?: unknown };
  if (!hostWindow.__electrobun) {
    throw new Error(
      "The Electrobun host bridge is unavailable. Open dash-bored through the desktop application.",
    );
  }

  electroview = new Electroview({ rpc });
}

async function snapshotRequest(
  request: () => Promise<ProjectSnapshot>,
): Promise<ProjectSnapshot> {
  ensureTransport();
  const snapshot = await request();
  emit({ type: "snapshot", snapshot });
  return snapshot;
}

const liveHost: DashboardHost = {
  subscribe(listener: HostEventListener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  getSnapshot(): Promise<ProjectSnapshot> {
    return snapshotRequest(() => rpc.request.getSnapshot({}));
  },

  async getAppSettings(): Promise<AppSettings> {
    ensureTransport();
    return await rpc.request.getAppSettings({});
  },

  async updateAppSettings(settings: AppSettings): Promise<AppSettings> {
    ensureTransport();
    return await rpc.request.updateAppSettings(settings);
  },

  async runComponentAgent(request: ComponentAgentRequest): Promise<ComponentAgentLaunch> {
    ensureTransport();
    return await rpc.request.runComponentAgent(request);
  },

  async runComponentCreationAgent(
    request: ComponentCreationAgentRequest,
  ): Promise<ComponentAgentLaunch> {
    ensureTransport();
    return await rpc.request.runComponentCreationAgent(request);
  },

  async runDiagnosticsAgent(): Promise<ComponentAgentLaunch> {
    ensureTransport();
    return await rpc.request.runDiagnosticsAgent({});
  },

  async getDashboardAgentTasks(): Promise<DashboardAgentTask[]> {
    ensureTransport();
    return await rpc.request.getDashboardAgentTasks({});
  },

  async getDashboardAgentDiff(taskId: string): Promise<string> {
    ensureTransport();
    return await rpc.request.getDashboardAgentDiff({ taskId });
  },

  async stopDashboardAgentTask(taskId: string): Promise<DashboardAgentTask> {
    ensureTransport();
    return await rpc.request.stopDashboardAgentTask({ taskId });
  },

  async writeDashboardAgentTerminal(taskId: string, input: string): Promise<DashboardAgentTask> {
    ensureTransport();
    return await rpc.request.writeDashboardAgentTerminal({ taskId, input });
  },

  async resizeDashboardAgentTerminal(taskId: string, cols: number, rows: number): Promise<DashboardAgentTask> {
    ensureTransport();
    return await rpc.request.resizeDashboardAgentTerminal({ taskId, cols, rows });
  },

  async listProjects(): Promise<ProjectListItem[]> {
    ensureTransport();
    return await rpc.request.listProjects({});
  },

  async getProjectOutline(project: ProjectListItem): Promise<ProjectOutline> {
    ensureTransport();
    return await rpc.request.getProjectOutline({
      projectRoot: project.projectRoot,
      configPath: project.configPath,
    });
  },

  chooseProject(): Promise<ProjectSnapshot> {
    return snapshotRequest(() =>
      rpc.request.chooseProject({}, { maxRequestTime: Infinity }),
    );
  },

  openProject(project: ProjectTarget): Promise<ProjectSnapshot> {
    return snapshotRequest(() => rpc.request.openProject({
      projectRoot: project.projectRoot,
      configPath: project.configPath,
    }));
  },

  async getProjectDeletionPreview(project: ProjectListItem): Promise<ProjectDeletionPreview> {
    ensureTransport();
    return await rpc.request.getProjectDeletionPreview({
      projectRoot: project.projectRoot,
      configPath: project.configPath,
    });
  },

  deleteProject(project: ProjectListItem, removeFiles: boolean): Promise<ProjectSnapshot> {
    return snapshotRequest(() => rpc.request.deleteProject({
      projectRoot: project.projectRoot,
      configPath: project.configPath,
      removeFiles,
    }));
  },

  trustProject(): Promise<ProjectSnapshot> {
    return snapshotRequest(() => rpc.request.trustProject({}));
  },

  revokeTrust(): Promise<ProjectSnapshot> {
    return snapshotRequest(() => rpc.request.revokeTrust({}));
  },

  reloadProject(): Promise<ProjectSnapshot> {
    return snapshotRequest(() => rpc.request.reloadProject({}));
  },

  async getDashboardConfigSource(configPath?: string): Promise<DashboardConfigSource> {
    ensureTransport();
    return await rpc.request.getDashboardConfigSource({ configPath });
  },

  async validateDashboardDraft(
    config: DashboardConfig,
    configPath?: string,
  ): Promise<DashboardDraftValidation> {
    ensureTransport();
    return await rpc.request.validateDashboardDraft({ config, configPath });
  },

  async validateComponentProps(
    reference: string,
    props: Record<string, unknown>,
  ): Promise<ComponentPropsValidation> {
    ensureTransport();
    return await rpc.request.validateComponentProps({ reference, props });
  },

  saveDashboardConfig(
    config: DashboardConfig,
    expectedConfigRevision: string,
    configPath?: string,
  ): Promise<ProjectSnapshot> {
    return snapshotRequest(() =>
      rpc.request.saveDashboardConfig({ config, expectedConfigRevision, configPath }),
    );
  },

  async startProcess(nodeId: string): Promise<ProcessSnapshot> {
    ensureTransport();
    const process = await rpc.request.startProcess({ nodeId });
    emit({ type: "process", process });
    return process;
  },

  async openProcessTerminal(nodeId: string): Promise<ProcessSnapshot> {
    ensureTransport();
    const process = await rpc.request.openProcessTerminal({ nodeId });
    emit({ type: "process", process });
    return process;
  },

  async runProcessQuickAction(nodeId: string): Promise<ProcessSnapshot> {
    ensureTransport();
    const process = await rpc.request.runProcessQuickAction({ nodeId });
    emit({ type: "process", process });
    return process;
  },

  async writeProcessTerminal(nodeId: string, input: string): Promise<ProcessSnapshot> {
    ensureTransport();
    const process = await rpc.request.writeProcessTerminal({ nodeId, input });
    emit({ type: "process", process });
    return process;
  },

  async resizeProcessTerminal(nodeId: string, cols: number, rows: number): Promise<ProcessSnapshot> {
    ensureTransport();
    const process = await rpc.request.resizeProcessTerminal({ nodeId, cols, rows });
    emit({ type: "process", process });
    return process;
  },

  async stopProcess(nodeId: string): Promise<ProcessSnapshot> {
    ensureTransport();
    const process = await rpc.request.stopProcess({ nodeId });
    emit({ type: "process", process });
    return process;
  },

  readTextFile(request: FileReadRequest): Promise<string> {
    ensureTransport();
    return rpc.request.readTextFile(request);
  },

  writeTextFile(request: FileWriteRequest): Promise<void> {
    ensureTransport();
    return rpc.request.writeTextFile(request);
  },

  httpRequest(request: HttpRequest): Promise<HttpResponsePayload> {
    ensureTransport();
    return rpc.request.httpRequest(request);
  },

  runShell(request: ShellRunRequest): Promise<ShellRunResult> {
    ensureTransport();
    return rpc.request.runShell(request);
  },
};

declare global {
  interface Window {
    __DASH_BORED_UI_HARNESS__?: boolean;
    /** Present only on ui-harness.html so browser interaction tests can inspect host state. */
    __DASH_BORED_UI_HARNESS_HOST__?: ReturnType<typeof createUiHarnessHost>;
  }
}

/**
 * The visual fixture runs the actual renderer with deterministic, inert data.
 * It is deliberately selected only by ui-harness.html; production renderer
 * pages keep the Electrobun transport guard above.
 */
const uiHarnessHost = window.__DASH_BORED_UI_HARNESS__ ? createUiHarnessHost() : null;
if (uiHarnessHost) window.__DASH_BORED_UI_HARNESS_HOST__ = uiHarnessHost;

export const host: DashboardHost = uiHarnessHost ?? liveHost;
