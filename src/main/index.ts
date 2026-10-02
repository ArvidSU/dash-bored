import Electrobun, { BrowserWindow, Updater, Utils } from "electrobun/main";
import { basename, dirname, join } from "node:path";
import { ProjectRuntime, TrustStore } from "../core/index";
import { instanceSocketPath, publishToolLocator } from "../core/app-instances";
import { retireManagedCliLink } from "../migrations/cli-link";
import { isLegacyAppThemeReference, upgradeLegacyAppThemeReference } from "../migrations/app-theme-reference";
import { APP_VERSION } from "../shared/app-metadata";
import type { AppSettings } from "../shared/contracts";
import type { DashboardRPC } from "../shared/rpc";
import { windowAgentControlBridge } from "./agent-control-bridge";
import { startAgentControlServer } from "./agent-control-server";
import { AgentLauncher } from "./agent-launch";
import { onApplicationMenuAction, setApplicationMenu } from "./app-menu";
import { AppSettingsStore } from "./app-settings";
import { loadApplicationThemes, watchPersonalThemes } from "./app-themes";
import { DashboardAgentHarness } from "./component-agent";
import { createDashboardRPC } from "./dashboard-rpc";
import { InstalledToolDiagnostics } from "./installed-tools";
import { ProjectRegistry } from "./project-registry";
import { configureBundledToolEnvironment, configureDesktopExecutableEnvironment } from "./tool-environment";
import { createAppUpdates } from "./update-wiring";
import { keepWindowRenderingWhenOccluded } from "./window-capture";

configureDesktopExecutableEnvironment();
const bundledTools = configureBundledToolEnvironment(import.meta.dirname);
// Utils.paths.userData is <appData>/<identifier>/<channel>. Release and
// development builds share the identifier, so the channel keeps them apart.
const appInstanceIdentifier = `${basename(dirname(Utils.paths.userData))}.${basename(Utils.paths.userData)}`;
process.env.DASH_BORED_APP_INSTANCE = appInstanceIdentifier;

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
        if (response.ok) {
          return process.env.DASH_BORED_NATIVE_PROBE === "1"
            ? `${DEV_SERVER_URL}/native-probe.html`
            : DEV_SERVER_URL;
        }
      } catch {
        // Vite and Electrobun start concurrently in development.
      }
      await Bun.sleep(DEV_SERVER_RETRY_MS);
    }
  }
  return "views://mainview/index.html";
}

let mainWindow: BrowserWindow | null = null;

type WindowMessages = DashboardRPC["webview"]["messages"];
/** Pushes host state to the renderer; a closed or loading window drops it. */
function send<K extends keyof WindowMessages>(name: K, value: WindowMessages[K]): void {
  (mainWindow?.webview.rpc as { send?: { [M in keyof WindowMessages]: (value: WindowMessages[M]) => void } } | undefined)
    ?.send?.[name](value);
}

const installedTools = new InstalledToolDiagnostics({
  moveToTrash: async (path) => await Utils.moveToTrash(path),
  onChange: () => send("snapshot", installedTools.addTo(runtime.getSnapshot())),
});
const trustStore = new TrustStore(join(Utils.paths.userData, "trusted-projects-v1.json"));
const projectRegistry = new ProjectRegistry(join(Utils.paths.userData, "projects-v1.json"));
await installedTools.refreshRegistered([...new Set((await projectRegistry.list().catch((error: unknown) => {
  console.error("Could not read projects for installed-tool updates.", error);
  return [];
})).map((project) => project.projectRoot))]);
await retireManagedCliLink().catch(() => false);
const appSettingsStore = new AppSettingsStore(join(Utils.paths.userData, "settings-v1.json"));
const initialAppSettings = await appSettingsStore.get();

function agentEnvironment(settings: AppSettings): Record<string, string> {
  return settings.dashBoredAgent === null ? {} : { DASH_BORED_AGENT: settings.dashBoredAgent };
}
let publishedEnvironment = agentEnvironment(initialAppSettings);

