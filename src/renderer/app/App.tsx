import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ReactNode } from "react";
import type {
  AppSettings,
  ComponentCatalogItem,
  DashboardAgentTask,
  DashboardConfig,
  ProcessSnapshot,
  ProjectDeletionPreview,
  ProjectListItem,
  ProjectSnapshot,
  ProjectTarget,
  ResolvedComponentNode,
} from "../../shared/contracts";
import { componentPath } from "../../shared/component-agent";
import {
  keyboardEventMatchesShortcut,
  keyboardShortcutLabel,
} from "../../shared/keyboard-shortcut";
import {
  buildApplicationActions,
  buildNodeFocusActions,
} from "../lib/action-providers";
import type { AppView } from "../lib/action-providers";
import { ActionExecutor, ActionRegistry } from "../lib/actions";
import type { PaletteAction } from "../lib/actions";
import { writeClipboardText } from "../lib/clipboard";
import { CommandPalette } from "../panels/CommandPalette";
import { ComponentVisibilityContext } from "../composition/ComponentCompositor";
import { AppShell, type ProjectOutlineState } from "./app-shell";
import type { DashboardOutlineNodeAction } from "../composition/DashboardOutlineTree";
import { AgentActivity, activeDashboardAgentTaskCount } from "../panels/AgentActivity";
import {
  DashboardEditor,
  DashboardEditorToolbar,
} from "../composition/DashboardEditor";
import {
  nodeAtPath,
  nodePathFromSourcePath,
  nodePathById,
  removeNode,
  updateNodeProps,
  updateTiledSplitRatio,
  type InsertionTarget,
  type NodePath,
} from "../composition/dashboard-editor";
import type { LayoutBranch } from "../lib/component-children";
import { buildCompositionPreviewTree } from "../composition/composition-preview";
import { planCompositionOperation } from "../composition/composition-operation";
import { CompositionFlyout } from "../composition/CompositionFlyout";
import type { ComponentPointerDragPoint } from "../composition/CompositionFlyout";
import { useLocalComponents } from "../render/local-components";
import { host } from "../lib/rpc-client";
import { resolveVirtualRoot } from "../lib/virtual-root";
import {
  CompositionContext,
  type CompositionDragPayload,
  type CompositionDropZone,
  type CompositionTarget,
} from "../composition/composition-context";
import { createCompositionTargets } from "../composition/composition-targets";
import { useCompositionInteractionController } from "../composition/composition-interaction-controller";
import { useDashboardViewState } from "./use-dashboard-view-state";
import {
  basename,
  dashboardKey,
  errorMessage,
  findResolvedConfigRoot,
  linkedComponentIdNamespace,
  outlineError,
  rememberProject,
  replaceDashboardAgentTask,
  replaceProcess,
  starterDashboardAgentTask,
  EMPTY_SPLIT_RATIO_OVERRIDES,
  type ActionNotice,
  type DashboardCompositionSource,
  type DashboardEditSession,
} from "./app-utils";
import { isRootCompositionTarget } from "../composition/composition-labels";
import { NodeRenderer, useComponentUpdateBatch } from "../render/NodeRenderer";
import { Diagnostics } from "../panels/DiagnosticsPanel";
import { TrustPanel } from "../panels/TrustPanel";
import { EmptyProject } from "../panels/EmptyProject";
import { SettingsPanel } from "../panels/SettingsPanel";
import { AppDialogs } from "./AppDialogs";

