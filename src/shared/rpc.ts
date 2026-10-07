import type { RPCSchema } from "electrobun/main";
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
  ProjectListItem,
  ProjectDeletionPreview,
  ProjectSnapshot,
  ProjectTarget,
  DeleteProjectRequest,
  ExternalComponentOperation,
  PackageOperationResult,
  SaveDashboardConfigRequest,
  ShellRunRequest,
  ShellRunResult,
  ThemePackageOperation,
} from "./contracts";

/**
 * Host state (the project snapshot, processes, agent tasks, themes) reaches
 * the renderer only as `webview` messages. A mutation pushes what it changed
 * before it resolves and answers with an ack or a command-specific result,
 * never with a copy of that state.
 */
export type DashboardRPC = {
  bun: RPCSchema<{
    requests: {
      getSnapshot: { params: {}; response: ProjectSnapshot };
      getThemes: { params: {}; response: import("./themes").ThemeCatalogItem[] };
      getUpdateState: { params: {}; response: import("./updates").UpdateState };
      updateAction: { params: import("./updates").UpdateAction; response: import("./updates").UpdateState };
      getAppSettings: { params: {}; response: AppSettings };
      updateAppSettings: { params: AppSettings; response: AppSettings };
      previewComponentAgent: { params: ComponentAgentRequest; response: ComponentAgentPreview };
      launchAgent: { params: AgentLaunchRequest; response: ComponentAgentLaunch };
      repairInstalledTools: { params: {}; response: { conflictsRemain: boolean } };
      manageExternalComponent: { params: ExternalComponentOperation; response: PackageOperationResult };
      manageThemePackage: { params: ThemePackageOperation; response: PackageOperationResult };
      getDashboardAgentTasks: { params: {}; response: DashboardAgentTask[] };
      getDashboardAgentDiff: { params: { taskId: string }; response: string };
      agentTaskCommand: { params: { taskId: string; command: AgentTaskCommand }; response: DashboardAgentTask };
      listProjects: { params: {}; response: ProjectListItem[] };
      moveProject: { params: { configPath: string; targetConfigPath: string; before: boolean }; response: ProjectListItem[] };
      getProjectOutline: { params: ProjectTarget; response: ProjectOutline };
      chooseProject: { params: {}; response: { opened: boolean } };
      openProject: { params: ProjectTarget; response: void };
      getProjectDeletionPreview: { params: ProjectTarget; response: ProjectDeletionPreview };
      deleteProject: { params: DeleteProjectRequest; response: void };
      setTrust: { params: { trusted: boolean }; response: void };
      reloadProject: { params: {}; response: void };
      focusWindow: { params: {}; response: void };
      getDashboardConfigSource: { params: { configPath?: string }; response: DashboardConfigSource };
      validateDashboardDraft: { params: { config: DashboardConfig; configPath?: string; sourceNodeId?: string }; response: DashboardDraftValidation };
      validateComponentProps: { params: { reference: string; props: Record<string, unknown> }; response: ComponentPropsValidation };
      saveDashboardConfig: { params: SaveDashboardConfigRequest; response: void };
      processCommand: { params: { nodeId: string; command: ProcessCommand }; response: ProcessSnapshot };
      readTextFile: { params: FileReadRequest; response: string };
      writeTextFile: { params: FileWriteRequest; response: void };
      httpRequest: { params: HttpRequest; response: HttpResponsePayload };
      runShell: { params: ShellRunRequest; response: ShellRunResult };
    };
    messages: {};
  }>;
  webview: RPCSchema<{
    requests: {
      agentViewState: { params: {}; response: import("./agent-control").AgentViewState };
      agentListActions: { params: {}; response: import("./agent-control").AgentActionDescriptor[] };
      agentRunAction: { params: import("./agent-control").AgentRunActionRequest; response: import("./agent-control").AgentRunActionResult };
      agentSettle: { params: {}; response: {} };
      agentIdle: { params: { timeoutMs: number }; response: { idle: boolean } };
      agentBeginNodeCapture: { params: { nodeId: string }; response: import("./agent-control").AgentNodeMeasurement };
      agentEndNodeCapture: { params: {}; response: { stable: boolean } };
      agentReadNode: { params: { nodeId: string; timeoutMs: number }; response: import("./agent-control").AgentNodeText };
    };
    messages: {
      themes: import("./themes").ThemeCatalogItem[];
      snapshot: ProjectSnapshot;
      process: ProcessSnapshot;
      agentTask: DashboardAgentTask;
      openCommandPalette: {};
    };
  }>;
};