const dashboardAgentHarness = new DashboardAgentHarness({ onTask: (task) => send("agentTask", task) });
const runtime = new ProjectRuntime({
  trustStore,
  isConfigRegistered: async (configPath) => (await projectRegistry.list()).some((project) => project.configPath === configPath),
  getPublishedEnvironment: () => publishedEnvironment,
  onSnapshot(snapshot) {
    send("snapshot", installedTools.addTo(snapshot));
    if (snapshot.projectRoot) installedTools.checkProject(snapshot.projectRoot);
    if (snapshot.configPath) dashboardAgentHarness.markDashboardChanged(snapshot.configPath);
    void projectRegistry.remember(snapshot).catch((error: unknown) => {
      console.error("Could not persist the dashboard list.", error);
    });
  },
  onProcess: (process) => send("process", process),
});

const agents = new AgentLauncher({
  runtime,
  harness: dashboardAgentHarness,
  settings: appSettingsStore,
  publishedEnvironment: () => publishedEnvironment,
});
const updates = createAppUpdates({
  runtime,
  harness: dashboardAgentHarness,
  registry: projectRegistry,
  trustStore,
  toolPath: bundledTools ? bundledTools.toolPath : process.execPath,
  agentCommand: (configPath) => agents.command(configPath),
});

const loadThemes = async () => loadApplicationThemes(await projectRegistry.list(), runtime.getSnapshot());
const publishThemes = async () => send("themes", await loadThemes());
await watchPersonalThemes(() => {
  void publishThemes().catch((error) => console.error("Could not reload personal themes.", error));
});

const dashboardRPC = createDashboardRPC({
  runtime,
  registry: projectRegistry,
  trustStore,
  harness: dashboardAgentHarness,
  agents,
  installedTools,
  updates,
  loadThemes,
  publishThemes,
  /** App settings as the renderer reads them, with a legacy theme pinned once its dashboard is active. */
  async readAppSettings() {
    const settings = await appSettingsStore.get();
    const activeConfigPath = runtime.getSnapshot().configPath;
    if (!isLegacyAppThemeReference(settings.theme) || !activeConfigPath) return settings;
    const theme = upgradeLegacyAppThemeReference(settings.theme, activeConfigPath, await loadThemes());
    return theme === undefined ? settings : appSettingsStore.update({ ...settings, theme });
  },
  async updateAppSettings(settings) {
    const updated = await appSettingsStore.update(settings);
    publishedEnvironment = agentEnvironment(updated);
    setApplicationMenu(updated);
    await runtime.refreshEnvironment();
    return updated;
  },
});

setApplicationMenu(initialAppSettings);
onApplicationMenuAction({
  openCommandPalette: () => send("openCommandPalette", {}),
  reloadApp: () => mainWindow?.webview.executeJavascript("window.location.reload()"),
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

mainWindow.webview.on("dom-ready", () => send("snapshot", installedTools.addTo(runtime.getSnapshot())));
// Agents drive and capture the app while it sits behind their terminal.
keepWindowRenderingWhenOccluded(mainWindow.ptr);

const agentControl = await startAgentControlServer({
  identifier: appInstanceIdentifier,
  pid: process.pid,
  version: APP_VERSION,
  socketPath: instanceSocketPath(appInstanceIdentifier),
  toolPath: bundledTools?.toolPath ?? null,
}, windowAgentControlBridge(() => mainWindow, runtime)).catch((error: unknown) => {
  console.error("Agent control channel unavailable:", error);
  return null;
});
// Only the installed release records its tool for agents started outside it.
if (bundledTools && (await Updater.localInfo.channel()) === "canary") {
  void publishToolLocator(bundledTools.toolPath).catch((error: unknown) => {
    console.error("Could not record the agent tool location:", error);
  });
}

let cleanupStarted = false;
Electrobun.events.on("before-quit", (event) => {
  // Native apply already rejected running work. Its helper must receive quit
  // approval before any shutdown; the ordinary async cleanup veto would abort it.
  if (updates.isApplyingNativeUpdate()) { event.response = { allow: true }; return; }
  if (cleanupStarted) return;
  cleanupStarted = true;
  event.response = { allow: false };
  void Promise.all([runtime.close(), dashboardAgentHarness.close(), agentControl?.close()]).finally(() => {
    Utils.quit(0);
  });
});

await updates.continueRelease();
