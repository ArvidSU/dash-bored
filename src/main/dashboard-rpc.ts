import { homedir } from "node:os";
import { BrowserView, Utils } from "electrobun/main";
import { CoreError, type ProjectRuntime, type TrustStore } from "../core/index";
import type { AppSettings } from "../shared/contracts";
import type { DashboardRPC } from "../shared/rpc";
import type { ThemeCatalogItem } from "../shared/themes";
import type { AgentLauncher } from "./agent-launch";
import type { DashboardAgentHarness } from "./component-agent";
import type { InstalledToolDiagnostics } from "./installed-tools";
import { runExternalComponentOperation, runThemePackageOperation } from "./package-management";
import { deleteRegisteredProject, getProjectDeletionPreview } from "./project-deletion";
import { getRegisteredProjectOutline } from "./project-outline";
import type { ProjectRegistry } from "./project-registry";
import type { AppUpdates } from "./update-wiring";

export interface DashboardRPCOptions {
  runtime: ProjectRuntime;
  registry: ProjectRegistry;
  trustStore: TrustStore;
  harness: DashboardAgentHarness;
  agents: AgentLauncher;
  installedTools: InstalledToolDiagnostics;
  updates: AppUpdates;
  loadThemes(): Promise<ThemeCatalogItem[]>;
  /** Pushes a fresh theme catalog to the renderer. */
  publishThemes(): Promise<void>;
  readAppSettings(): Promise<AppSettings>;
  updateAppSettings(settings: AppSettings): Promise<AppSettings>;
}

/**
 * The renderer's requests. Queries answer with data; mutations push what they
 * changed (through the runtime's snapshot and process callbacks) before they
 * resolve and answer with an ack or a command-specific result.
 */
export function createDashboardRPC(options: DashboardRPCOptions) {
  const { runtime, registry, trustStore, harness, agents, installedTools, updates } = options;

  async function loadAndWatch(configPath: string): Promise<void> {
    await runtime.load(configPath, { inputKind: "auto" });
    runtime.watch();
  }

  return BrowserView.defineRPC<DashboardRPC>({
    maxRequestTime: 65_000,
    handlers: {
      requests: {
        getSnapshot: () => installedTools.addTo(runtime.getSnapshot()),
        getThemes: () => options.loadThemes(),
        getUpdateState: () => updates.state(),
        updateAction: (action) => updates.action(action),
        getAppSettings: () => options.readAppSettings(),
        updateAppSettings: (settings) => options.updateAppSettings(settings),
        previewComponentAgent: (request) => agents.preview(request),
        launchAgent: (request) => agents.launch(request),
        repairInstalledTools: () => installedTools.repairConflicts(),
        manageExternalComponent: async (operation) => {
          const configPath = runtime.getSnapshot().configPath;
          if (!configPath) throw new CoreError("PROJECT_NOT_LOADED", "Open a dashboard before managing its external components.");
          const result = await runExternalComponentOperation(configPath, operation);
          await runtime.reload();
          return result;
        },
        manageThemePackage: async (operation) => {
          const result = await runThemePackageOperation(operation);
          await options.publishThemes();
          return result;
        },
        getDashboardAgentTasks: () => harness.list(),
        getDashboardAgentDiff: ({ taskId }) => agents.diff(taskId),
        agentTaskCommand: ({ taskId, command }) => agents.taskCommand(taskId, command),
        listProjects: () => registry.list(),
        moveProject: ({ configPath, targetConfigPath, before }) => registry.move(configPath, targetConfigPath, before),
        getProjectOutline: ({ projectRoot, configPath }) => getRegisteredProjectOutline(registry, projectRoot, configPath),
        chooseProject: async () => {
          const [selected] = await Utils.openFileDialog({
            startingFolder: homedir(),
            canChooseFiles: false,
            canChooseDirectory: true,
            allowsMultipleSelection: false,
          });
          if (!selected) return { opened: false };
          await loadAndWatch(selected);
          return { opened: runtime.getSnapshot().projectRoot !== null };
        },
        openProject: async ({ projectRoot, configPath }) => {
          if (!(await registry.contains(projectRoot, configPath))) {
            throw new CoreError(
              "PROJECT_NOT_REGISTERED",
              "Choose this project through Add dashboard before opening it from the sidebar.",
            );
          }
          await loadAndWatch(configPath);
        },
        getProjectDeletionPreview: ({ projectRoot, configPath }) => getProjectDeletionPreview(registry, projectRoot, configPath),
        deleteProject: async ({ projectRoot, configPath, removeFiles }) => {
          await deleteRegisteredProject({
            registry,
            runtime,
            trustStore,
            projectRoot,
            configPath,
            removeFiles,
            moveToTrash: (path) => Utils.moveToTrash(path),
          });
        },
        setTrust: async ({ trusted }) => {
          if (trusted) {
            await runtime.trust();
            return;
          }
          const projectRoot = runtime.getSnapshot().projectRoot;
          await runtime.revoke();
          if (projectRoot) await harness.stopProject(projectRoot);
        },
        reloadProject: async () => { await runtime.reload(); },
        getDashboardConfigSource: ({ configPath }) => runtime.getDashboardConfigSource(configPath),
        validateDashboardDraft: ({ config, configPath }) => runtime.validateDashboardDraft(config, configPath),
        validateComponentProps: ({ reference, props }) => runtime.validateComponentProps(reference, props),
        saveDashboardConfig: async ({ config, expectedConfigRevision, configPath }) => {
          await runtime.saveDashboardConfig(config, expectedConfigRevision, configPath);
        },
        processCommand: ({ nodeId, command }) => runtime.processCommand(nodeId, command),
        readTextFile: (request) => runtime.readText(request),
        writeTextFile: (request) => runtime.writeText(request),
        httpRequest: (request) => runtime.http(request),
        runShell: (request) => runtime.runShell(request),
      },
      messages: {},
    },
  });
}
