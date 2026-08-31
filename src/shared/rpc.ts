import type { RPCSchema } from "electrobun/main";
import type {
  AppSettings,
  ComponentAgentLaunch,
  ComponentAgentRequest,
  ComponentCreationAgentRequest,
  DashboardConfig,
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
  SaveDashboardConfigRequest,
  ShellRunRequest,
  ShellRunResult,
} from "./contracts";

export type DashboardRPC = {
  bun: RPCSchema<{
    requests: {
      getSnapshot: { params: {}; response: ProjectSnapshot };
      getAppSettings: { params: {}; response: AppSettings };
      updateAppSettings: { params: AppSettings; response: AppSettings };
      runComponentAgent: { params: ComponentAgentRequest; response: ComponentAgentLaunch };
      runComponentCreationAgent: { params: ComponentCreationAgentRequest; response: ComponentAgentLaunch };
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
      startProcess: { params: { nodeId: string }; response: ProcessSnapshot };
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
    requests: {};
    messages: {
      snapshot: ProjectSnapshot;
      process: ProcessSnapshot;
      openCommandPalette: {};
    };
  }>;
};
