import Electrobun, {
  ApplicationMenu,
  BrowserView,
  BrowserWindow,
  Updater,
  Utils,
} from "electrobun/main";
import { join } from "node:path";
import { CoreError, ProjectRuntime, TrustStore, resolveProjectLocation } from "../core/index";
import type { ProjectSnapshot } from "../shared/contracts";
import {
  buildComponentAgentPrompt,
  componentPath,
  findResolvedNode,
} from "../shared/component-agent";
import type { DashboardRPC } from "../shared/rpc";
import { AppSettingsStore } from "./app-settings";
import { ComponentAgentRunner } from "./component-agent";
import { deleteRegisteredProject, getProjectDeletionPreview } from "./project-deletion";
import { getRegisteredProjectOutline } from "./project-outline";
import { ProjectRegistry } from "./project-registry";
import { configureBundledToolEnvironment } from "./tool-environment";

configureBundledToolEnvironment(import.meta.dirname);

const DEV_SERVER_URL = process.env.DASH_BORED_DEV_SERVER_URL
  ?? `http://127.0.0.1:${process.env.DASH_BORED_VITE_PORT ?? "5173"}`;
const DEV_SERVER_ATTEMPTS = 40;
const DEV_SERVER_RETRY_MS = 100;
const MIN_WINDOW_WIDTH = 350;

async function mainViewUrl(): Promise<string> {
  if ((await Updater.localInfo.channel()) === "dev") {
    for (let attempt = 0; attempt < DEV_SERVER_ATTEMPTS; attempt += 1) {
      try {
        const response = await fetch(DEV_SERVER_URL, { method: "HEAD" });
        if (response.ok) return DEV_SERVER_URL;
      } catch {
        // Vite and Electrobun start concurrently in development.
      }
      await Bun.sleep(DEV_SERVER_RETRY_MS);
    }
  }
  return "views://mainview/index.html";
}

let mainWindow: BrowserWindow | null = null;

function sendSnapshot(snapshot: ProjectSnapshot): void {
  (mainWindow?.webview.rpc as { send?: { snapshot(value: ProjectSnapshot): void } } | undefined)
    ?.send?.snapshot(snapshot);
}

function openCommandPalette(): void {
  (
    mainWindow?.webview.rpc as
      | { send?: { openCommandPalette(value: {}): void } }
      | undefined
  )?.send?.openCommandPalette({});
}

const trustStore = new TrustStore(join(Utils.paths.userData, "trusted-projects-v1.json"));
const projectRegistry = new ProjectRegistry(join(Utils.paths.userData, "projects-v1.json"));
const appSettingsStore = new AppSettingsStore(join(Utils.paths.userData, "settings-v1.json"));
const initialAppSettings = await appSettingsStore.get();
process.env.DASH_BORED_AGENT = initialAppSettings.dashBoredAgent;
const componentAgentRunner = new ComponentAgentRunner();
const runtime = new ProjectRuntime({
  trustStore,
  onSnapshot(snapshot) {
    sendSnapshot(snapshot);
    void projectRegistry.remember(snapshot).catch((error: unknown) => {
      console.error("Could not persist the dashboard list.", error);
    });
  },
  onProcess(process) {
    (mainWindow?.webview.rpc as { send?: { process(value: typeof process): void } } | undefined)
      ?.send?.process(process);
  },
});

async function runComponentAgent(nodeId: string, userPrompt: string) {
  const snapshot = runtime.getSnapshot();
  if (!snapshot.tree || !snapshot.projectRoot) {
    throw new CoreError("PROJECT_NOT_LOADED", "Open a dashboard before asking an agent to change it.");
  }
  const node = findResolvedNode(snapshot.tree, nodeId);
  if (!node) {
    throw new CoreError(
      "COMPONENT_NOT_FOUND",
      "That component is no longer present. Reopen its menu and try again.",
    );
  }
  const source = await runtime.getDashboardConfigSource(node.sourceConfigPath);
  const sourceLocation = await resolveProjectLocation(source.configPath);
  const locator = componentPath(node);
  const settings = await appSettingsStore.get();
  const prompt = buildComponentAgentPrompt({
    projectRoot: sourceLocation.projectRoot,
    configPath: source.configPath,
    componentPath: locator,
    componentId: node.id,
    componentReference: node.component,
  }, userPrompt);
  return componentAgentRunner.launch({
    command: settings.dashBoredAgent,
    prompt,
    projectRoot: sourceLocation.projectRoot,
    componentPath: locator,
  });
}

async function chooseAndLoadProject(): Promise<ProjectSnapshot> {
  const paths = await Utils.openFileDialog({
    startingFolder: process.cwd(),
    canChooseFiles: false,
    canChooseDirectory: true,
    allowsMultipleSelection: false,
  });
  const selected = paths[0];
  if (!selected) return runtime.getSnapshot();
  await runtime.load(selected, { inputKind: "auto" });
  runtime.watch();
  return runtime.getSnapshot();
}

