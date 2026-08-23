import Electrobun, {
  ApplicationMenu,
  BrowserView,
  BrowserWindow,
  Updater,
  Utils,
} from "electrobun/main";
import { join } from "node:path";
import { CoreError, ProjectRuntime, TrustStore } from "../core/index";
import type { ProjectSnapshot } from "../shared/contracts";
import type { DashboardRPC } from "../shared/rpc";
import { ProjectRegistry } from "./project-registry";

const DEV_SERVER_URL = "http://localhost:5173";
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

async function chooseAndLoadProject(): Promise<ProjectSnapshot> {
  const paths = await Utils.openFileDialog({
    startingFolder: process.cwd(),
    canChooseFiles: false,
    canChooseDirectory: true,
    allowsMultipleSelection: false,
  });
  const selected = paths[0];
  if (!selected) return runtime.getSnapshot();
  await runtime.load(selected, { inputKind: "project-root" });
  runtime.watch();
  return runtime.getSnapshot();
}

async function openProject(projectRoot: string): Promise<ProjectSnapshot> {
  if (!(await projectRegistry.contains(projectRoot))) {
    throw new CoreError(
      "PROJECT_NOT_REGISTERED",
      "Choose this project through Add dashboard before opening it from the sidebar.",
    );
  }
  await runtime.load(projectRoot, { inputKind: "project-root" });
  runtime.watch();
  return runtime.getSnapshot();
}

const dashboardRPC = BrowserView.defineRPC<DashboardRPC>({
  maxRequestTime: 65_000,
  handlers: {
    requests: {
      getSnapshot: () => runtime.getSnapshot(),
      listProjects: () => projectRegistry.list(),
      chooseProject: () => chooseAndLoadProject(),
      openProject: ({ projectRoot }) => openProject(projectRoot),
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
if (configuredProject) {
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
  void runtime.close().finally(() => {
    Utils.quit(0);
  });
});
