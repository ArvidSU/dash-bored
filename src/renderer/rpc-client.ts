import { Electroview } from "electrobun/view";
import type {
  DashboardConfig,
  DashboardConfigSource,
  DashboardDraftValidation,
  ComponentPropsValidation,
  FileReadRequest,
  FileWriteRequest,
  HttpRequest,
  HttpResponsePayload,
  ProcessSnapshot,
  ProjectListItem,
  ProjectSnapshot,
  ShellRunRequest,
  ShellRunResult,
} from "../shared/contracts";
import type { DashboardRPC } from "../shared/rpc";

export type HostEvent =
  | { type: "snapshot"; snapshot: ProjectSnapshot }
  | { type: "process"; process: ProcessSnapshot }
  | { type: "open-command-palette" };

type HostEventListener = (event: HostEvent) => void;

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

export const host = {
  subscribe(listener: HostEventListener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  getSnapshot(): Promise<ProjectSnapshot> {
    return snapshotRequest(() => rpc.request.getSnapshot({}));
  },

  async listProjects(): Promise<ProjectListItem[]> {
    ensureTransport();
    return await rpc.request.listProjects({});
  },

  chooseProject(): Promise<ProjectSnapshot> {
    return snapshotRequest(() =>
      rpc.request.chooseProject({}, { maxRequestTime: Infinity }),
    );
  },

  openProject(projectRoot: string): Promise<ProjectSnapshot> {
    return snapshotRequest(() => rpc.request.openProject({ projectRoot }));
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
