import { Electroview } from "electrobun/view";
import { whenIdle } from "./activity";
import type {
  AgentLaunchRequest,
  AgentTaskCommand,
  AppSettings,
  ComponentAgentLaunch,
  ComponentAgentPreview,
  ComponentAgentRequest,
  DashboardConfig,
  DashboardAgentTask,
  DashboardConfigSource,
  DashboardDraftValidation,
  ComponentPropsValidation,
  FileReadRequest,
  FileWriteRequest,
  HttpRequest,
  HttpResponsePayload,
  ProcessCommand,
  ProcessSnapshot,
  ProjectOutline,
  ProjectDeletionPreview,
  ProjectListItem,
  ProjectTarget,
  ProjectSnapshot,
  ShellRunRequest,
  ShellRunResult,
  ExternalComponentOperation,
  PackageOperationResult,
  ThemePackageOperation,
} from "../../shared/contracts";
import type {
  AgentActionDescriptor,
  AgentNodeMeasurement,
  AgentNodeText,
  AgentRunActionRequest,
  AgentRunActionResult,
  AgentViewState,
} from "../../shared/agent-control";
import type { DashboardRPC } from "../../shared/rpc";
import type { UiHarnessHost } from "./ui-harness-host";

export type HostEvent =
  | { type: "themes"; catalog: import("../../shared/themes").ThemeCatalogItem[] }
  | { type: "snapshot"; snapshot: ProjectSnapshot }
  | { type: "process"; process: ProcessSnapshot }
  | { type: "agent-task"; task: DashboardAgentTask }
  | { type: "open-command-palette" };

type HostEventListener = (event: HostEvent) => void;

