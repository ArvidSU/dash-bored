import Electrobun, { BrowserWindow, Updater, Utils } from "electrobun/main";
import { basename, dirname, join } from "node:path";
import { CoreError, ProjectRuntime, TrustStore } from "../core/index";
import { instanceSocketPath, publishToolLocator } from "../core/app-instances";
import { retireManagedCliLink } from "../migrations/cli-link";
import { isLegacyAppThemeReference, upgradeLegacyAppThemeReference } from "../migrations/app-theme-reference";
import { APP_VERSION } from "../shared/app-metadata";
import type { AppSettings } from "../shared/contracts";
import { normalizeNotificationSettings } from "../shared/notifications";
import type { DashboardRPC } from "../shared/rpc";
import { windowAgentControlBridge } from "./agent-control-bridge";
import { startAgentControlServer } from "./agent-control-server";
import { agentNotificationSummary } from "../shared/agent-control";
import { AgentConfigMemory } from "./agent-config-memory";
import { AgentLauncher } from "./agent-launch";
import { onApplicationMenuAction, setApplicationMenu } from "./app-menu";
import { AppSettingsStore } from "./app-settings";
import { loadApplicationThemes, watchPersonalThemes } from "./app-themes";
import { AgentSessions } from "./agent-sessions";
import { createDashboardRPC } from "./dashboard-rpc";
import { openNewWindowsExternally } from "./external-links";
import { InstalledToolDiagnostics } from "./installed-tools";
import { ProjectRegistry } from "./project-registry";
import { configureBundledToolEnvironment, configureDesktopExecutableEnvironment } from "./tool-environment";
import { createAppUpdates } from "./update-wiring";
import { createPackageUpdates } from "./package-updates";
import { createNotifications } from "./notification-wiring";
import { WatchRunner } from "./watches";
import { loadProjectDefinition } from "../core/project";
import { getUpdateSettings, updateDirectory } from "../updates/storage";
import { keepWindowRenderingWhenOccluded } from "./window-capture";

