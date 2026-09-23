import type { RPCSchema } from "electrobun/main";
import type {
  AppSettings,
  ComponentAgentLaunch,
  ComponentAgentRequest,
  DashboardSetupAgentRequest,
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

export type DashboardRPC = {
  bun: RPCSchema<{
    requests: {
      getSnapshot: { params: {}; response: ProjectSnapshot };
      getThemes: { params: {}; response: import("./themes").ThemeCatalogItem[] };
      getUpdateState: { params: {}; response: import("./updates").UpdateState };
      updateAction: { params: import("./updates").UpdateAction; response: import("./updates").UpdateState };
      getAppSettings: { params: {}; response: AppSettings };
      updateAppSettings: { params: AppSettings; response: AppSettings };
      runComponentAgent: { params: ComponentAgentRequest; response: ComponentAgentLaunch };
      runComponentCreationAgent: { params: ComponentCreationAgentRequest; response: ComponentAgentLaunch };
      runDiagnosticsAgent: { params: {}; response: ComponentAgentLaunch };
      repairInstalledTools: { params: {}; response: ProjectSnapshot };
      manageExternalComponent: { params: ExternalComponentOperation; response: { result: PackageOperationResult; snapshot: ProjectSnapshot } };
      manageThemePackage: { params: ThemePackageOperation; response: PackageOperationResult };
      setupDashboardWithAgent: { params: DashboardSetupAgentRequest; response: ComponentAgentLaunch };
      getDashboardAgentTasks: { params: {}; response: DashboardAgentTask[] };
      getDashboardAgentDiff: { params: { taskId: string }; response: string };
      stopDashboardAgentTask: { params: { taskId: string }; response: DashboardAgentTask };
      writeDashboardAgentTerminal: { params: { taskId: string; input: string }; response: DashboardAgentTask };
      resizeDashboardAgentTerminal: { params: { taskId: string; cols: number; rows: number }; response: DashboardAgentTask };
      listProjects: { params: {}; response: ProjectListItem[] };
      getProjectOutline: { params: ProjectTarget; response: ProjectOutline };
      chooseProject: { params: {}; response: ProjectSnapshot };
      openProject: { params: ProjectTarget; response: ProjectSnapshot };
      getProjectDeletionPreview: { params: ProjectTarget; response: ProjectDeletionPreview };
      deleteProject: { params: DeleteProjectRequest; response: ProjectSnapshot };
      trustProject: { params: {}; response: ProjectSnapshot };
      revokeTrust: { params: {}; response: ProjectSnapshot };
      reloadProject: { params: {}; response: ProjectSnapshot };
      getDashboardConfigSource: { params: { configPath?: string }; response: DashboardConfigSource };
      validateDashboardDraft: { params: { config: DashboardConfig; configPath?: string }; response: DashboardDraftValidation };
      validateComponentProps: { params: { reference: string; props: Record<string, unknown> }; response: ComponentPropsValidation };
      saveDashboardConfig: { params: SaveDashboardConfigRequest; response: ProjectSnapshot };
      startProcess: { params: { nodeId: string; itemEnvironment?: Record<string, string> }; response: ProcessSnapshot };
      openProcessTerminal: { params: { nodeId: string }; response: ProcessSnapshot };
      runProcessQuickAction: { params: { nodeId: string }; response: ProcessSnapshot };
      writeProcessTerminal: { params: { nodeId: string; input: string }; response: ProcessSnapshot };
      resizeProcessTerminal: { params: { nodeId: string; cols: number; rows: number }; response: ProcessSnapshot };
      stopProcess: { params: { nodeId: string }; response: ProcessSnapshot };
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