export interface DashboardHost {
  subscribe(listener: HostEventListener): () => void;
  getSnapshot(): Promise<ProjectSnapshot>;
  getThemes(): Promise<import("../../shared/themes").ThemeCatalogItem[]>;
  getUpdateState(): Promise<import("../../shared/updates").UpdateState>;
  updateAction(action: import("../../shared/updates").UpdateAction): Promise<import("../../shared/updates").UpdateState>;
  getAppSettings(): Promise<AppSettings>;
  updateAppSettings(settings: AppSettings): Promise<AppSettings>;
  previewComponentAgent(request: ComponentAgentRequest): Promise<ComponentAgentPreview>;
  launchAgent(request: AgentLaunchRequest): Promise<ComponentAgentLaunch>;
  repairInstalledTools(): Promise<{ conflictsRemain: boolean }>;
  manageExternalComponent(operation: ExternalComponentOperation): Promise<PackageOperationResult>;
  manageThemePackage(operation: ThemePackageOperation): Promise<PackageOperationResult>;
  getDashboardAgentTasks(): Promise<DashboardAgentTask[]>;
  getDashboardAgentDiff(taskId: string): Promise<string>;
  agentTaskCommand(taskId: string, command: AgentTaskCommand): Promise<DashboardAgentTask>;
  listProjects(): Promise<ProjectListItem[]>;
  moveProject(configPath: string, targetConfigPath: string, before: boolean): Promise<ProjectListItem[]>;
  getProjectOutline(project: ProjectListItem): Promise<ProjectOutline>;
  /** Opens the folder picker; `opened` is false when the user cancelled. */
  chooseProject(): Promise<{ opened: boolean }>;
  openProject(project: ProjectTarget): Promise<void>;
  getProjectDeletionPreview(project: ProjectListItem): Promise<ProjectDeletionPreview>;
  deleteProject(project: ProjectListItem, removeFiles: boolean): Promise<void>;
  setTrust(trusted: boolean): Promise<void>;
  reloadProject(): Promise<void>;
  getDashboardConfigSource(configPath?: string): Promise<DashboardConfigSource>;
  validateDashboardDraft(config: DashboardConfig, configPath?: string, sourceNodeId?: string): Promise<DashboardDraftValidation>;
  validateComponentProps(reference: string, props: Record<string, unknown>): Promise<ComponentPropsValidation>;
  saveDashboardConfig(config: DashboardConfig, expectedConfigRevision: string, configPath?: string): Promise<void>;
  /** The process after the command; the store learns about it from the host's push. */
  processCommand(nodeId: string, command: ProcessCommand): Promise<ProcessSnapshot>;
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

/** Renderer side of the app's agent-control channel, registered by the shell. */
export interface AgentControlHandler {
  viewState(): AgentViewState;
  listActions(): AgentActionDescriptor[];
  runAction(request: AgentRunActionRequest): Promise<AgentRunActionResult>;
  beginNodeCapture(nodeId: string): Promise<AgentNodeMeasurement>;
  /** Restores the view; false when the node moved after it was measured. */
  endNodeCapture(): Promise<boolean>;
  /** Reads a node's rendered text once `waitForIdle` resolves, restoring the view. */
  readNode(nodeId: string, waitForIdle: () => Promise<boolean>): Promise<AgentNodeText>;
}

let agentControlHandler: AgentControlHandler | null = null;

export function registerAgentControlHandler(handler: AgentControlHandler): () => void {
  agentControlHandler = handler;
  return () => {
    if (agentControlHandler === handler) agentControlHandler = null;
  };
}

function requireAgentControl(): AgentControlHandler {
  if (agentControlHandler === null) throw new Error("The dashboard shell is still loading. Try again shortly.");
  return agentControlHandler;
}

function nextPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

const rpc = Electroview.defineRPC<DashboardRPC>({
  // Capability calls may legitimately run for 30 seconds; leave transport and
  // process-cleanup headroom beyond that backend limit.
  maxRequestTime: 65_000,
  handlers: {
    requests: {
      agentViewState: () => requireAgentControl().viewState(),
      agentListActions: () => requireAgentControl().listActions(),
      agentRunAction: (request) => requireAgentControl().runAction(request),
      agentBeginNodeCapture: ({ nodeId }) => requireAgentControl().beginNodeCapture(nodeId),
      agentEndNodeCapture: async () => ({ stable: await requireAgentControl().endNodeCapture() }),
      agentSettle: async () => {
        await nextPaint();
        return {};
      },
      agentIdle: async ({ timeoutMs }) => ({ idle: await whenIdle(timeoutMs, nextPaint) }),
      agentReadNode: ({ nodeId, timeoutMs }) => requireAgentControl().readNode(nodeId, () => whenIdle(timeoutMs, nextPaint)),
    },
    messages: {
      themes: (catalog) => emit({ type: "themes", catalog }),
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

const liveHost: DashboardHost = {
  subscribe(listener: HostEventListener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  async getSnapshot() { ensureTransport(); return rpc.request.getSnapshot({}); },
  async getUpdateState() { ensureTransport(); return rpc.request.getUpdateState({}); },
  async updateAction(action) { ensureTransport(); return rpc.request.updateAction(action); },
  async getThemes() { ensureTransport(); return rpc.request.getThemes({}); },
  async getAppSettings() { ensureTransport(); return rpc.request.getAppSettings({}); },
  async updateAppSettings(settings) { ensureTransport(); return rpc.request.updateAppSettings(settings); },
  async previewComponentAgent(request) { ensureTransport(); return rpc.request.previewComponentAgent(request); },
  async launchAgent(request) { ensureTransport(); return rpc.request.launchAgent(request); },
  async repairInstalledTools() { ensureTransport(); return rpc.request.repairInstalledTools({}); },
  async manageExternalComponent(operation) { ensureTransport(); return rpc.request.manageExternalComponent(operation); },
  async manageThemePackage(operation) { ensureTransport(); return rpc.request.manageThemePackage(operation); },
  async getDashboardAgentTasks() { ensureTransport(); return rpc.request.getDashboardAgentTasks({}); },
  async getDashboardAgentDiff(taskId) { ensureTransport(); return rpc.request.getDashboardAgentDiff({ taskId }); },
  async agentTaskCommand(taskId, command) { ensureTransport(); return rpc.request.agentTaskCommand({ taskId, command }); },
  async listProjects() { ensureTransport(); return rpc.request.listProjects({}); },
  async moveProject(configPath, targetConfigPath, before) {
    ensureTransport();
    return rpc.request.moveProject({ configPath, targetConfigPath, before });
  },
  async getProjectOutline({ projectRoot, configPath }) {
    ensureTransport();
    return rpc.request.getProjectOutline({ projectRoot, configPath });
  },
  async chooseProject() {
    ensureTransport();
    return rpc.request.chooseProject({}, { maxRequestTime: Infinity });
  },
  async openProject({ projectRoot, configPath }) {
    ensureTransport();
    await rpc.request.openProject({ projectRoot, configPath });
  },
  async getProjectDeletionPreview({ projectRoot, configPath }) {
    ensureTransport();
    return rpc.request.getProjectDeletionPreview({ projectRoot, configPath });
  },
  async deleteProject({ projectRoot, configPath }, removeFiles) {
    ensureTransport();
    await rpc.request.deleteProject({ projectRoot, configPath, removeFiles });
  },
  async setTrust(trusted) { ensureTransport(); await rpc.request.setTrust({ trusted }); },
  async reloadProject() { ensureTransport(); await rpc.request.reloadProject({}); },
  async getDashboardConfigSource(configPath) { ensureTransport(); return rpc.request.getDashboardConfigSource({ configPath }); },
  async validateDashboardDraft(config, configPath, sourceNodeId) {
    ensureTransport();
    return rpc.request.validateDashboardDraft({ config, configPath, sourceNodeId });
  },
  async validateComponentProps(reference, props) {
    ensureTransport();
    return rpc.request.validateComponentProps({ reference, props });
  },
  async saveDashboardConfig(config, expectedConfigRevision, configPath) {
    ensureTransport();
    await rpc.request.saveDashboardConfig({ config, expectedConfigRevision, configPath });
  },
  async processCommand(nodeId, command) { ensureTransport(); return rpc.request.processCommand({ nodeId, command }); },

  async readTextFile(request) { ensureTransport(); return rpc.request.readTextFile(request); },
  async writeTextFile(request) { ensureTransport(); return rpc.request.writeTextFile(request); },
  async httpRequest(request) { ensureTransport(); return rpc.request.httpRequest(request); },
  async runShell(request) { ensureTransport(); return rpc.request.runShell(request); },
};

declare global {
  interface Window {
    __DASH_BORED_UI_HARNESS__?: boolean;
    /** Present only on ui-harness.html so browser interaction tests can inspect host state. */
    __DASH_BORED_UI_HARNESS_HOST__?: UiHarnessHost;
  }
}

/**
 * The visual fixture runs the actual renderer with deterministic, inert data.
 * It is deliberately selected only by ui-harness.html; production renderer
 * pages keep the Electrobun transport guard above.
 */
export let host: DashboardHost = liveHost;

let hostInitialization: Promise<void> | null = null;

/** Select the browser fixture host before the renderer mounts its UI. */
export function initializeHost(): Promise<void> {
  if (!window.__DASH_BORED_UI_HARNESS__) return Promise.resolve();
  if (hostInitialization) return hostInitialization;

  if (import.meta.env.PROD) return Promise.resolve();
  hostInitialization = import("./ui-harness-host").then(({ createUiHarnessHost }) => {
    const uiHarnessHost = createUiHarnessHost();
    window.__DASH_BORED_UI_HARNESS_HOST__ = uiHarnessHost;
    host = uiHarnessHost;
  });
  return hostInitialization;
}