configureDesktopExecutableEnvironment();
const bundledTools = configureBundledToolEnvironment(import.meta.dirname);
const development = (await Updater.localInfo.channel()) === "dev";
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
  if (development) {
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
const trustStore = new TrustStore(join(Utils.paths.userData, "trusted-projects-v1.json"), { automatic: development });
const projectRegistry = new ProjectRegistry(join(Utils.paths.userData, "projects-v1.json"));
await installedTools.refreshRegistered([...new Set((await projectRegistry.list().catch((error: unknown) => {
  console.error("Could not read projects for installed-tool updates.", error);
  return [];
})).map((project) => project.projectRoot))], { includeGlobal: !development });
if (!development) await retireManagedCliLink().catch(() => false);
const appSettingsStore = new AppSettingsStore(join(Utils.paths.userData, "settings-v1.json"));
const initialAppSettings = await appSettingsStore.get();

function agentEnvironment(settings: AppSettings): Record<string, string> {
  return settings.dashBoredAgent === null ? {} : { DASH_BORED_AGENT: settings.dashBoredAgent };
}
let publishedEnvironment = agentEnvironment(initialAppSettings);
let notificationSettings = normalizeNotificationSettings(initialAppSettings.notifications);
// Runs an agent starts through the control channel are the agent's to report, not the user's notification.
let agentActionsRunning = 0;

// Dashboard names for entries about dashboards other than the active one.
const dashboardNames = new Map<string, string | null>();
void projectRegistry.list().then((projects) => {
  for (const project of projects) if (!dashboardNames.has(project.configPath)) dashboardNames.set(project.configPath, project.dashboardName);
}).catch(() => undefined);
const notifications = createNotifications({
  memoryPath: join(Utils.paths.userData, "notifications-v1.json"),
  settings: () => notificationSettings,
  publish: (state) => send("notifications", state),
  active: () => {
    const { configPath, dashboardName, tree } = runtime.getSnapshot();
    return { configPath: configPath ?? null, dashboardName, tree };
  },
  dashboardName: (configPath) => dashboardNames.get(configPath) ?? null,
});

const agentConfigMemory = new AgentConfigMemory(join(Utils.paths.userData, "agent-config-v1.json"));
const agentSessions = new AgentSessions({
  onTask: (task) => {
    send("agentTask", task);
    notifications.agents.observe(task);
  },
  onConfigOffered: (command, options) => void agentConfigMemory.offered(command, options),
  handoffDirectory: join(Utils.paths.userData, "agent-handoff"),
});
const runtime = new ProjectRuntime({
  trustStore,
  isConfigRegistered: async (configPath) => (await projectRegistry.list()).some((project) => project.configPath === configPath),
  getPublishedEnvironment: () => publishedEnvironment,
  onSnapshot(snapshot) {
    send("snapshot", installedTools.addTo(snapshot));
    if (snapshot.projectRoot) installedTools.checkProject(snapshot.projectRoot);
    if (snapshot.configPath) agentSessions.markDashboardChanged(snapshot.configPath);
    if (snapshot.configPath) dashboardNames.set(snapshot.configPath, snapshot.dashboardName);
    watches.observeSnapshot(snapshot);
    void projectRegistry.remember(snapshot).catch((error: unknown) => {
      console.error("Could not persist the dashboard list.", error);
    });
  },
  onProcess: (process) => {
    send("process", process);
    notifications.runs.observe(process);
  },
});
// Declared watches keep observing every registered, trusted dashboard while the app runs.
const watches = new WatchRunner({
  center: notifications.center,
  dashboards: () => projectRegistry.list(),
  active: () => {
    return { configPath: runtime.getSnapshot().configPath ?? null };
  },
  loadDefinition: (configPath) => loadProjectDefinition(configPath),
  isTrusted: (definition) => runtime.isDefinitionTrusted(definition),
  settings: () => notificationSettings,
  getPublishedEnvironment: () => publishedEnvironment,
});

const agents = new AgentLauncher({
  runtime,
  sessions: agentSessions,
  settings: appSettingsStore,
  publishedEnvironment: () => publishedEnvironment,
  configMemory: agentConfigMemory,
});
const updates = createAppUpdates({
  runtime,
  sessions: agentSessions,
  registry: projectRegistry,
  trustStore,
  toolPath: bundledTools ? bundledTools.toolPath : process.execPath,
  agentCommand: (configPath) => agents.command(configPath),
  onReleaseState: (state) => notifications.releases.observe(state),
});

const loadThemes = async () => loadApplicationThemes(await projectRegistry.list(), runtime.getSnapshot());
const publishThemes = async () => send("themes", await loadThemes());
await watchPersonalThemes(() => {
  void publishThemes().catch((error) => console.error("Could not reload personal themes.", error));
});
const packageUpdates = createPackageUpdates({
  registry: projectRegistry,
  runtime,
  publishThemes,
  onChange: (state) => {
    send("packageUpdates", state);
    notifications.packages.observe(state);
  },
  automaticChecks: async () => (await getUpdateSettings(updateDirectory())).automaticChecks,
});

const dashboardRPC = createDashboardRPC({
  runtime,
  registry: projectRegistry,
  trustStore,
  sessions: agentSessions,
  agents,
  installedTools,
  updates,
  packageUpdates,
  notifications,
  agentActionRunning: () => agentActionsRunning > 0,
  onDashboardRemoved: () => watches.requestRefresh(),
  loadThemes,
  publishThemes,
  focusWindow() {
    if (!mainWindow) throw new CoreError("APP_WINDOW_UNAVAILABLE", "The dash-bored window is not available.");
    if (mainWindow.isMinimized()) mainWindow.unminimize();
    // Electrobun show() unhides and activates the window, raising it to the front.
    mainWindow.show();
  },
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
    const previousNotificationSettings = JSON.stringify(notificationSettings);
    notificationSettings = normalizeNotificationSettings(updated.notifications);
    if (JSON.stringify(notificationSettings) !== previousNotificationSettings) watches.requestRefresh();
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
  trafficLightOffset: { x: 0, y: 0 },
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
// Interrupts become system notifications only while the user is in another app.
mainWindow.on("focus", () => notifications.setWindowFocused(true));
mainWindow.on("blur", () => notifications.setWindowFocused(false));
openNewWindowsExternally(Electrobun.events, mainWindow.webview.id, Utils.openExternal);
watches.start();
// Agents drive and capture the app while it sits behind their terminal.
keepWindowRenderingWhenOccluded(mainWindow.ptr);

const windowBridge = windowAgentControlBridge(() => mainWindow, runtime);
const agentControlBridge: typeof windowBridge = {
  ...windowBridge,
  runAction: async (request) => {
    agentActionsRunning += 1;
    try {
      return await windowBridge.runAction(request);
    } finally {
      agentActionsRunning -= 1;
    }
  },
  viewState: async () => ({ ...await windowBridge.viewState(), notifications: agentNotificationSummary(notifications.state()) }),
};
const agentControl = await startAgentControlServer({
  identifier: appInstanceIdentifier,
  pid: process.pid,
  version: APP_VERSION,
  socketPath: instanceSocketPath(appInstanceIdentifier),
  toolPath: bundledTools?.toolPath ?? null,
}, agentControlBridge).catch((error: unknown) => {
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
  watches.stop();
  void Promise.all([runtime.close(), agentSessions.shutdown(), agentControl?.close()]).finally(() => {
    Utils.quit(0);
  });
});

packageUpdates.schedule();
await updates.continueRelease();