async function openProject(projectRoot: string, configPath: string): Promise<ProjectSnapshot> {
  if (!(await projectRegistry.contains(projectRoot, configPath))) {
    throw new CoreError(
      "PROJECT_NOT_REGISTERED",
      "Choose this project through Add dashboard before opening it from the sidebar.",
    );
  }
  await runtime.load(configPath, { inputKind: "auto" });
  runtime.watch();
  return runtime.getSnapshot();
}

const dashboardRPC = BrowserView.defineRPC<DashboardRPC>({
  maxRequestTime: 65_000,
  handlers: {
    requests: {
      getSnapshot: () => runtime.getSnapshot(),
      getAppSettings: () => appSettingsStore.get(),
      updateAppSettings: async (settings) => {
        const updated = await appSettingsStore.update(settings);
        process.env.DASH_BORED_AGENT = updated.dashBoredAgent;
        return updated;
      },
      runComponentAgent: ({ nodeId, prompt }) => runComponentAgent(nodeId, prompt),
      listProjects: () => projectRegistry.list(),
      getProjectOutline: ({ projectRoot, configPath }) =>
        getRegisteredProjectOutline(projectRegistry, projectRoot, configPath),
      chooseProject: () => chooseAndLoadProject(),
      openProject: ({ projectRoot, configPath }) => openProject(projectRoot, configPath),
      getProjectDeletionPreview: ({ projectRoot, configPath }) =>
        getProjectDeletionPreview(projectRegistry, projectRoot, configPath),
      deleteProject: ({ projectRoot, configPath, removeFiles }) =>
        deleteRegisteredProject({
          registry: projectRegistry,
          runtime,
          trustStore,
          projectRoot,
          configPath,
          removeFiles,
          moveToTrash: (path) => Utils.moveToTrash(path),
        }),
      trustProject: () => runtime.trust(),
      revokeTrust: () => runtime.revoke(),
      reloadProject: () => runtime.reload(),
      getDashboardConfigSource: ({ configPath }) => runtime.getDashboardConfigSource(configPath),
      validateDashboardDraft: ({ config, configPath }) => runtime.validateDashboardDraft(config, configPath),
      validateComponentProps: ({ reference, props }) => runtime.validateComponentProps(reference, props),
      saveDashboardConfig: ({ config, expectedConfigRevision, configPath }) =>
        runtime.saveDashboardConfig(config, expectedConfigRevision, configPath),
      startProcess: ({ nodeId }) => runtime.startProcess(nodeId),
      stopProcess: ({ nodeId }) => runtime.stopProcess(nodeId),
      readTextFile: (request) => runtime.readText(request),
      writeTextFile: (request) => runtime.writeText(request),
      httpRequest: (request) => runtime.http(request),
      runShell: (request) => runtime.runShell(request),
    },
    messages: {},
  },
});

ApplicationMenu.setApplicationMenu([
  {
    label: "dash-bored",
    submenu: [{ role: "about" }, { type: "separator" }, { role: "quit" }],
  },
  {
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "selectAll" },
    ],
  },
  {
    label: "View",
    submenu: [
      {
        label: "Show Command Palette",
        action: "open-command-palette",
        accelerator: "CommandOrControl+K",
      },
    ],
  },
]);

ApplicationMenu.on("application-menu-clicked", (event) => {
  const action = (event as { data?: { action?: unknown } }).data?.action;
  if (action === "open-command-palette") openCommandPalette();
});

const configuredProject = process.env.DASH_BORED_PROJECT_ROOT;
const configuredConfig = process.env.DASH_BORED_CONFIG_PATH;
if (configuredConfig) {
  await runtime.load(configuredConfig, { inputKind: "auto" });
  runtime.watch();
} else if (configuredProject) {
  await runtime.load(configuredProject, { inputKind: "project-root" });
  runtime.watch();
}

mainWindow = new BrowserWindow({
  title: "dash-bored",
  url: await mainViewUrl(),
  rpc: dashboardRPC,
  titleBarStyle: "hiddenInset",
  trafficLightOffset: { x: 18, y: 0 },
  frame: {
    width: 1280,
    height: 800,
  },
});

mainWindow.on("resize", (event) => {
  const data = (event as { data?: { width?: unknown; height?: unknown } }).data;
  if (typeof data?.width !== "number" || data.width >= MIN_WINDOW_WIDTH) return;
  const height = typeof data.height === "number" ? data.height : mainWindow?.frame.height ?? 800;
  mainWindow?.setSize(MIN_WINDOW_WIDTH, height);
});

mainWindow.webview.on("dom-ready", () => sendSnapshot(runtime.getSnapshot()));

let cleanupStarted = false;
Electrobun.events.on("before-quit", (event) => {
  if (cleanupStarted) return;
  cleanupStarted = true;
  event.response = { allow: false };
  void Promise.all([runtime.close(), componentAgentRunner.close()]).finally(() => {
    Utils.quit(0);
  });
});