export function App(): ReactNode {
  const [snapshot, setSnapshot] = useState<ProjectSnapshot | null>(null);
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [appSettings, setAppSettings] = useState<AppSettings>({
    dashBoredAgent: "codex exec",
    favoriteActionIds: [],
    commandPaletteShortcut: "Mod+K",
    actionShortcuts: { "app:reload": "Mod+Shift+R" },
  });
  const [loading, setLoading] = useState(true);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<ActionNotice | null>(null);
  const [dashboardAgentTasks, setDashboardAgentTasks] = useState<DashboardAgentTask[]>([]);
  const [agentActivityOpen, setAgentActivityOpen] = useState(false);
  const knownDashboardAgentTaskIds = useRef(new Set<string>());
  const pendingProcessEvents = useRef(new Map<string, ProcessSnapshot>());
  const nextActionNoticeId = useRef(0);
  const [sidebarExpanded, setSidebarExpanded] = useState(false);
  const [expandedProjectOutlines, setExpandedProjectOutlines] = useState<Record<string, boolean>>({});
  const [projectOutlines, setProjectOutlines] = useState<Record<string, ProjectOutlineState>>({});
  const [activeView, setActiveView] = useState<AppView>("dashboard");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const compositionInteraction = useCompositionInteractionController();
  const {
    libraryOpen: componentLibraryOpen,
    dragging: compositionDrag,
    pointer: compositionPointer,
    selectedTarget: compositionTarget,
    dialog: compositionDialog,
    removePath: compositionRemovePath,
  } = compositionInteraction;
  const [compositionSource, setCompositionSource] = useState<DashboardCompositionSource | null>(null);
  const [editSession, setEditSession] = useState<DashboardEditSession | null>(null);
  const snapshotRef = useRef<ProjectSnapshot | null>(null);
  const editSessionRef = useRef<DashboardEditSession | null>(null);
  snapshotRef.current = snapshot;
  editSessionRef.current = editSession;
  const [savingDraft, setSavingDraft] = useState(false);
  const [discardConfirmation, setDiscardConfirmation] = useState<{
    message: string;
    continueAction: () => void;
  } | null>(null);
  const [deletionDialog, setDeletionDialog] = useState<{
    project: ProjectListItem;
    preview: ProjectDeletionPreview;
    removeFiles: boolean;
  } | null>(null);
  const compositionPointerFrame = useRef<number | null>(null);
  const pendingCompositionPointer = useRef<{
    payload: CompositionDragPayload;
    point: ComponentPointerDragPoint;
  } | null>(null);
  const [agentDialog, setAgentDialog] = useState<ResolvedComponentNode | null>(null);
  const localComponents = useLocalComponents(
    snapshot?.components ?? [],
    snapshot?.configPath ?? null,
  );
  const componentUpdateBatch = useComponentUpdateBatch(
    snapshot?.tree,
    snapshot?.configPath,
    snapshot?.trusted,
    localComponents,
  );
  const actionRegistry = useMemo(() => new ActionRegistry(), []);
  const componentActions = useSyncExternalStore(
    actionRegistry.subscribe,
    actionRegistry.getSnapshot,
  );
  const actionsByIdRef = useRef<ReadonlyMap<string, PaletteAction>>(new Map());
  const actionExecutor = useMemo(
    () => new ActionExecutor((id) => actionsByIdRef.current.get(id)),
    [],
  );
  const runningActionIds = useSyncExternalStore(
    actionExecutor.subscribe,
    actionExecutor.getSnapshot,
  );

  useEffect(() => () => {
    if (compositionPointerFrame.current !== null) {
      cancelAnimationFrame(compositionPointerFrame.current);
    }
  }, []);

  useEffect(() => {
    let active = true;
    const unsubscribe = host.subscribe((event) => {
      if (!active) return;
      if (event.type === "snapshot") {
        setSnapshot(event.snapshot);
        const starter = event.snapshot.processes
          .map((process) => starterDashboardAgentTask(event.snapshot.configPath, process))
          .find((task): task is DashboardAgentTask => task !== null);
        if (starter) setDashboardAgentTasks((current) => replaceDashboardAgentTask(current, starter));
        setProjects((current) => rememberProject(current, event.snapshot));
      } else if (event.type === "process") {
        pendingProcessEvents.current.set(event.process.id, event.process);
        setSnapshot((current) =>
          current ? replaceProcess(current, event.process) : current,
        );
        if (event.process.id === "setup-dashboard-with-agent") {
          const starter = starterDashboardAgentTask(snapshotRef.current?.configPath, event.process);
          setDashboardAgentTasks((current) => starter
            ? replaceDashboardAgentTask(current, starter)
            : current.filter((task) => task.id !== event.process.id));
          if (event.process.phase === "running" || event.process.phase === "stopping") {
            setAgentActivityOpen(true);
          }
        }
      } else if (event.type === "agent-task") {
        setDashboardAgentTasks((current) => replaceDashboardAgentTask(current, event.task));
        if (!knownDashboardAgentTaskIds.current.has(event.task.id)) {
          knownDashboardAgentTaskIds.current.add(event.task.id);
          if (event.task.process.phase === "running" || event.task.process.phase === "stopping") {
            setAgentActivityOpen(true);
          }
        }
      } else {
        setPaletteOpen(true);
      }
    });

    void Promise.all([host.getSnapshot(), host.listProjects(), host.getAppSettings(), host.getDashboardAgentTasks()])
      .then(([initialSnapshot, initialProjects, initialSettings, initialAgentTasks]) => {
        if (!active) return;
        const snapshotWithPendingProcesses = [...pendingProcessEvents.current.values()]
          .reduce(replaceProcess, initialSnapshot);
        setSnapshot(snapshotWithPendingProcesses);
        const starter = snapshotWithPendingProcesses.processes
          .map((process) => starterDashboardAgentTask(snapshotWithPendingProcesses.configPath, process))
          .find((task): task is DashboardAgentTask => task !== null);
        setProjects(rememberProject(initialProjects, initialSnapshot));
        setAppSettings(initialSettings);
        setDashboardAgentTasks((current) => {
          const withStarter = starter ? replaceDashboardAgentTask(initialAgentTasks, starter) : initialAgentTasks;
          return current.reduce(replaceDashboardAgentTask, withStarter);
        });
        knownDashboardAgentTaskIds.current = new Set(initialAgentTasks.map((task) => task.id));
      })
      .catch((error: unknown) => {
        if (active) setActionError(errorMessage(error));
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    const snapshotConfigPath = snapshot?.configPath;
    if (!snapshotConfigPath) return;
    setProjectOutlines((current) => ({
      ...current,
      [snapshotConfigPath]: {
        tree: snapshot.tree,
        loading: false,
        error: outlineError(snapshot),
      },
    }));
  }, [snapshot?.configPath, snapshot?.revision, snapshot?.tree, snapshot?.diagnostics]);

  useEffect(() => {
    if (!editSession) return;
    const source = JSON.stringify(editSession.draft);
    let cancelled = false;
    const timer = setTimeout(() => {
      void host.validateDashboardDraft(editSession.draft, editSession.configPath)
        .then((validation) => {
          if (cancelled) return;
          setEditSession((current) =>
            current && JSON.stringify(current.draft) === source
              ? { ...current, validation }
              : current,
          );
        })
        .catch((error: unknown) => {
          if (!cancelled) setActionError(errorMessage(error));
        });
    }, 140);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [editSession?.draft]);

  useEffect(() => {
    function openFromKeyboard(event: globalThis.KeyboardEvent): void {
      if (event.repeat) return;
      const target = event.target;
      if (
        target instanceof HTMLElement
        && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
      ) return;
      if (keyboardEventMatchesShortcut(event, appSettings.commandPaletteShortcut)) {
        event.preventDefault();
        setPaletteOpen(true);
        return;
      }
      const actionId = Object.entries(appSettings.actionShortcuts)
        .find(([, shortcut]) => keyboardEventMatchesShortcut(event, shortcut))?.[0];
      if (actionId) {
        event.preventDefault();
        void executePaletteAction(actionId);
      }
    }
    window.addEventListener("keydown", openFromKeyboard);
    return () => window.removeEventListener("keydown", openFromKeyboard);
  }, [appSettings.actionShortcuts, appSettings.commandPaletteShortcut]);

  useEffect(() => {
    if (!actionNotice) return;
    const noticeId = actionNotice.id;
    const timeout = window.setTimeout(() => {
      setActionNotice((current) => current?.id === noticeId ? null : current);
    }, 5_000);
    return () => window.clearTimeout(timeout);
  }, [actionNotice?.id]);

  const processes = useMemo(
    () => new Map(snapshot?.processes.map((process) => [process.id, process]) ?? []),
    [snapshot?.processes],
  );
  const agentTasks = dashboardAgentTasks;
  const processesRef = useRef<ReadonlyMap<string, ProcessSnapshot>>(processes);
  processesRef.current = processes;

  async function perform(name: string, action: () => Promise<unknown>): Promise<void> {
    setPendingAction(name);
    setActionError(null);
    setActionNotice(null);
    try {
      await action();
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setPendingAction(null);
    }
  }

  function stopAgentTask(taskId: string): Promise<ProcessSnapshot> {
    if (taskId === "setup-dashboard-with-agent") return host.stopProcess(taskId);
    return host.stopDashboardAgentTask(taskId).then((task) => task.process);
  }

  function writeAgentTaskTerminal(taskId: string, input: string): Promise<ProcessSnapshot> {
    if (taskId === "setup-dashboard-with-agent") return host.writeProcessTerminal(taskId, input);
    return host.writeDashboardAgentTerminal(taskId, input).then((task) => task.process);
  }

  function resizeAgentTaskTerminal(taskId: string, cols: number, rows: number): Promise<ProcessSnapshot> {
    if (taskId === "setup-dashboard-with-agent") return host.resizeProcessTerminal(taskId, cols, rows);
    return host.resizeDashboardAgentTerminal(taskId, cols, rows).then((task) => task.process);
  }

  function showActionNotice(message: string): void {
    nextActionNoticeId.current += 1;
    setActionNotice({ id: nextActionNoticeId.current, message });
  }

  function resetCompositionUi(): void {
    compositionInteraction.reset();
    setCompositionSource(null);
  }

  function editSessionDirty(): boolean {
    return Boolean(editSession && JSON.stringify(editSession.original) !== JSON.stringify(editSession.draft));
  }

  function requireDiscard(message: string, continueAction: () => void): boolean {
    if (!editSessionDirty()) {
      setEditSession(null);
      resetCompositionUi();
      return true;
    }
    setDiscardConfirmation({ message, continueAction });
    return false;
  }

  async function chooseDashboard(): Promise<void> {
    await perform("choose", async () => {
      const nextSnapshot = await host.chooseProject();
      setProjects(rememberProject(await host.listProjects(), nextSnapshot));
      if (nextSnapshot.projectRoot) setActiveView("dashboard");
    });
  }

  async function addDashboard(): Promise<void> {
    if (editSession && !requireDiscard(
      "Discard the unsaved dashboard changes and add another dashboard?",
      () => void chooseDashboard(),
    )) return;
    await chooseDashboard();
  }

  async function openSelectedProject(project: ProjectListItem): Promise<void> {
    if (snapshot?.configPath === project.configPath) {
      setActiveView("dashboard");
      return;
    }
    await perform(`open:${dashboardKey(project)}`, async () => {
      await host.openProject(project);
      setActiveView("dashboard");
    });
  }

  async function selectProject(project: ProjectListItem): Promise<void> {
    if (editSession && editSession.configPath !== project.configPath && !requireDiscard(
      "Discard the unsaved dashboard changes and switch projects?",
      () => void openSelectedProject(project),
    )) return;
    await openSelectedProject(project);
  }

  function toggleProjectOutline(project: ProjectListItem): void {
    const key = dashboardKey(project);
    const closing = expandedProjectOutlines[key] === true;
    setExpandedProjectOutlines((current) => ({ ...current, [key]: !closing }));
    if (closing || snapshot?.configPath === project.configPath) return;

    setProjectOutlines((current) => ({
      ...current,
      [key]: {
        tree: current[key]?.tree ?? null,
        loading: true,
        error: null,
      },
    }));
    void host.getProjectOutline(project)
      .then((outline) => {
        setProjectOutlines((current) => ({
          ...current,
          [key]: {
            tree: outline.tree,
            loading: false,
            error: outlineError(outline),
          },
        }));
      })
      .catch((error: unknown) => {
        setProjectOutlines((current) => ({
          ...current,
          [key]: {
            tree: null,
            loading: false,
            error: errorMessage(error),
          },
        }));
      });
  }

  async function openDeletionDialog(
    project: ProjectListItem,
    skipDiscard = false,
  ): Promise<void> {
    if (
      !skipDiscard &&
      editSession?.configPath === project.configPath &&
      !requireDiscard(
        "Discard the unsaved dashboard changes and remove this dashboard?",
        () => void openDeletionDialog(project, true),
      )
    ) return;

    await perform(`preview-delete:${dashboardKey(project)}`, async () => {
      const preview = await host.getProjectDeletionPreview(project);
      setDeletionDialog({ project, preview, removeFiles: false });
    });
  }

  async function confirmDeletion(): Promise<void> {
    if (!deletionDialog) return;
    const request = deletionDialog;
    const wasActive = snapshot?.configPath === request.project.configPath;
    const activeProjectIndex = projects.findIndex(
      (project) => project.configPath === request.project.configPath,
    );
    setDeletionDialog(null);
    setPendingAction(`delete:${dashboardKey(request.project)}`);
    setActionError(null);
    try {
      await host.deleteProject(request.project, request.removeFiles);
      const remaining = await host.listProjects();
      setProjects(remaining);
      setEditSession((current) =>
        current?.configPath === request.project.configPath ? null : current,
      );
      if (editSession?.configPath === request.project.configPath) resetCompositionUi();
      forgetDashboard(request.project.configPath);
      setExpandedProjectOutlines((current) => {
        if (!Object.hasOwn(current, request.project.configPath)) return current;
        const next = { ...current };
        delete next[request.project.configPath];
        return next;
      });
      setProjectOutlines((current) => {
        if (!Object.hasOwn(current, request.project.configPath)) return current;
        const next = { ...current };
        delete next[request.project.configPath];
        return next;
      });

      if (wasActive) {
        setActiveView("dashboard");
        const nextIndex = Math.min(
          Math.max(activeProjectIndex, 0),
          Math.max(remaining.length - 1, 0),
        );
        const nextProject = remaining[nextIndex];
        if (nextProject) await host.openProject(nextProject);
      }
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setPendingAction(null);
    }
  }

  async function loadCompositionSource(): Promise<void> {
    if (!snapshot?.projectRoot || !snapshot.configPath) return;
    const focusedSource = virtualRoot?.node.sourceConfigPath;
    if (!focusedSource || focusedSource === snapshot.configPath) {
      setCompositionSource(null);
      return;
    }
    const request = {
      projectRoot: snapshot.projectRoot,
      activeDashboardPath: snapshot.configPath,
      focusedSourcePath: focusedSource,
      snapshotRevision: snapshot.revision,
      configPath: focusedSource,
    };
    setCompositionSource(null);
    try {
      const source = await host.getDashboardConfigSource(focusedSource);
      if (source.configPath !== request.configPath) return;
      setCompositionSource({
        ...request,
        config: source.config,
        componentCatalog: source.componentCatalog,
      });
    } catch (error) {
      setActionError(errorMessage(error));
    }
  }

  function toggleCompositionLibrary(): void {
    setAgentActivityOpen(false);
    compositionInteraction.toggleLibrary();
  }

  function toggleAgentActivity(): void {
    setAgentActivityOpen((open) => !open);
    if (!agentActivityOpen) compositionInteraction.closeLibrary();
  }

  async function ensureCurrentDashboardEdit(): Promise<DashboardEditSession | null> {
    if (!snapshot?.projectRoot || !snapshot.configPath) return null;
    if (editSession?.projectRoot === snapshot.projectRoot) {
      return editSession;
    }
    if (editSession) {
      setActionError("Finish the current dashboard draft before composing another dashboard.");
      return null;
    }

    let loaded: DashboardEditSession | null = null;
    await perform(`edit:${snapshot.configPath}`, async () => {
      const focusedSource = virtualRoot?.node.sourceConfigPath;
      const source = await host.getDashboardConfigSource(focusedSource);
      const validation = await host.validateDashboardDraft(source.config, source.configPath);
      loaded = {
        projectRoot: snapshot.projectRoot!,
        configPath: source.configPath,
        componentCatalog: source.componentCatalog,
        original: structuredClone(source.config),
        draft: structuredClone(source.config),
        expectedConfigRevision: source.configRevision,
        validation,
      };
      setActiveView("dashboard");
      setEditSession(loaded);
    });
    return loaded;
  }

  const updateComponentProps = useCallback(async (
    node: ResolvedComponentNode,
    props: Record<string, unknown>,
  ): Promise<void> => {
    const currentSnapshot = snapshotRef.current;
    const currentSession = editSessionRef.current;
    const configPath = node.sourceConfigPath;
    const path = node.sourcePath ? nodePathFromSourcePath(node.sourcePath) : null;
    if (!currentSnapshot?.projectRoot || !configPath || !path) {
      throw new Error("This component cannot locate its owning dashboard configuration.");
    }
    if (currentSession && currentSession.configPath !== configPath) {
      throw new Error("Finish the current dashboard draft before editing another dashboard component.");
    }

    let session = currentSession;
    if (!session) {
      const source = await host.getDashboardConfigSource(configPath);
      const validation = await host.validateDashboardDraft(source.config, source.configPath);
      session = {
        projectRoot: currentSnapshot.projectRoot,
        configPath: source.configPath,
        componentCatalog: source.componentCatalog,
        original: structuredClone(source.config),
        draft: structuredClone(source.config),
        expectedConfigRevision: source.configRevision,
        validation,
      };
      editSessionRef.current = session;
      setActiveView("dashboard");
      setEditSession(session);
    }

    const next = updateNodeProps(session.draft, path, props);
    const updated = { ...session, draft: next };
    editSessionRef.current = updated;
    setEditSession((current) => current && current.configPath === session!.configPath ? updated : current);
  }, []);

  function cancelDashboardEdit(): void {
    if (!editSession) return;
    if (requireDiscard("Discard the unsaved dashboard changes and exit edit mode?", () => undefined)) {
      setEditSession(null);
      resetCompositionUi();
    }
  }

  function showSettings(): void {
    if (editSession && !requireDiscard(
      "Discard the unsaved dashboard changes and open settings?",
      () => setActiveView("settings"),
    )) return;
    setActiveView("settings");
  }

  function updateAppSettings(settings: AppSettings, notice: string): void {
    void perform("save-settings", async () => {
      const updated = await host.updateAppSettings(settings);
      setAppSettings(updated);
      showActionNotice(notice);
    });
  }

  function saveAgentSetting(command: string): void {
    updateAppSettings(
      { ...appSettings, dashBoredAgent: command },
      `DASH_BORED_AGENT is now ${command}.`,
    );
  }

  async function copyComponentPath(node: ResolvedComponentNode): Promise<void> {
    setActionError(null);
    setActionNotice(null);
    const locator = componentPath(node);
    try {
      await writeClipboardText(locator);
      showActionNotice(`Copied ${locator}`);
    } catch (error) {
      setActionError(errorMessage(error));
    }
  }

  async function runComponentAgent(node: ResolvedComponentNode, prompt: string): Promise<void> {
    const action = `component-agent:${node.id}`;
    setPendingAction(action);
    setActionError(null);
    setActionNotice(null);
    try {
      const launched = await host.runComponentAgent({ nodeId: node.id, prompt });
      setAgentDialog(null);
      setAgentActivityOpen(true);
      showActionNotice(`Started ${launched.command} for ${launched.componentPath}.`);
    } finally {
      setPendingAction(null);
    }
  }

  async function runDiagnosticsAgent(): Promise<void> {
    await perform("diagnostics-agent", async () => {
      const launched = await host.runDiagnosticsAgent();
      setAgentActivityOpen(true);
      showActionNotice(`Started ${launched.command} for ${launched.componentPath}.`);
    });
  }

  async function runComponentCreationAgent(
    configPath: string,
    target: InsertionTarget,
    prompt: string,
  ): Promise<void> {
    setPendingAction("component-agent:create");
    setActionError(null);
    setActionNotice(null);
    try {
      const launched = await host.runComponentCreationAgent({ configPath, target, prompt });
      setEditSession(null);
      resetCompositionUi();
      setAgentActivityOpen(true);
      showActionNotice(`Started ${launched.command} for ${launched.componentPath}.`);
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setPendingAction(null);
    }
  }

  function requestComponentCreationAgent(target: InsertionTarget, description: string): void {
    if (!editSession || pendingAction !== null) return;
    const configPath = editSession.configPath;
    const launch = (): void => {
      void runComponentCreationAgent(configPath, target, description);
    };
    if (editSessionDirty()) {
      setDiscardConfirmation({
        message: "Discard the dashboard draft and ask the configured agent to build this component?",
        continueAction: launch,
      });
      return;
    }
    launch();
  }

  async function saveDashboardDraft(): Promise<void> {
    if (!editSession) return;
    setSavingDraft(true);
    setActionError(null);
    try {
      await host.saveDashboardConfig(
        editSession.draft,
        editSession.expectedConfigRevision,
        editSession.configPath,
      );
      setEditSession(null);
      resetCompositionUi();
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setSavingDraft(false);
    }
  }

  const editingActiveProject = Boolean(editSession && editSession.projectRoot === snapshot?.projectRoot);
  const draftDirty = Boolean(editSession && editSessionDirty());
  const draftValid = Boolean(editSession &&
    editSession?.validation.diagnostics.every((item) => item.severity !== "error"),
  );
  const applicationActions = buildApplicationActions({
    snapshot,
    projects,
    activeView,
    sidebarExpanded,
    pendingAction,
    editing: editingActiveProject,
    draftDirty,
    draftValid,
    savingDraft,
    callbacks: {
      reloadApp: () => window.location.reload(),
      showDashboard: () => setActiveView("dashboard"),
      showSettings,
      toggleSidebar: () => setSidebarExpanded((expanded) => !expanded),
      addDashboard,
      openProject: selectProject,
      editDashboard: toggleCompositionLibrary,
      saveDashboard: () => saveDashboardDraft(),
      cancelDashboard: cancelDashboardEdit,
      reloadProject: () => perform("reload", host.reloadProject),
      trustProject: () => perform("trust", host.trustProject),
      revokeTrust: () => perform("revoke", host.revokeTrust),
      runProcessQuickAction: async (nodeId) => {
        await host.runProcessQuickAction(nodeId);
      },
      stopProcess: async (nodeId) => {
        await host.stopProcess(nodeId);
      },
    },
  });
  const dashboardPath = snapshot?.configPath ?? null;
  const {
    storedVirtualRoot,
    activeCollapsedComponentIds,
    activeSplitRatioOverrides,
    activeComponentHeightOverrides,
    storeVirtualRoot,
    expandComponent,
    toggleComponentCollapse,
    updateSplitRatio,
    updateComponentHeight,
    focusComponent,
    forgetDashboard,
  } = useDashboardViewState(dashboardPath, snapshot?.tree);
  const virtualRoot = snapshot?.tree
    ? resolveVirtualRoot(snapshot.tree, storedVirtualRoot ?? null)
    : null;
  const compositionPreviewTree = useMemo(() => {
    if (!snapshot?.tree) return null;
    const source = compositionSource
      && compositionSource.projectRoot === snapshot.projectRoot
      && compositionSource.activeDashboardPath === snapshot.configPath
      && compositionSource.focusedSourcePath === virtualRoot?.node.sourceConfigPath
      && compositionSource.snapshotRevision === snapshot.revision
      ? compositionSource
      : null;
    if (!editSession) {
      if (!source || source.configPath === snapshot.configPath) return snapshot.tree;
      const template = findResolvedConfigRoot(snapshot.tree, source.configPath);
      return template
        ? buildCompositionPreviewTree(
            source.config,
            template,
            source.componentCatalog,
            source.configPath,
            linkedComponentIdNamespace(template, source.config.root),
          )
        : null;
    }
    if (!editSession.configPath) return null;
    const template = editSession.configPath === snapshot.configPath
      ? snapshot.tree
      : findResolvedConfigRoot(snapshot.tree, editSession.configPath);
    return template
      ? buildCompositionPreviewTree(
          editSession.draft,
          template,
          editSession.componentCatalog,
          editSession.configPath,
          editSession.configPath === snapshot.configPath
            ? undefined
            : linkedComponentIdNamespace(template, editSession.draft.root),
        )
      : null;
  }, [
    compositionSource,
    editSession,
    snapshot?.configPath,
    snapshot?.projectRoot,
    snapshot?.tree,
    virtualRoot?.node.sourceConfigPath,
  ]);
  const compositionVirtualRoot = compositionPreviewTree
    ? resolveVirtualRoot(compositionPreviewTree, storedVirtualRoot ?? null)
    : null;
  const activeCompositionSource = compositionSource
    && compositionSource.projectRoot === snapshot?.projectRoot
    && compositionSource.activeDashboardPath === snapshot?.configPath
    && compositionSource.focusedSourcePath === virtualRoot?.node.sourceConfigPath
    && compositionSource.snapshotRevision === snapshot?.revision
    ? compositionSource
    : null;
  const compositionConfig = editSession
    ? editSession.draft
    : activeCompositionSource?.config ?? snapshot?.config ?? null;
  const compositionCatalog = editSession
    ? editSession.componentCatalog
    : activeCompositionSource?.componentCatalog ?? snapshot?.componentCatalog ?? [];
  const compositionSourcePending = Boolean(
    componentLibraryOpen
    && !editSession
    && virtualRoot?.node.sourceConfigPath
    && snapshot?.configPath
    && virtualRoot.node.sourceConfigPath !== snapshot.configPath
    && !activeCompositionSource,
  );
  const editingComposition = Boolean(editSession && editingActiveProject && compositionPreviewTree);

  function compositionSourceIsReady(): boolean {
    if (!compositionSourcePending) return true;
    setActionError("Loading the focused dashboard bundle before composing.");
    return false;
  }

  const compositionTargets = useMemo(() => createCompositionTargets({
    config: compositionConfig,
    catalog: compositionCatalog,
    previewTree: compositionPreviewTree,
    owningConfigPath: editSession?.configPath
      ?? activeCompositionSource?.configPath
      ?? snapshot?.configPath,
    dragging: compositionDrag,
  }), [
    compositionConfig,
    compositionCatalog,
    compositionPreviewTree,
    editSession?.configPath,
    activeCompositionSource?.configPath,
    snapshot?.configPath,
    compositionDrag,
  ]);
  const {
    pathForNode: compositionPathForNode,
    dropZonesForNode: compositionDropZonesForNode,
    pointerDropZoneForNode: compositionPointerDropZone,
    pointerTargetAt: compositionPointerTargetAt,
    targetIsValid: compositionTargetIsValid,
    defaultTarget: defaultCompositionTarget,
  } = compositionTargets;

  function updateCompositionPointerDrag(
    payload: CompositionDragPayload,
    point: ComponentPointerDragPoint,
  ): void {
    const target = compositionPointerTargetAt(point, payload);
    compositionInteraction.updatePointer(target ? {
      nodeId: target.node.id,
      zoneId: target.zone.id,
      clientX: point.clientX,
      clientY: point.clientY,
    } : null);
  }

  function scheduleCompositionPointerDrag(
    payload: CompositionDragPayload,
    point: ComponentPointerDragPoint,
  ): void {
    pendingCompositionPointer.current = { payload, point };
    if (compositionPointerFrame.current !== null) return;
    compositionPointerFrame.current = requestAnimationFrame(() => {
      compositionPointerFrame.current = null;
      const pending = pendingCompositionPointer.current;
      pendingCompositionPointer.current = null;
      if (pending) updateCompositionPointerDrag(pending.payload, pending.point);
    });
  }

  function clearPendingCompositionPointer(): void {
    pendingCompositionPointer.current = null;
    if (compositionPointerFrame.current !== null) {
      cancelAnimationFrame(compositionPointerFrame.current);
      compositionPointerFrame.current = null;
    }
  }

  function dropCompositionPointer(
    payload: CompositionDragPayload,
    point: ComponentPointerDragPoint,
  ): void {
    const target = compositionPointerTargetAt(point, payload);
    clearPendingCompositionPointer();
    compositionInteraction.updatePointer(null);
    if (target) {
      handleCompositionDrop(target.zone.target, payload);
      return;
    }
    const removalTarget = document.elementFromPoint(point.clientX, point.clientY)
      ?.closest("[data-composition-removal-target]");
    if (payload.type === "node" && removalTarget) {
      void removeCompositionNode(payload.path);
    }
  }

  function handleCompositionPointerDragMove(
    reference: string,
    point: ComponentPointerDragPoint,
  ): void {
    scheduleCompositionPointerDrag({ type: "component", reference }, point);
  }

  function handleCompositionPointerDrop(
    reference: string,
    point: ComponentPointerDragPoint,
  ): void {
    dropCompositionPointer({ type: "component", reference }, point);
  }

  async function openCompositionDialog(
    target: CompositionTarget,
    reference?: string,
  ): Promise<void> {
    if (!compositionSourceIsReady()) return;
    if (!compositionConfig || !snapshot?.tree) return;
    const payload: CompositionDragPayload = {
      type: "component",
      reference: reference ?? "",
    };
    if (!reference || !compositionTargetIsValid(target, payload)) {
      setActionError("Choose a valid component and insertion target before composing.");
      return;
    }
    const session = await ensureCurrentDashboardEdit();
    if (!session) return;
      compositionInteraction.showDialog(isRootCompositionTarget(target)
        ? { mode: "replace", reference }
        : { mode: "add", target, reference });
  }

  function handleCompositionInsert(entry: ComponentCatalogItem): void {
    if (!compositionSourceIsReady()) return;
    const target = compositionTarget ?? defaultCompositionTarget();
    if (!target) {
      setActionError("No dashboard insertion target is available.");
      return;
    }
    void openCompositionDialog(target, entry.reference);
  }

  async function handleCompositionAgent(description: string): Promise<void> {
    if (!compositionSourceIsReady()) return;
    let target = compositionTarget ?? defaultCompositionTarget();
    if (!target || isRootCompositionTarget(target)) {
      const fallback = defaultCompositionTarget();
      target = fallback && !isRootCompositionTarget(fallback) ? fallback : null;
    }
    if (!target || isRootCompositionTarget(target) || !snapshot?.projectRoot) {
      setActionError("Choose a component insertion target before asking the agent to build one.");
      return;
    }
    const session = await ensureCurrentDashboardEdit();
    if (!session) return;
    const dirty = JSON.stringify(session.original) !== JSON.stringify(session.draft);
    if (dirty) {
      setDiscardConfirmation({
        message: "Discard the dashboard draft and ask the configured agent to build this component?",
        continueAction: () => void runComponentCreationAgent(session.configPath, target!, description),
      });
      return;
    }
    void runComponentCreationAgent(session.configPath, target, description);
  }

  async function removeCompositionNode(path: NodePath): Promise<void> {
    const session = await ensureCurrentDashboardEdit();
    if (!session || path.length === 0) return;
    try {
      nodeAtPath(session.draft.root, path);
    } catch {
      setActionError("The component moved before removal could be confirmed.");
      return;
    }
    compositionInteraction.requestRemoval(path);
  }

  function handleCompositionDrop(target: CompositionTarget, payload: CompositionDragPayload): void {
    if (!compositionSourceIsReady()) return;
    if (!compositionTargetIsValid(target, payload)) return;
    if (payload.type === "component") {
      void openCompositionDialog(target, payload.reference);
      return;
    }
    void ensureCurrentDashboardEdit().then((session) => {
      if (!session || isRootCompositionTarget(target)) return;
      const planned = planCompositionOperation({
        config: session.draft,
        catalog: session.componentCatalog,
        payload,
        target,
      });
      if (planned.status !== "planned") {
        setActionError(planned.message);
        return;
      }
      try {
        const next = planned.nextConfig;
        setEditSession((current) => current && current.configPath === session.configPath
          ? { ...current, draft: next }
          : current);
        compositionInteraction.endDrag();
        compositionInteraction.clearTarget();
      } catch (error) {
        setActionError(errorMessage(error));
      }
    });
  }

  function handleCompositionSplitRatio(
    branchKey: string,
    defaultRatio: number,
    ratio: number | null,
    node: ResolvedComponentNode,
    splitPath: readonly LayoutBranch[],
  ): void {
    if (editingComposition && editSession) {
      const path = nodePathById(editSession.draft.root, node.id);
      if (!path) {
        setActionError("The tiled component moved before its split could be updated.");
        return;
      }
      try {
        const next = ratio === null
          ? editSession.draft
          : updateTiledSplitRatio(editSession.draft, path, splitPath, ratio);
        setEditSession({ ...editSession, draft: next });
      } catch (error) {
        setActionError(errorMessage(error));
      }
      return;
    }
    if (componentLibraryOpen) {
      void ensureCurrentDashboardEdit().then((session) => {
        if (!session) return;
        const path = nodePathById(session.draft.root, node.id);
        if (!path) {
          setActionError("The tiled component moved before its split could be updated.");
          return;
        }
        try {
          const next = updateTiledSplitRatio(session.draft, path, splitPath, ratio ?? defaultRatio);
          setEditSession((current) => current && current.configPath === session.configPath
            ? { ...current, draft: next }
            : current);
        } catch (error) {
          setActionError(errorMessage(error));
        }
      });
      return;
    }
    updateSplitRatio(branchKey, defaultRatio, ratio);
  }

  function applyCompositionDraft(next: DashboardConfig): void {
    setEditSession((current) => current ? { ...current, draft: next } : current);
    compositionInteraction.dismissDialog();
    compositionInteraction.clearTarget();
  }

  function confirmCompositionRemoval(): void {
    if (!compositionRemovePath || !editSession) return;
    try {
      const next = removeNode(editSession.draft, compositionRemovePath, editSession.componentCatalog);
      setEditSession({ ...editSession, draft: next });
      compositionInteraction.dismissRemoval();
      compositionInteraction.clearTarget();
    } catch (error) {
      setActionError(errorMessage(error));
    }
  }

  function confirmDiscardChanges(continueAction: () => void): void {
    setDiscardConfirmation(null);
    setEditSession(null);
    resetCompositionUi();
    queueMicrotask(continueAction);
  }

  // Composition is always ready for direct frame-handle drags. A drag itself opens
  // the flyout and begins a draft only after a valid move or removal.
  const compositionContextValue = compositionConfig && compositionPreviewTree
    ? {
        active: true,
        dragging: compositionDrag,
        pointer: compositionPointer,
        config: compositionConfig,
        catalog: compositionCatalog,
        pathForNode: compositionPathForNode,
        dropZonesForNode: compositionDropZonesForNode,
        pointerDropZoneForNode: compositionPointerDropZone,
        canDrop: compositionTargetIsValid,
        onNodeDragStart: compositionInteraction.beginNodeDrag,
        onNodeDragEnd: () => {
          clearPendingCompositionPointer();
          compositionInteraction.endDrag();
        },
        onNodePointerDragMove: (path: NodePath, point: ComponentPointerDragPoint) => {
          scheduleCompositionPointerDrag({ type: "node", path }, point);
        },
        onNodePointerDrop: (path: NodePath, point: ComponentPointerDragPoint) => {
          dropCompositionPointer({ type: "node", path }, point);
        },
        onLibraryDragStart: compositionInteraction.beginLibraryDrag,
        onLibraryDragEnd: () => {
          clearPendingCompositionPointer();
          compositionInteraction.endDrag();
        },
        onDragTarget: (nodeId: string | null, zone: CompositionDropZone | null) => {
          compositionInteraction.updatePointer(zone && nodeId ? {
            nodeId,
            zoneId: zone.id,
            clientX: 0,
            clientY: 0,
          } : null);
        },
        onDrop: handleCompositionDrop,
      }
    : null;

  useEffect(() => {
    if (!componentLibraryOpen || editSession || !snapshot?.projectRoot || !snapshot.configPath) return;
    const focusedSource = virtualRoot?.node.sourceConfigPath;
    if (!focusedSource || focusedSource === snapshot.configPath) {
      if (compositionSource !== null) setCompositionSource(null);
      return;
    }
    if (
      compositionSource?.projectRoot === snapshot.projectRoot
      && compositionSource.activeDashboardPath === snapshot.configPath
      && compositionSource.focusedSourcePath === focusedSource
      && compositionSource.snapshotRevision === snapshot.revision
      && compositionSource.configPath === focusedSource
    ) return;
    void loadCompositionSource();
  }, [
    componentLibraryOpen,
    compositionSource,
    editSession,
    snapshot?.configPath,
    snapshot?.projectRoot,
    snapshot?.revision,
    virtualRoot?.node.sourceConfigPath,
  ]);

  const compositionUiActive = componentLibraryOpen
    || compositionDialog !== null
    || compositionRemovePath !== null
    || discardConfirmation !== null
    || deletionDialog !== null
    || agentDialog !== null
    || paletteOpen
    || (editingComposition && (draftDirty || compositionDrag !== null));

  async function editCompositionNode(node: ResolvedComponentNode): Promise<void> {
    if (!compositionSourceIsReady()) return;
    const sourcePath = compositionPathForNode(node);
    if (!sourcePath) {
      setActionError("The component could not be located in its dashboard configuration.");
      return;
    }
    const session = await ensureCurrentDashboardEdit();
    if (!session) return;
    const path = nodePathById(session.draft.root, node.id) ?? sourcePath;
    try {
      nodeAtPath(session.draft.root, path);
    } catch {
      setActionError("The component moved before editing could be opened.");
      return;
    }
    compositionInteraction.showDialog({ mode: "configure", path });
  }

  async function focusProjectNode(targetProject: ProjectTarget, nodeId: string): Promise<void> {
    if (snapshot?.configPath === targetProject.configPath) {
      setActiveView("dashboard");
      expandComponent(targetProject.configPath, nodeId);
      storeVirtualRoot(targetProject.configPath, nodeId);
      return;
    }
    if (editSession && editSession.configPath !== targetProject.configPath && !requireDiscard(
      "Discard the unsaved dashboard changes and navigate to another dashboard node?",
      () => void focusProjectNode(targetProject, nodeId),
    )) return;

    let opened = false;
    await perform(`open:${targetProject.configPath}`, async () => {
      await host.openProject(targetProject);
      setActiveView("dashboard");
      opened = true;
    });
    if (opened) {
      expandComponent(targetProject.configPath, nodeId);
      storeVirtualRoot(targetProject.configPath, nodeId);
    }
  }

  function handleProjectNodeAction(
    targetProject: ProjectListItem,
    node: ResolvedComponentNode,
    action: DashboardOutlineNodeAction,
  ): void {
    if (action === "focus") {
      void focusProjectNode(targetProject, node.id);
      return;
    }
    if (action === "copy") {
      void copyComponentPath(node);
      return;
    }
    if (activeView !== "dashboard" || snapshot?.configPath !== targetProject.configPath) {
      setActionError("Open this dashboard before changing its component.");
      return;
    }
    if (action === "edit") {
      void editCompositionNode(node);
    } else if (action === "collapse") {
      toggleComponentCollapse(node.id);
    } else {
      setAgentDialog(node);
    }
  }

  const nodeFocusActions = buildNodeFocusActions(
    snapshot,
    virtualRoot?.node.id ?? null,
    editingActiveProject,
    (nodeId) => {
      setActiveView("dashboard");
      focusComponent(nodeId);
    },
  );
  const allActions = [...applicationActions, ...nodeFocusActions, ...componentActions];
  const favoriteActionIds = useMemo(
    () => new Set(appSettings.favoriteActionIds),
    [appSettings.favoriteActionIds],
  );
  actionsByIdRef.current = new Map(allActions.map((action) => [action.id, action]));

  async function executePaletteAction(id: string): Promise<void> {
    setActionError(null);
    const result = await actionExecutor.run(id);
    if (result.status === "failed") setActionError(errorMessage(result.error));
    else if (result.status === "unavailable") setActionError(result.reason);
    else if (result.status === "running") {
      setActionError("That action is already running.");
    }
  }

  function toggleFavoriteAction(id: string): void {
    const favoriteActionIds = appSettings.favoriteActionIds.includes(id)
      ? appSettings.favoriteActionIds.filter((candidate) => candidate !== id)
      : [...appSettings.favoriteActionIds, id];
    updateAppSettings(
      { ...appSettings, favoriteActionIds },
      favoriteActionIds.includes(id) ? "Action added to favorites." : "Action removed from favorites.",
    );
  }

  if (loading) {
    return (
      <main className="boot" aria-live="polite">
        <div className="brand-mark" aria-hidden="true"><span /><span /><span /></div>
        <span className="spinner" aria-hidden="true" />
        Loading dash-bored…
      </main>
    );
  }

  if (!snapshot && actionError) {
    return (
      <main className="boot boot--error">
        <div className="brand-mark" aria-hidden="true"><span /><span /><span /></div>
        <h1>dash-bored could not reach its desktop host</h1>
        <p>{actionError}</p>
      </main>
    );
  }

  const title = snapshot?.dashboardName?.trim() || (snapshot?.projectRoot ? basename(snapshot.projectRoot) : "dash-bored");
  const headerDashboardPath = snapshot?.configPath ?? snapshot?.projectRoot ?? null;
  const actionScope = `${snapshot?.projectRoot ?? "no-project"}\u0000${
    snapshot?.revision ?? 0
  }\u0000${snapshot?.trusted ? "trusted" : "restricted"}`;
  const shortcutLabel = keyboardShortcutLabel(
    appSettings.commandPaletteShortcut,
    typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform),
  );
  const visibleVirtualRoot = editingComposition ? compositionVirtualRoot : virtualRoot;
  const workspace = (
    <>
      {activeView === "settings" ? (
        <SettingsPanel
            snapshot={snapshot}
            appSettings={appSettings}
            actions={allActions}
            pendingAction={pendingAction}
            onSaveAgent={saveAgentSetting}
            onUpdateSettings={updateAppSettings}
            onReload={() => void perform("reload", host.reloadProject)}
            onTrust={() => void perform("trust", host.trustProject)}
            onRevoke={() => void perform("revoke", host.revokeTrust)}
          />
      ) : !snapshot?.projectRoot ? (
        <EmptyProject
          pending={pendingAction === "choose"}
          onChoose={() => void addDashboard()}
        />
      ) : (
        <main className="workspace">
            {editSession && editSession.projectRoot === snapshot.projectRoot && !compositionPreviewTree ? (
              <DashboardEditor
                config={editSession.draft}
                catalog={editSession.componentCatalog}
                diagnostics={editSession.validation.diagnostics}
                projectRoot={editSession.projectRoot}
                configPath={editSession.configPath}
                agentCommand={appSettings.dashBoredAgent}
                agentPending={pendingAction === "component-agent:create"}
                onBuildWithAgent={requestComponentCreationAgent}
                onChange={(draft) => setEditSession((current) => current ? { ...current, draft } : current)}
              />
            ) : (
              <>
            {!snapshot.trusted ? (
              <TrustPanel snapshot={snapshot} pending={pendingAction === "trust"} onTrust={() => void perform("trust", host.trustProject)} />
            ) : null}

            <Diagnostics
              diagnostics={snapshot.diagnostics}
              pending={pendingAction === "diagnostics-agent"}
              onFixWithAgent={() => void runDiagnosticsAgent()}
            />

            {snapshot.tree ? (
              <section className="dashboard" aria-label={`${title} dashboard`}>
                {visibleVirtualRoot && visibleVirtualRoot.crumbs.length > 1 ? (
                  <nav className="dashboard-breadcrumbs" aria-label="Focused component path">
                    {visibleVirtualRoot.crumbs.map((crumb, index) => (
                      <span className="dashboard-breadcrumbs__item" key={crumb.id}>
                        {index < visibleVirtualRoot.crumbs.length - 1 ? (
                          <button type="button" onClick={() => focusComponent(crumb.id)}>{crumb.label}</button>
                        ) : <span aria-current="page">{crumb.label}</span>}
                        {index < visibleVirtualRoot.crumbs.length - 1 ? <span aria-hidden="true">/</span> : null}
                      </span>
                    ))}
                  </nav>
                ) : null}
                <ComponentVisibilityContext.Provider value={!compositionUiActive}>
                  <CompositionContext.Provider value={compositionContextValue}>
                    <NodeRenderer
                      node={visibleVirtualRoot?.node ?? snapshot.tree}
                      trusted={snapshot.trusted}
                      processesRef={processesRef}
                      localComponents={localComponents}
                      actionRegistry={actionRegistry}
                      actionScope={actionScope}
                      updateBatch={componentUpdateBatch}
                      collapsedNodeIds={activeCollapsedComponentIds}
                      splitRatioOverrides={editingComposition ? EMPTY_SPLIT_RATIO_OVERRIDES : activeSplitRatioOverrides}
                      componentHeightOverrides={activeComponentHeightOverrides}
                      onFocus={focusComponent}
                      onToggleCollapse={toggleComponentCollapse}
                      onSplitRatioChange={handleCompositionSplitRatio}
                      onComponentHeightChange={updateComponentHeight}
                      onCopyPath={(node) => void copyComponentPath(node)}
                      onEditComponent={(node) => void editCompositionNode(node)}
                      onOpenAgent={setAgentDialog}
                      onUpdateProps={updateComponentProps}
                      isVirtualRoot
                    />
                  </CompositionContext.Provider>
                </ComponentVisibilityContext.Provider>
              </section>
            ) : (
              <section className="empty-dashboard">
                <span className="eyebrow">Configuration unavailable</span>
                <h1>The dashboard could not be rendered.</h1>
                <p>Fix the diagnostics above, then reload the project.</p>
                <button className="button button--secondary" type="button" disabled={pendingAction !== null} onClick={() => void perform("reload", host.reloadProject)}>Try again</button>
              </section>
            )}

              </>
            )}

            <footer className="workspace__footer">
              <span>Revision {snapshot.revision}</span>
              <span>{snapshot.trusted ? "Capabilities enabled" : "Restricted mode"}</span>
            </footer>
        </main>
      )}
    </>
  );
  return (
    <>
      <AppShell
        snapshot={snapshot}
        projects={projects}
        activeView={activeView}
        sidebarExpanded={sidebarExpanded}
        expandedProjectOutlines={expandedProjectOutlines}
        pendingAction={pendingAction}
        projectOutlines={projectOutlines}
        currentVirtualRootProjectPath={snapshot?.configPath ?? null}
        currentVirtualRootId={virtualRoot?.node.id ?? null}
        collapsedNodeIds={activeCollapsedComponentIds}
        title={title}
        dashboardPath={headerDashboardPath}
        shortcutLabel={shortcutLabel}
        editing={editingActiveProject}
        componentLibraryOpen={componentLibraryOpen}
        agentActivityOpen={agentActivityOpen}
        activeAgentTaskCount={activeDashboardAgentTaskCount(agentTasks)}
        editorToolbar={
          editSession && editingActiveProject ? (
            <div className="app-header__editor-toolbar">
              <DashboardEditorToolbar
                diagnostics={editSession.validation.diagnostics}
                saving={savingDraft}
                dirty={editSessionDirty()}
                onSave={() => void saveDashboardDraft()}
                onCancel={cancelDashboardEdit}
              />
            </div>
          ) : null
        }
        actionError={actionError}
        actionNotice={
          actionNotice ? (
            <div className="global-notice" role="status">
              <span>{actionNotice.message}</span>
              <button
                className="global-notice__close"
                type="button"
                aria-label="Dismiss message"
                onClick={() => setActionNotice(null)}
              >
                <svg
                  className="global-notice__countdown"
                  viewBox="0 0 28 28"
                  aria-hidden="true"
                >
                  <circle
                    className="global-notice__countdown-track"
                    cx="14"
                    cy="14"
                    r="11"
                  />
                  <circle
                    className="global-notice__countdown-progress"
                    cx="14"
                    cy="14"
                    r="11"
                    pathLength="1"
                  />
                </svg>
                <span aria-hidden="true">×</span>
              </button>
            </div>
          ) : null
        }
        onToggleSidebar={() => setSidebarExpanded((expanded) => !expanded)}
        onSelectProject={(project) => void selectProject(project)}
        onToggleProjectOutline={toggleProjectOutline}
        onFocusProjectNode={(project, nodeId) => void focusProjectNode(project, nodeId)}
        onProjectNodeAction={handleProjectNodeAction}
        onOpenDeletion={(project) => void openDeletionDialog(project)}
        onAddDashboard={() => void addDashboard()}
        onShowSettings={showSettings}
        onOpenPalette={() => setPaletteOpen(true)}
        onToggleLibrary={toggleCompositionLibrary}
        onToggleAgentActivity={toggleAgentActivity}
        onDismissError={() => setActionError(null)}
      >
        {workspace}
      </AppShell>
      <AgentActivity
        open={agentActivityOpen}
        tasks={agentTasks}
        onClose={() => setAgentActivityOpen(false)}
        onDiff={host.getDashboardAgentDiff}
        onStop={stopAgentTask}
        onWrite={writeAgentTaskTerminal}
        onResize={resizeAgentTaskTerminal}
      />
      <CommandPalette
        open={paletteOpen}
        actions={allActions}
        runningActionIds={runningActionIds}
        favoriteActionIds={favoriteActionIds}
        actionShortcuts={appSettings.actionShortcuts}
        favoritesDisabled={pendingAction !== null}
        onDismiss={() => setPaletteOpen(false)}
        onExecute={(id) => void executePaletteAction(id)}
        onToggleFavorite={toggleFavoriteAction}
      />
      <CompositionFlyout
        open={componentLibraryOpen}
        dragging={compositionDrag}
        catalog={compositionCatalog}
        onClose={compositionInteraction.closeLibrary}
        onInsert={handleCompositionInsert}
        onRemoveDrop={(path) => void removeCompositionNode(path)}
        onBuildWithAgent={(description) => void handleCompositionAgent(description)}
        onPointerDragMove={handleCompositionPointerDragMove}
        onPointerDrop={handleCompositionPointerDrop}
        onDragStateChange={(entry) => {
          if (entry) {
            compositionInteraction.beginLibraryDrag(entry.reference);
          } else {
            clearPendingCompositionPointer();
            compositionInteraction.endDrag();
          }
        }}
        agentPending={pendingAction === "component-agent:create"}
        loading={compositionSourcePending}
      />
      <AppDialogs
        compositionDialog={compositionDialog}
        compositionRemovePath={compositionRemovePath}
        editSession={editSession}
        editingActiveProject={editingActiveProject}
        agentDialog={agentDialog}
        pendingAction={pendingAction}
        discardConfirmation={discardConfirmation}
        deletionDialog={deletionDialog}
        agentCommand={appSettings.dashBoredAgent}
        agentCreatePending={pendingAction === "component-agent:create"}
        onApplyCompositionDraft={applyCompositionDraft}
        onDismissCompositionDialog={compositionInteraction.dismissDialog}
        onDismissRemoval={compositionInteraction.dismissRemoval}
        onConfirmRemoval={confirmCompositionRemoval}
        onBuildWithAgent={requestComponentCreationAgent}
        onRunComponentAgent={runComponentAgent}
        onDismissAgentDialog={() => setAgentDialog(null)}
        onDismissDiscard={() => setDiscardConfirmation(null)}
        onConfirmDiscard={confirmDiscardChanges}
        onDismissDeletion={() => setDeletionDialog(null)}
        onToggleDeletionFiles={(removeFiles) => setDeletionDialog((current) => current ? { ...current, removeFiles } : current)}
        onConfirmDeletion={() => void confirmDeletion()}
      />
    </>
  );
}
