import Electrobun, {
  ApplicationMenu,
  BrowserView,
  BrowserWindow,
  Updater,
  Utils,
} from "electrobun/main";
import { isAbsolute, join, relative, sep } from "node:path";
import { CoreError, ProjectRuntime, TrustStore, resolveProjectLocation } from "../core/index";
import type {
  DashboardAgentTask,
  DashboardConfigSource,
  DashboardInsertionTarget,
  ProjectSnapshot,
} from "../shared/contracts";
import {
  buildComponentAgentPrompt,
  buildComponentCreationAgentPrompt,
  buildDiagnosticsAgentPrompt,
  componentPath,
  findResolvedNode,
  resolveDashboardInsertionPath,
} from "../shared/component-agent";
import type { DashboardRPC } from "../shared/rpc";
import { AppSettingsStore } from "./app-settings";
import { DashboardAgentHarness } from "./component-agent";
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
const MAX_AGENT_DIFF_BYTES = 512 * 1024;

async function readBoundedProcessText(
  stream: ReadableStream<Uint8Array> | null,
  maximumBytes: number,
): Promise<string> {
  if (stream === null) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximumBytes) {
      await reader.cancel();
      throw new CoreError("DASHBOARD_AGENT_DIFF_TOO_LARGE", "The dashboard diff exceeds the display limit.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function getDashboardAgentDiff(taskId: string): Promise<string> {
  const task = dashboardAgentHarness.list().find((candidate) => candidate.id === taskId);
  if (!task) throw new CoreError("DASHBOARD_AGENT_TASK_NOT_FOUND", "That dashboard agent task is no longer available.");
  const location = await resolveProjectLocation(task.configPath);
  const folder = relative(location.projectRoot, location.configDirectory).split(sep).join("/");
  if (folder === "" || folder === ".." || folder.startsWith("../") || isAbsolute(folder)) {
    throw new CoreError("DASHBOARD_AGENT_DIFF_PATH_INVALID", "The dashboard folder is outside the project.");
  }
  const subprocess = Bun.spawn({
    cmd: ["git", "-C", location.projectRoot, "diff", "--no-ext-diff", "--no-textconv", "HEAD", "--", folder],
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      subprocess.exited,
      readBoundedProcessText(subprocess.stdout, MAX_AGENT_DIFF_BYTES),
      readBoundedProcessText(subprocess.stderr, MAX_AGENT_DIFF_BYTES),
    ]);
    if (subprocess.signalCode !== null || exitCode !== 0) {
      throw new CoreError(
        "DASHBOARD_AGENT_DIFF_FAILED",
        stderr.trim() || `git diff exited with code ${String(exitCode)}.`,
      );
    }
    return stdout;
  } catch (error) {
    if (subprocess.exitCode === null) subprocess.kill("SIGKILL");
    await subprocess.exited.catch(() => undefined);
    if (error instanceof CoreError) throw error;
    throw new CoreError("DASHBOARD_AGENT_DIFF_FAILED", error instanceof Error ? error.message : String(error));
  }
}

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

function sendSnapshot(snapshot: ProjectSnapshot): void {
  (mainWindow?.webview.rpc as { send?: { snapshot(value: ProjectSnapshot): void } } | undefined)
    ?.send?.snapshot(snapshot);
}

function sendAgentTask(task: DashboardAgentTask): void {
  (mainWindow?.webview.rpc as { send?: { agentTask(value: DashboardAgentTask): void } } | undefined)
    ?.send?.agentTask(task);
}

function openCommandPalette(): void {
  (
    mainWindow?.webview.rpc as
      | { send?: { openCommandPalette(value: {}): void } }
      | undefined
  )?.send?.openCommandPalette({});
}

function reloadApp(): void {
  mainWindow?.webview.executeJavascript("window.location.reload()");
}

