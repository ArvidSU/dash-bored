import { DIRECT_UNSIGNED_UPDATES_VERIFIED, applyVerifiedNativeUpdate } from "../updates/native-updater";
import { UpdateCoordinator } from "../updates/coordinator";
import { bundledInstallation, openVerifiedDmg } from "../updates/installation";
import { runMigrationAgent } from "../updates/migration-agent";
import { atomicJson, updateDirectory, getUpdateSettings } from "../updates/storage";
import { watch as watchThemes } from "node:fs";
import { mkdir as mkdirThemes } from "node:fs/promises";
import { loadApplicationThemeCatalog, personalThemesDirectory } from "../core/themes";
import Electrobun, {
  ApplicationMenu,
  BrowserView,
  BrowserWindow,
  Updater,
  Utils,
} from "electrobun/main";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { CoreError, ProjectRuntime, TrustStore, resolveProjectLocation } from "../core/index";
import { resolveEnvironment } from "../core/environment";
import type {
  Diagnostic,
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
import { keyboardShortcutAccelerator } from "../shared/keyboard-shortcut";
import { AppSettingsStore, resolveDashBoredAgent } from "./app-settings";
import { DashboardAgentHarness } from "./component-agent";
import { assertAgentAvailable } from "./agent-preflight";
import { deleteRegisteredProject, getProjectDeletionPreview } from "./project-deletion";
import { getRegisteredProjectOutline } from "./project-outline";
import { ProjectRegistry } from "./project-registry";
import { configureBundledToolEnvironment } from "./tool-environment";
import {
  installedCliPath,
  installedSkillPath,
  repairInstalledTools as repairInstalledToolConflicts,
  updateInstalledTools,
} from "./installed-tools";
import { DashboardSetupSupervisor, findSetupNode } from "./dashboard-setup";

const bundledTools = configureBundledToolEnvironment(import.meta.dirname);

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

const installedToolDiagnostics: Diagnostic[] = [];
const checkedSkillRoots = new Set<string>();
function withInstalledToolDiagnostics(snapshot: ProjectSnapshot): ProjectSnapshot {
  return { ...snapshot, diagnostics: [...snapshot.diagnostics, ...installedToolDiagnostics] };
}

async function refreshInstalledTools(options: Parameters<typeof updateInstalledTools>[0]): Promise<Diagnostic[]> {
  try {
    return await updateInstalledTools(options);
  } catch (error) {
    // A refresh is maintenance work; an unexpected enumeration or path error
    // must remain visible without preventing the dashboard from opening.
    return [{
      severity: "warning",
      code: "INSTALLED_TOOL_UPDATE_FAILED",
      file: options.homeDirectory,
      message: `Could not refresh installed dash-bored tools: ${error instanceof Error ? error.message : String(error)}`,
    }];
  }
}

function installedSkillRootFromDiagnostic(file: string): string | null {
  const resolvedFile = resolve(file);
  const root = resolve(resolvedFile, "..", "..", "..");
  return installedSkillPath(root) === resolvedFile ? root : null;
}

function replaceInstalledToolDiagnostics(paths: readonly string[], next: readonly Diagnostic[]): void {
  const replaced = new Set(paths.map((path) => resolve(path)));
  const retained = installedToolDiagnostics.filter((diagnostic) =>
    diagnostic.file === undefined || !replaced.has(resolve(diagnostic.file)),
  );
  installedToolDiagnostics.splice(0, installedToolDiagnostics.length, ...retained, ...next);
}

async function repairInstalledToolConflictsForUser(): Promise<ProjectSnapshot> {
  const home = resolve(homedir());
  const cliTarget = installedCliPath(home);
  const globalSkillTarget = installedSkillPath(home);
  let repairCli = false;
  let repairGlobalSkill = false;
  const projectRoots = new Set<string>();

  for (const diagnostic of installedToolDiagnostics) {
    if (diagnostic.code !== "INSTALLED_TOOL_UPDATE_CONFLICT" || !diagnostic.file) continue;
    const file = resolve(diagnostic.file);
    if (file === cliTarget) {
      repairCli = true;
      continue;
    }
    const skillRoot = installedSkillRootFromDiagnostic(file);
    if (skillRoot === null) continue;
    if (skillRoot === home || file === globalSkillTarget) repairGlobalSkill = true;
    else projectRoots.add(skillRoot);
  }

  if (!repairCli && !repairGlobalSkill && projectRoots.size === 0) {
    throw new CoreError(
      "INSTALLED_TOOL_CONFLICTS_NOT_FOUND",
      "There are no current installed-tool conflicts to repair.",
    );
  }
  const cliPath = bundledTools
    ? join(bundledTools.toolsDirectory, process.platform === "win32" ? "dash-bored.exe" : "dash-bored")
    : undefined;
  if (repairCli && cliPath === undefined) {
    throw new CoreError(
      "INSTALLED_TOOL_REPAIR_UNAVAILABLE",
      "The bundled dash-bored CLI is unavailable, so the conflicting link was left untouched.",
    );
  }

  const repairedPaths = [
    ...(repairGlobalSkill ? [globalSkillTarget] : []),
    ...[...projectRoots].map((root) => installedSkillPath(root)),
    ...(repairCli ? [cliTarget] : []),
  ];
  const diagnostics = await repairInstalledToolConflicts({
    cliPath,
    homeDirectory: home,
    repairGlobalSkill,
    repairCli,
    projectRoots: [...projectRoots],
    moveToTrash: async (path) => await Utils.moveToTrash(path),
  });
  replaceInstalledToolDiagnostics(repairedPaths, diagnostics);
  return withInstalledToolDiagnostics(runtime.getSnapshot());
}

function sendSnapshot(snapshot: ProjectSnapshot): void {
  (mainWindow?.webview.rpc as { send?: { snapshot(value: ProjectSnapshot): void } } | undefined)
    ?.send?.snapshot(withInstalledToolDiagnostics(snapshot));
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
const registeredRoots = [...new Set((await projectRegistry.list().catch((error: unknown) => {
  console.error("Could not read projects for installed-tool updates.", error);
  return [];
})).map((project) => project.projectRoot))];
installedToolDiagnostics.push(...await refreshInstalledTools({
  ...(bundledTools ? { cliPath: join(bundledTools.toolsDirectory, process.platform === "win32" ? "dash-bored.exe" : "dash-bored") } : {}),
  projectRoots: registeredRoots,
}));
for (const root of registeredRoots) checkedSkillRoots.add(root);
const appSettingsStore = new AppSettingsStore(join(Utils.paths.userData, "settings-v1.json"));
const initialAppSettings = await appSettingsStore.get();
try {
  await mkdirThemes(personalThemesDirectory(), { recursive: true });
  let themeWatchTimer: ReturnType<typeof setTimeout> | undefined;
  const themeWatcher = watchThemes(personalThemesDirectory(), { recursive: true }, (_event, filename) => {
    if (filename && String(filename).split(/[\\/]/).some((part) => part === '.git' || part.startsWith('.theme-'))) return;
    clearTimeout(themeWatchTimer);
    themeWatchTimer = setTimeout(() => {
      void loadApplicationThemes().then((catalog) => {
        (mainWindow?.webview.rpc as { send?: { themes(value: typeof catalog): void } } | undefined)?.send?.themes(catalog);
      }).catch((error) => console.error('Could not reload personal themes.', error));
    }, 150);
  });
  themeWatcher.on('error', (error) => console.error('Personal theme watcher unavailable; reload to refresh themes.', error));
} catch (error) { console.error('Personal theme watcher unavailable; reload to refresh themes.', error); }

let publishedEnvironment: Record<string, string> = initialAppSettings.dashBoredAgent === null
  ? {}
  : { DASH_BORED_AGENT: initialAppSettings.dashBoredAgent };
const dashboardAgentHarness = new DashboardAgentHarness({ onTask: sendAgentTask });
const runtime = new ProjectRuntime({
  trustStore,
  isConfigRegistered: async (configPath) => (await projectRegistry.list()).some((project) => project.configPath === configPath),
  getPublishedEnvironment: () => publishedEnvironment,
  onSnapshot(snapshot) {
    sendSnapshot(snapshot);
    if (snapshot.projectRoot && !checkedSkillRoots.has(snapshot.projectRoot)) {
      checkedSkillRoots.add(snapshot.projectRoot);
      void refreshInstalledTools({ projectRoots: [snapshot.projectRoot], includeGlobal: false }).then((diagnostics) => {
        installedToolDiagnostics.push(...diagnostics);
        if (diagnostics.length) sendSnapshot(runtime.getSnapshot());
      });
    }
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

let nativeUpdateApplying = false;
const updateCoordinator: UpdateCoordinator = new UpdateCoordinator({
  listDashboards: async () => [...new Set([...(await projectRegistry.list()).map(p => p.configPath), ...runtime.getSnapshot().configPath ? [runtime.getSnapshot().configPath!] : []])],
  install: async (receipt, method) => {
    if (runtime.getSnapshot().processes.some(p => p.phase === "running" || p.phase === "stopping")
      || dashboardAgentHarness.list().some(t => t.process.phase === "running" || t.process.phase === "stopping")) throw new Error("Finish running terminals and agent work before installation. No work has been stopped.");
    await bundledInstallation(bundledTools ? join(bundledTools.toolsDirectory, 'dash-bored') : process.execPath);
    if (DIRECT_UNSIGNED_UPDATES_VERIFIED && method !== "dmg") {
      try { await applyVerifiedNativeUpdate(Updater, receipt, updateDirectory(), fetch, async () => {
        if (await updateCoordinator.cancelled(receipt)) throw new Error("Update continuation cancelled before restart.");
        if (runtime.getSnapshot().processes.some(p => p.phase === 'running' || p.phase === 'stopping')
          || dashboardAgentHarness.list().some(t => t.process.phase === 'running' || t.process.phase === 'stopping')) throw new Error('New work started while staging. Finish it before restarting.');
        nativeUpdateApplying = true;
      }); }
      finally { nativeUpdateApplying = false; }
    } else await openVerifiedDmg(receipt);
  },
  migrate: async (configPath, receipt, report, snapshotReady) => {
    if (runtime.getSnapshot().configPath === configPath && runtime.getSnapshot().processes.some(p => p.phase === 'running' || p.phase === 'stopping')
      || dashboardAgentHarness.list().some(t => t.configPath === configPath && (t.process.phase === 'running' || t.process.phase === 'stopping'))) throw new Error('Finish running dashboard work before migration.');
    const installation = await bundledInstallation(bundledTools ? join(bundledTools.toolsDirectory, 'dash-bored') : process.execPath);
    return runMigrationAgent({ directory: updateDirectory(), configPath, receipt, report, snapshotReady,
      cliPath: installation.cliPath, command: await resolveAgentCommand(configPath, await appSettingsStore.get()),
      trustStore, harness: dashboardAgentHarness, stop: id => dashboardAgentHarness.stop(id),
      cancelled: () => updateCoordinator.cancelled(receipt),
    });
  },
});
Updater.onStatusChange(entry => {
  if (entry.status === 'error') {
    updateCoordinator.problem(entry.message);
    void updateCoordinator.recordInstallationProblem(entry.message).catch(() => undefined);
  }
});
let updateOperation: Promise<unknown> | null = null;
async function handleUpdateAction(action: import("../shared/updates").UpdateAction) {
  if (action.type === 'prepare' || action.type === 'migrate' || action.type === 'install') {
    if (action.type === 'prepare') await bundledInstallation(bundledTools ? join(bundledTools.toolsDirectory, 'dash-bored') : process.execPath);
    if (updateOperation) throw new Error('An update operation is already running.');
    updateOperation = updateCoordinator.action(action).catch(error => console.error('Update operation needs recovery:', error)).finally(() => { updateOperation = null; });
    return updateCoordinator.state();
  }
  return updateCoordinator.action(action);
}

async function loadApplicationThemes() {
  const current = runtime.getSnapshot();
  const registered = await projectRegistry.list();
  const candidates = new Map<string, { configPath: string; label?: string | null }>();
  for (const project of registered) candidates.set(project.configPath, { configPath: project.configPath, label: project.dashboardName });
  if (current.configPath) {
    candidates.set(current.configPath, { configPath: current.configPath, label: current.dashboardName });
  }
  const sources = (await Promise.all([...candidates.values()].map(async (candidate) => {
    try {
      const location = await resolveProjectLocation(candidate.configPath);
      return { ...candidate, configDirectory: location.configDirectory };
    } catch {
      return null;
    }
  }))).filter((source): source is NonNullable<typeof source> => source !== null);
  return loadApplicationThemeCatalog(sources);
}

async function resolveAgentCommand(configPath: string, settings: Awaited<ReturnType<AppSettingsStore["get"]>>): Promise<string> {
  if (settings.dashBoredAgent !== null) return settings.dashBoredAgent;
  return resolveDashBoredAgent(settings.dashBoredAgent, await resolveEnvironment(configPath, publishedEnvironment));
}

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
  const command = await resolveAgentCommand(source.configPath, settings);
  const prompt = buildComponentAgentPrompt({
    projectRoot: sourceLocation.projectRoot,
    configPath: source.configPath,
    componentPath: locator,
    componentId: node.id,
    componentReference: node.component,
  }, userPrompt);
  return new DashboardSetupSupervisor({ runtime, harness: dashboardAgentHarness, command,
    location: sourceLocation, preflight: assertAgentAvailable }).launchRequest({
    prompt,
    purpose: "edit",
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
  const command = await resolveAgentCommand(source.configPath, settings);
  const prompt = buildComponentCreationAgentPrompt({
    projectRoot: sourceLocation.projectRoot,
    configPath: source.configPath,
    insertionPath,
  }, userPrompt);
  return new DashboardSetupSupervisor({ runtime, harness: dashboardAgentHarness, command,
    location: sourceLocation, preflight: assertAgentAvailable }).launchRequest({
    prompt,
    purpose: "edit",
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
  const command = await resolveAgentCommand(snapshot.configPath, settings);
  const prompt = buildDiagnosticsAgentPrompt({
    projectRoot: sourceLocation.projectRoot,
    configPath: snapshot.configPath,
    diagnostics: snapshot.diagnostics,
  });
  return new DashboardSetupSupervisor({ runtime, harness: dashboardAgentHarness, command,
    location: sourceLocation, preflight: assertAgentAvailable }).launchRequest({
    prompt,
    purpose: "edit",
    componentPath: locator,
    configPath: snapshot.configPath,
    request: "Fix dashboard configuration diagnostics.",
  });
}

async function setupDashboardWithAgent(nodeId: string) {
  const snapshot = runtime.getSnapshot();
  const session = runtime.getSessionToken();
  if (!snapshot.projectRoot || !snapshot.configPath || !snapshot.tree) {
    throw new CoreError("PROJECT_NOT_LOADED", "Open a dashboard before running its setup agent.");
  }
  if (!snapshot.trusted) {
    throw new CoreError("PROJECT_UNTRUSTED", "Trust this project before running its setup agent.");
  }
  const node = findSetupNode(runtime, nodeId);
  if (!node) {
    throw new CoreError("DASHBOARD_SETUP_NODE_INVALID", "That setup action is no longer present in the active dashboard.");
  }
  const configPath = node.sourceConfigPath ?? snapshot.configPath;
  if (dashboardAgentHarness.list().some((task) => task.configPath === configPath
    && task.purpose !== undefined
    && (task.process.phase === "running" || task.process.phase === "stopping"
      || task.validation?.status === "checking" || task.validation?.status === "repairing"))) {
    throw new CoreError("DASHBOARD_SETUP_RUNNING", "Setup is already active for this dashboard. Open Agent work to view or stop it.");
  }
  const sourceLocation = await resolveProjectLocation(configPath);
  const settings = await appSettingsStore.get();
  const command = await resolveAgentCommand(configPath, settings);
  if (runtime.getSessionToken() !== session) throw new CoreError("DASHBOARD_SETUP_STALE", "The active dashboard changed. Run setup from its current panel.");
  return new DashboardSetupSupervisor({ runtime, harness: dashboardAgentHarness, command, location: sourceLocation, preflight: assertAgentAvailable }).launch(node);
}

async function chooseAndLoadProject(): Promise<ProjectSnapshot> {
  const paths = await Utils.openFileDialog({
    startingFolder: homedir(),
    canChooseFiles: false,
    canChooseDirectory: true,
    allowsMultipleSelection: false,
  });
  const selected = paths[0];
  if (!selected) return withInstalledToolDiagnostics(runtime.getSnapshot());
  await runtime.load(selected, { inputKind: "auto" });
  runtime.watch();
  return withInstalledToolDiagnostics(runtime.getSnapshot());
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
  return withInstalledToolDiagnostics(runtime.getSnapshot());
}

const dashboardRPC = BrowserView.defineRPC<DashboardRPC>({
  maxRequestTime: 65_000,
  handlers: {
    requests: {
      getSnapshot: () => withInstalledToolDiagnostics(runtime.getSnapshot()),
      getThemes: () => loadApplicationThemes(),
      getUpdateState: async () => ({ ...await updateCoordinator.state(), directInstallAvailable: DIRECT_UNSIGNED_UPDATES_VERIFIED && (await Updater.localInfo.channel()) === "canary" }),
      updateAction: action => handleUpdateAction(action),
      getAppSettings: () => appSettingsStore.get(),
      updateAppSettings: async (settings) => {
        const updated = await appSettingsStore.update(settings);
        publishedEnvironment = updated.dashBoredAgent === null
          ? {}
          : { DASH_BORED_AGENT: updated.dashBoredAgent };
        setApplicationMenu(updated);
        await runtime.refreshEnvironment();
        return updated;
      },
      runComponentAgent: ({ nodeId, prompt }) => runComponentAgent(nodeId, prompt),
      runComponentCreationAgent: ({ configPath, target, prompt }) =>
        runComponentCreationAgent(configPath, target, prompt),
      runDiagnosticsAgent: (_request) => runDiagnosticsAgent(),
      repairInstalledTools: (_request) => repairInstalledToolConflictsForUser(),
      setupDashboardWithAgent: ({ nodeId }) => setupDashboardWithAgent(nodeId),
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
        }).then(withInstalledToolDiagnostics),
      trustProject: () => runtime.trust().then(withInstalledToolDiagnostics),
      revokeTrust: () => runtime.revoke().then(withInstalledToolDiagnostics),
      reloadProject: () => runtime.reload().then(withInstalledToolDiagnostics),
      getDashboardConfigSource: ({ configPath }) => runtime.getDashboardConfigSource(configPath),
      validateDashboardDraft: ({ config, configPath }) => runtime.validateDashboardDraft(config, configPath),
      validateComponentProps: ({ reference, props }) => runtime.validateComponentProps(reference, props),
      saveDashboardConfig: ({ config, expectedConfigRevision, configPath }) =>
        runtime.saveDashboardConfig(config, expectedConfigRevision, configPath).then(withInstalledToolDiagnostics),
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

function setApplicationMenu(settings: Awaited<ReturnType<AppSettingsStore["get"]>>): void {
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
        ...(keyboardShortcutAccelerator(settings.commandPaletteShortcut)
          ? { accelerator: keyboardShortcutAccelerator(settings.commandPaletteShortcut) }
          : {}),
      },
      {
        label: "Reload App",
        action: "reload-app",
        ...(keyboardShortcutAccelerator(settings.actionShortcuts["app:reload"])
          ? { accelerator: keyboardShortcutAccelerator(settings.actionShortcuts["app:reload"]) }
          : {}),
      },
    ],
  },
  ]);
}

setApplicationMenu(initialAppSettings);

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
  // Native apply already rejected running work. Its helper must receive quit
  // approval before any shutdown; the ordinary async cleanup veto would abort it.
  if (nativeUpdateApplying) { event.response = { allow: true }; return; }
  if (cleanupStarted) return;
  cleanupStarted = true;
  event.response = { allow: false };
  void Promise.all([runtime.close(), dashboardAgentHarness.close()]).finally(() => {
    Utils.quit(0);
  });
});

// Release-only continuation: a development checkout must never consume a user's
// persisted release authorization or impersonate the installed release host.
if ((await Updater.localInfo.channel()) === 'canary') {
  await atomicJson(join(updateDirectory(), 'app-host.json'), { pid: process.pid });
  updateOperation = updateCoordinator.reconcile().catch(error => updateCoordinator.problem(error)).finally(() => { updateOperation = null; });
  const scheduledCheck = async () => {
    if ((await getUpdateSettings(updateDirectory())).automaticChecks && !updateOperation) await updateCoordinator.check();
  };
  void updateOperation.then(scheduledCheck).catch(error => console.error('Update check failed:', error));
  setInterval(() => { void scheduledCheck().catch(error => console.error('Update check failed:', error)); }, 24 * 60 * 60_000);
}
