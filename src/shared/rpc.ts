import type { RPCSchema } from "electrobun/main";
import type {
  DashboardConfig,
  DashboardConfigSource,
  DashboardDraftValidation,
  ComponentPropsValidation,
  FileReadRequest,
  HttpRequest,
  HttpResponsePayload,
  ProcessSnapshot,
  ProjectListItem,
  ProjectSnapshot,
  SaveDashboardConfigRequest,
  ShellRunRequest,
  ShellRunResult,
} from "./contracts";

export type DashboardRPC = {
  bun: RPCSchema<{
    requests: {
      getSnapshot: { params: {}; response: ProjectSnapshot };
      listProjects: { params: {}; response: ProjectListItem[] };
      chooseProject: { params: {}; response: ProjectSnapshot };
      openProject: { params: { projectRoot: string }; response: ProjectSnapshot };
      trustProject: { params: {}; response: ProjectSnapshot };
      revokeTrust: { params: {}; response: ProjectSnapshot };
      reloadProject: { params: {}; response: ProjectSnapshot };
      getDashboardConfigSource: { params: { configPath?: string }; response: DashboardConfigSource };
      validateDashboardDraft: { params: { config: DashboardConfig; configPath?: string }; response: DashboardDraftValidation };
      validateComponentProps: { params: { reference: string; props: Record<string, unknown> }; response: ComponentPropsValidation };
      saveDashboardConfig: { params: SaveDashboardConfigRequest; response: ProjectSnapshot };
      startProcess: { params: { nodeId: string }; response: ProcessSnapshot };
      stopProcess: { params: { nodeId: string }; response: ProcessSnapshot };
      readTextFile: { params: FileReadRequest; response: string };
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