const trustStore = new TrustStore(join(Utils.paths.userData, "trusted-projects-v1.json"));
const projectRegistry = new ProjectRegistry(join(Utils.paths.userData, "projects-v1.json"));
const appSettingsStore = new AppSettingsStore(join(Utils.paths.userData, "settings-v1.json"));
const initialAppSettings = await appSettingsStore.get();
process.env.DASH_BORED_AGENT = initialAppSettings.dashBoredAgent;
const dashboardAgentHarness = new DashboardAgentHarness({ onTask: sendAgentTask });
const runtime = new ProjectRuntime({
  trustStore,
  onSnapshot(snapshot) {
    sendSnapshot(snapshot);
    if (snapshot.configPath) dashboardAgentHarness.markDashboardChanged(snapshot.configPath);
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
  return dashboardAgentHarness.launch({
    command: settings.dashBoredAgent,
    prompt,
    projectRoot: sourceLocation.projectRoot,
    componentPath: locator,
    configPath: source.configPath,
    request: userPrompt,
  });
}

function validatedInsertionPath(
  source: DashboardConfigSource,
  target: DashboardInsertionTarget,
): string {
  const invalid = (): never => {
    throw new CoreError(
      "COMPONENT_INSERTION_TARGET_INVALID",
      "That component insertion point is no longer present. Reopen the dashboard editor and try again.",
    );
  };
  return resolveDashboardInsertionPath(source, target) ?? invalid();
}

async function runComponentCreationAgent(
  configPath: string,
  target: DashboardInsertionTarget,
  userPrompt: string,
) {
  const source = await runtime.getDashboardConfigSource(configPath);
  const sourceLocation = await resolveProjectLocation(source.configPath);
  const insertionPath = validatedInsertionPath(source, target);
  const locator = `${source.configPath}#${insertionPath}`;
  const settings = await appSettingsStore.get();
  const prompt = buildComponentCreationAgentPrompt({
    projectRoot: sourceLocation.projectRoot,
    configPath: source.configPath,
    insertionPath,
  }, userPrompt);
  return dashboardAgentHarness.launch({
    command: settings.dashBoredAgent,
    prompt,
    projectRoot: sourceLocation.projectRoot,
    componentPath: locator,
    configPath: source.configPath,
    request: userPrompt,
  });
}

async function runDiagnosticsAgent() {
  const snapshot = runtime.getSnapshot();
  if (!snapshot.projectRoot || !snapshot.configPath) {
    throw new CoreError("PROJECT_NOT_LOADED", "Open a dashboard before asking an agent to fix its diagnostics.");
  }
  if (snapshot.diagnostics.length === 0) {
    throw new CoreError("DIAGNOSTICS_NOT_FOUND", "This dashboard has no current diagnostics to fix.");
  }
  const sourceLocation = await resolveProjectLocation(snapshot.configPath);
  const locator = `${snapshot.configPath}#diagnostics`;
  const settings = await appSettingsStore.get();
  const prompt = buildDiagnosticsAgentPrompt({
    projectRoot: sourceLocation.projectRoot,
    configPath: snapshot.configPath,
    diagnostics: snapshot.diagnostics,
  });
  return dashboardAgentHarness.launch({
    command: settings.dashBoredAgent,
    prompt,
    projectRoot: sourceLocation.projectRoot,
    componentPath: locator,
    configPath: snapshot.configPath,
    request: "Fix dashboard configuration diagnostics.",
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
      runComponentCreationAgent: ({ configPath, target, prompt }) =>
        runComponentCreationAgent(configPath, target, prompt),
      runDiagnosticsAgent: (_request) => runDiagnosticsAgent(),
      getDashboardAgentTasks: () => dashboardAgentHarness.list(),
      getDashboardAgentDiff: ({ taskId }) => getDashboardAgentDiff(taskId),
      stopDashboardAgentTask: ({ taskId }) => dashboardAgentHarness.stop(taskId),
      writeDashboardAgentTerminal: ({ taskId, input }) => dashboardAgentHarness.writeTerminal(taskId, input),
      resizeDashboardAgentTerminal: ({ taskId, cols, rows }) => dashboardAgentHarness.resizeTerminal(taskId, cols, rows),
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
      openProcessTerminal: ({ nodeId }) => runtime.openProcessTerminal(nodeId),
      runProcessQuickAction: ({ nodeId }) => runtime.runProcessQuickAction(nodeId),
      writeProcessTerminal: ({ nodeId, input }) => runtime.writeProcessTerminal(nodeId, input),
      resizeProcessTerminal: ({ nodeId, cols, rows }) => runtime.resizeProcessTerminal(nodeId, cols, rows),
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
      {
        label: "Reload App",
        action: "reload-app",
        accelerator: "CommandOrControl+Shift+R",
      },
    ],
  },
]);

ApplicationMenu.on("application-menu-clicked", (event) => {
  const action = (event as { data?: { action?: unknown } }).data?.action;
  if (action === "open-command-palette") openCommandPalette();
  if (action === "reload-app") reloadApp();
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
  void Promise.all([runtime.close(), dashboardAgentHarness.close()]).finally(() => {
    Utils.quit(0);
  });
});
