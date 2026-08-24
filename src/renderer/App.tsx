import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import type {
  DashboardConfig,
  DashboardDraftValidation,
  Diagnostic,
  ComponentCatalogItem,
  LocalComponentHost,
  ProcessSnapshot,
  ProjectDeletionPreview,
  ProjectListItem,
  ProjectOutline,
  ProjectSnapshot,
  ResolvedComponentNode,
} from "../shared/contracts";
import {
  buildApplicationActions,
  buildNodeFocusActions,
  hasLocalNode,
  PERMISSION_LABELS,
  projectLabel,
} from "./action-providers";
import type { AppView } from "./action-providers";
import { ActionExecutor, ActionRegistry } from "./actions";
import type { PaletteAction } from "./actions";
import { BuiltinRenderer } from "./builtins";
import type { RenderedSlots } from "./builtins";
import { CommandPalette } from "./CommandPalette";
import { DashboardOutlineTree } from "./DashboardOutlineTree";
import {
  DashboardEditor,
  DashboardEditorToolbar,
  EditorModal,
} from "./DashboardEditor";
import {
  LocalComponentErrorBoundary,
  useLocalComponents,
} from "./local-components";
import type { LoadedLocalComponent } from "./local-components";
import { host } from "./rpc-client";
import { resolveVirtualRoot, virtualRootStorageKey } from "./virtual-root";

function replaceProcess(
  snapshot: ProjectSnapshot,
  process: ProcessSnapshot,
): ProjectSnapshot {
  const index = snapshot.processes.findIndex((item) => item.id === process.id);
  const processes = [...snapshot.processes];
  if (index === -1) processes.push(process);
  else processes[index] = process;
  return { ...snapshot, processes };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function rememberProject(
  projects: ProjectListItem[],
  snapshot: ProjectSnapshot,
): ProjectListItem[] {
  if (snapshot.projectRoot === null) return projects;
  const item = {
    projectRoot: snapshot.projectRoot,
    dashboardName: snapshot.dashboardName,
  };
  const existingIndex = projects.findIndex(
    (project) => project.projectRoot === item.projectRoot,
  );
  if (existingIndex === -1) return [...projects, item];
  const next = [...projects];
  next[existingIndex] = item;
  return next;
}

interface ProjectOutlineState {
  tree: ResolvedComponentNode | null;
  loading: boolean;
  error: string | null;
}

function outlineError(outline: Pick<ProjectOutline, "tree" | "diagnostics">): string | null {
  if (outline.tree) return null;
  return outline.diagnostics.find((item) => item.severity === "error")?.message
    ?? "The dashboard tree is unavailable.";
}

type ShellIconName = "collapse" | "expand" | "project" | "add" | "settings" | "edit" | "tree" | "trash";

function ShellIcon({ name }: { name: ShellIconName }): ReactNode {
  if (name === "project") {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <rect x="3" y="3" width="6" height="6" rx="1.5" />
        <rect x="11" y="3" width="6" height="6" rx="1.5" />
        <rect x="3" y="11" width="6" height="6" rx="1.5" />
        <path d="M12 14h4M14 12v4" />
      </svg>
    );
  }
  if (name === "add") {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="M10 4v12M4 10h12" />
      </svg>
    );
  }
  if (name === "settings") {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="10" cy="10" r="2.5" />
        <path d="M10 2.8v2M10 15.2v2M2.8 10h2M15.2 10h2M4.9 4.9l1.4 1.4M13.7 13.7l1.4 1.4M15.1 4.9l-1.4 1.4M6.3 13.7l-1.4 1.4" />
      </svg>
    );
  }
  if (name === "edit") {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="m5 14-.5 2.5L7 16l8-8-2-2-8 8Z" />
        <path d="m11.8 7.2 2 2" />
      </svg>
    );
  }
  if (name === "tree") {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="M5 4v9.5M5 7h4M5 13h4" />
        <rect x="10" y="4.5" width="5" height="5" rx="1" />
        <rect x="10" y="11" width="5" height="5" rx="1" />
        <circle cx="5" cy="4" r="1.25" />
      </svg>
    );
  }
  if (name === "trash") {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="M4.5 6.5h11M8 6.5V4h4v2.5M6.5 8.5l.5 7h6l.5-7M8.5 10v3.5M11.5 10v3.5" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d={name === "collapse" ? "M12 5 7 10l5 5" : "m8 5 5 5-5 5"} />
    </svg>
  );
}

function createLocalHost(
  node: ResolvedComponentNode,
  actionRegistry: ActionRegistry,
  actionScope: string,
): LocalComponentHost {
  const permissions = new Set(node.manifest?.permissions ?? []);
  const actionOwner = {
    scope: actionScope,
    nodeId: node.id,
    componentName: node.manifest?.name ?? node.component,
  };
  const componentHost: LocalComponentHost = {
    dashboard: {
      async reload(): Promise<void> {
        await host.reloadProject();
      },
    },
    actions: {
      register(action) {
        return actionRegistry.register(actionOwner, action);
      },
    },
  };

  if (permissions.has("filesystem:read") || permissions.has("filesystem:write")) {
    componentHost.filesystem = {
      readText(path) {
        return host.readTextFile({ nodeId: node.id, path });
      },
      ...(permissions.has("filesystem:write")
        ? {
            writeText(path, content) {
              return host.writeTextFile({ nodeId: node.id, path, content });
            },
          }
        : {}),
    };
  }

  if (permissions.has("network:http")) {
    componentHost.http = {
      request(request) {
        return host.httpRequest({ ...request, nodeId: node.id });
      },
    };
  }

  if (permissions.has("process:execute")) {
    componentHost.shell = {
      run(request) {
        return host.runShell({ ...request, nodeId: node.id });
      },
    };
  }

  return componentHost;
}

interface NodeRendererProps {
  node: ResolvedComponentNode;
  trusted: boolean;
  processes: ReadonlyMap<string, ProcessSnapshot>;
  localComponents: ReadonlyMap<string, LoadedLocalComponent>;
  actionRegistry: ActionRegistry;
  actionScope: string;
  onFocus: (nodeId: string) => void;
  isVirtualRoot?: boolean;
}

function NodeRenderer({
  node,
  trusted,
  processes,
  localComponents,
  actionRegistry,
  actionScope,
  onFocus,
  isVirtualRoot = false,
}: NodeRendererProps): ReactNode {
  const permissionsKey = (node.manifest?.permissions ?? []).join("\u0000");
  const localHost = useMemo(
    () => createLocalHost(node, actionRegistry, actionScope),
    [actionRegistry, actionScope, node.id, node.manifest?.name, permissionsKey],
  );
  useEffect(
    () => () => actionRegistry.clearOwner({ scope: actionScope, nodeId: node.id }),
    [actionRegistry, actionScope, node.id],
  );
  const slots: RenderedSlots = Object.fromEntries(
    Object.entries(node.slots).map(([name, children]) => [
      name,
      children.map((child) => (
        <NodeRenderer
          key={child.id}
          node={child}
          trusted={trusted}
          processes={processes}
          localComponents={localComponents}
          actionRegistry={actionRegistry}
          actionScope={actionScope}
          onFocus={onFocus}
        />
      )),
    ]),
  );

  if (node.source === "builtin") {
    return (
      <div className="component-node" data-component={node.component} data-node-id={node.id}>
        {!isVirtualRoot ? (
          <button className="component-node__focus" type="button" onClick={() => onFocus(node.id)} title="Focus this component" aria-label={`Focus ${node.manifest?.name ?? node.component}`}>
            Focus
          </button>
        ) : null}
        <BuiltinRenderer
          node={node}
          slots={slots}
          trusted={trusted}
          processes={processes}
        />
      </div>
    );
  }

  if (node.source === "config") {
    const name = node.configName?.trim() || node.component;
    return (
      <section className="component-node config-link" data-component={node.component} data-node-id={node.id}>
        {!isVirtualRoot ? (
          <button className="component-node__focus" type="button" onClick={() => onFocus(node.id)} title="Focus this config" aria-label={`Focus ${name}`}>
            Focus
          </button>
        ) : null}
        {node.configError ? (
          <div className="component-state component-state--error" role="alert">
            <strong>Could not load {name}</strong>
            <span>{node.configError}</span>
            <code>{node.configPath ?? node.component}</code>
          </div>
        ) : (
          <div className="config-link__content">{slots.content}</div>
        )}
      </section>
    );
  }

  const name = node.manifest?.name ?? node.component;
  if (!trusted) {
    return (
      <div className="component-node component-state component-state--locked" data-node-id={node.id}>
        {!isVirtualRoot ? <button className="component-node__focus" type="button" onClick={() => onFocus(node.id)}>Focus</button> : null}
        <span className="component-state__icon" aria-hidden="true">◇</span>
        <strong>{name}</strong>
        <span>Trust this project to load its local component code.</span>
      </div>
    );
  }

  const componentId = node.manifest?.id;
  const loaded = componentId ? localComponents.get(componentId) : undefined;
  if (!componentId) {
    return (
      <div className="component-node component-state component-state--error" role="alert" data-node-id={node.id}>
        {!isVirtualRoot ? <button className="component-node__focus" type="button" onClick={() => onFocus(node.id)}>Focus</button> : null}
        Local component <code>{node.component}</code> has no manifest ID.
      </div>
    );
  }

  if (!loaded || loaded.loading) {
    return (
      <div className="component-node component-state" aria-live="polite" data-node-id={node.id}>
        {!isVirtualRoot ? <button className="component-node__focus" type="button" onClick={() => onFocus(node.id)}>Focus</button> : null}
        <span className="spinner" aria-hidden="true" />
        Loading {name}…
      </div>
    );
  }

  if (loaded.error || !loaded.component) {
    return (
      <div className="component-node component-state component-state--error" role="alert" data-node-id={node.id}>
        {!isVirtualRoot ? <button className="component-node__focus" type="button" onClick={() => onFocus(node.id)}>Focus</button> : null}
        <strong>Could not load {name}</strong>
        <span>{loaded.error ?? "The compiled module has no component export."}</span>
      </div>
    );
  }

  const Component = loaded.component;
  return (
    <div className="component-node component-node--local" data-component={componentId} data-node-id={node.id}>
      {!isVirtualRoot ? (
        <button className="component-node__focus" type="button" onClick={() => onFocus(node.id)} title="Focus this component" aria-label={`Focus ${name}`}>
          Focus
        </button>
      ) : null}
      <LocalComponentErrorBoundary
        name={name}
        resetKey={`${node.id}:${loaded.revision}`}
      >
        <Component props={node.props} slots={slots} host={localHost} />
      </LocalComponentErrorBoundary>
    </div>
  );
}

function DiagnosticItem({ diagnostic }: { diagnostic: Diagnostic }): ReactNode {
  const location = [
    diagnostic.file,
    diagnostic.line ? `line ${diagnostic.line}` : null,
    diagnostic.column ? `column ${diagnostic.column}` : null,
    diagnostic.path,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <li className={`diagnostic diagnostic--${diagnostic.severity}`}>
      <span className="diagnostic__marker" aria-hidden="true" />
      <div>
        <div className="diagnostic__heading">
          <code>{diagnostic.code}</code>
          <strong>{diagnostic.message}</strong>
        </div>
        {location ? <span className="diagnostic__location">{location}</span> : null}
      </div>
    </li>
  );
}

function Diagnostics({ diagnostics }: { diagnostics: Diagnostic[] }): ReactNode {
  if (diagnostics.length === 0) return null;
  const errors = diagnostics.filter((item) => item.severity === "error").length;
  const warnings = diagnostics.length - errors;
  const summary = [
    errors ? `${errors} ${errors === 1 ? "error" : "errors"}` : null,
    warnings ? `${warnings} ${warnings === 1 ? "warning" : "warnings"}` : null,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <details className="diagnostics" open={errors > 0}>
      <summary>
        <span>Configuration diagnostics</span>
        <span className={errors ? "badge badge--error" : "badge badge--warning"}>{summary}</span>
      </summary>
      <ul>
        {diagnostics.map((diagnostic, index) => (
          <DiagnosticItem diagnostic={diagnostic} key={`${diagnostic.code}:${diagnostic.path ?? ""}:${index}`} />
        ))}
      </ul>
    </details>
  );
}

function TrustPanel({
  snapshot,
  pending,
  onTrust,
}: {
  snapshot: ProjectSnapshot;
  pending: boolean;
  onTrust: () => void;
}): ReactNode {
  const localCode = hasLocalNode(snapshot.tree);
  return (
    <section className="trust-panel" aria-labelledby="trust-title">
      <div className="trust-panel__icon" aria-hidden="true">◇</div>
      <div className="trust-panel__content">
        <span className="eyebrow">Project trust</span>
        <h2 id="trust-title">Review this project before enabling capabilities</h2>
        <p>
          Passive layout and content are visible now. Trusting enables only the
          capabilities declared by this project.
        </p>
        <ul className="permission-list">
          {localCode ? <li>Load local component code</li> : null}
          {snapshot.requestedPermissions.map((permission) => (
            <li key={permission}>{PERMISSION_LABELS[permission]}</li>
          ))}
          {!localCode && snapshot.requestedPermissions.length === 0 ? (
            <li>No privileged capabilities requested</li>
          ) : null}
        </ul>
      </div>
      <button className="button button--primary" type="button" disabled={pending} onClick={onTrust}>
        {pending ? "Enabling…" : "Trust project"}
      </button>
    </section>
  );
}

function EmptyProject({
  pending,
  onChoose,
}: {
  pending: boolean;
  onChoose: () => void;
}): ReactNode {
  return (
    <main className="welcome">
      <div className="welcome__mark" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <span className="eyebrow">Local-first project cockpit</span>
      <h1>Put the project in front of you.</h1>
      <p>
        Choose a project folder to load its workflows, status, and tools into one
        focused workspace. Missing <code>dash-bored/</code> files are created for you.
      </p>
      <button className="button button--primary button--large" type="button" disabled={pending} onClick={onChoose}>
        {pending ? "Opening…" : "Choose a project"}
      </button>
    </main>
  );
}

function SettingsPanel({
  snapshot,
  pendingAction,
  onReload,
  onTrust,
  onRevoke,
}: {
  snapshot: ProjectSnapshot | null;
  pendingAction: string | null;
  onReload: () => void;
  onTrust: () => void;
  onRevoke: () => void;
}): ReactNode {
  return (
    <main className="settings-page" aria-labelledby="settings-title">
      <div className="settings-page__heading">
        <span className="eyebrow">Application</span>
        <h1 id="settings-title">Settings</h1>
        <p>Manage the active dashboard and its local capabilities.</p>
      </div>
      <section className="settings-card" aria-labelledby="sidebar-settings-title">
        <div>
          <h2 id="sidebar-settings-title">Dashboard sidebar</h2>
          <p>The sidebar starts collapsed each time dash-bored opens. Expand it to see configured dashboard names.</p>
        </div>
        <span className="settings-value">Collapsed by default</span>
      </section>
      <section className="settings-card" aria-labelledby="project-settings-title">
        <div className="settings-card__project">
          <h2 id="project-settings-title">Active dashboard</h2>
          {snapshot?.projectRoot ? (
            <>
              <strong>{snapshot.dashboardName?.trim() || basename(snapshot.projectRoot)}</strong>
              <code title={snapshot.projectRoot}>{snapshot.projectRoot}</code>
            </>
          ) : (
            <p>No dashboard is currently open.</p>
          )}
        </div>
        {snapshot?.projectRoot ? (
          <div className="settings-card__actions">
            <button className="button button--quiet" type="button" disabled={pendingAction !== null} onClick={onReload}>
              {pendingAction === "reload" ? "Reloading…" : "Reload dashboard"}
            </button>
            {snapshot.trusted ? (
              <button className="button button--danger" type="button" disabled={pendingAction !== null} onClick={onRevoke}>
                {pendingAction === "revoke" ? "Revoking…" : "Revoke trust"}
              </button>
            ) : (
              <button className="button button--primary" type="button" disabled={pendingAction !== null || snapshot.tree === null} onClick={onTrust}>
                {pendingAction === "trust" ? "Enabling…" : "Trust dashboard"}
              </button>
            )}
          </div>
        ) : null}
      </section>
    </main>
  );
}

export function App(): ReactNode {
  const [snapshot, setSnapshot] = useState<ProjectSnapshot | null>(null);
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [sidebarExpanded, setSidebarExpanded] = useState(false);
  const [expandedProjectOutlines, setExpandedProjectOutlines] = useState<Record<string, boolean>>({});
  const [projectOutlines, setProjectOutlines] = useState<Record<string, ProjectOutlineState>>({});
  const [activeView, setActiveView] = useState<AppView>("dashboard");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [virtualRoots, setVirtualRoots] = useState<Record<string, string | null>>({});
  const [editSession, setEditSession] = useState<{
    projectRoot: string;
    configPath: string;
    componentCatalog: ComponentCatalogItem[];
    original: DashboardConfig;
    draft: DashboardConfig;
    expectedConfigRevision: string;
    validation: DashboardDraftValidation;
  } | null>(null);
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
  const localComponents = useLocalComponents(snapshot?.components ?? []);
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

  useEffect(() => {
    let active = true;
    const unsubscribe = host.subscribe((event) => {
      if (!active) return;
      if (event.type === "snapshot") {
        setSnapshot(event.snapshot);
        setProjects((current) => rememberProject(current, event.snapshot));
      } else if (event.type === "process") {
        setSnapshot((current) =>
          current ? replaceProcess(current, event.process) : current,
        );
      } else {
        setPaletteOpen(true);
      }
    });

    void Promise.all([host.getSnapshot(), host.listProjects()])
      .then(([initialSnapshot, initialProjects]) => {
        if (!active) return;
        setSnapshot(initialSnapshot);
        setProjects(rememberProject(initialProjects, initialSnapshot));
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
    const snapshotProjectRoot = snapshot?.projectRoot;
    if (!snapshotProjectRoot) return;
    setProjectOutlines((current) => ({
      ...current,
      [snapshotProjectRoot]: {
        tree: snapshot.tree,
        loading: false,
        error: outlineError(snapshot),
      },
    }));
  }, [snapshot?.projectRoot, snapshot?.revision, snapshot?.tree, snapshot?.diagnostics]);

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
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLocaleLowerCase() === "k"
      ) {
        event.preventDefault();
        setPaletteOpen(true);
      }
    }
    window.addEventListener("keydown", openFromKeyboard);
    return () => window.removeEventListener("keydown", openFromKeyboard);
  }, []);

  const processes = useMemo(
    () => new Map(snapshot?.processes.map((process) => [process.id, process]) ?? []),
    [snapshot?.processes],
  );

  async function perform(name: string, action: () => Promise<unknown>): Promise<void> {
    setPendingAction(name);
    setActionError(null);
    try {
      await action();
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setPendingAction(null);
    }
  }

  function editSessionDirty(): boolean {
    return Boolean(editSession && JSON.stringify(editSession.original) !== JSON.stringify(editSession.draft));
  }

  function requireDiscard(message: string, continueAction: () => void): boolean {
    if (!editSessionDirty()) {
      setEditSession(null);
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

  async function openSelectedProject(projectRoot: string): Promise<void> {
    if (snapshot?.projectRoot === projectRoot) {
      setActiveView("dashboard");
      return;
    }
    await perform(`open:${projectRoot}`, async () => {
      await host.openProject(projectRoot);
      setActiveView("dashboard");
    });
  }

  async function selectProject(projectRoot: string): Promise<void> {
    if (editSession && editSession.projectRoot !== projectRoot && !requireDiscard(
      "Discard the unsaved dashboard changes and switch projects?",
      () => void openSelectedProject(projectRoot),
    )) return;
    await openSelectedProject(projectRoot);
  }

  function toggleProjectOutline(project: ProjectListItem): void {
    const projectRoot = project.projectRoot;
    const closing = expandedProjectOutlines[projectRoot] === true;
    setExpandedProjectOutlines((current) => ({ ...current, [projectRoot]: !closing }));
    if (closing || snapshot?.projectRoot === projectRoot) return;

    setProjectOutlines((current) => ({
      ...current,
      [projectRoot]: {
        tree: current[projectRoot]?.tree ?? null,
        loading: true,
        error: null,
      },
    }));
    void host.getProjectOutline(projectRoot)
      .then((outline) => {
        setProjectOutlines((current) => ({
          ...current,
          [projectRoot]: {
            tree: outline.tree,
            loading: false,
            error: outlineError(outline),
          },
        }));
      })
      .catch((error: unknown) => {
        setProjectOutlines((current) => ({
          ...current,
          [projectRoot]: {
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
      editSession?.projectRoot === project.projectRoot &&
      !requireDiscard(
        "Discard the unsaved dashboard changes and remove this dashboard?",
        () => void openDeletionDialog(project, true),
      )
    ) return;

    await perform(`preview-delete:${project.projectRoot}`, async () => {
      const preview = await host.getProjectDeletionPreview(project.projectRoot);
      setDeletionDialog({ project, preview, removeFiles: false });
    });
  }

  async function confirmDeletion(): Promise<void> {
    if (!deletionDialog) return;
    const request = deletionDialog;
    const wasActive = snapshot?.projectRoot === request.project.projectRoot;
    const activeProjectIndex = projects.findIndex(
      (project) => project.projectRoot === request.project.projectRoot,
    );
    setDeletionDialog(null);
    setPendingAction(`delete:${request.project.projectRoot}`);
    setActionError(null);
    try {
      await host.deleteProject(request.project.projectRoot, request.removeFiles);
      const remaining = await host.listProjects();
      setProjects(remaining);
      setEditSession((current) =>
        current?.projectRoot === request.project.projectRoot ? null : current,
      );
      setVirtualRoots((current) => {
        if (!Object.hasOwn(current, request.project.projectRoot)) return current;
        const next = { ...current };
        delete next[request.project.projectRoot];
        return next;
      });
      setExpandedProjectOutlines((current) => {
        if (!Object.hasOwn(current, request.project.projectRoot)) return current;
        const next = { ...current };
        delete next[request.project.projectRoot];
        return next;
      });
      setProjectOutlines((current) => {
        if (!Object.hasOwn(current, request.project.projectRoot)) return current;
        const next = { ...current };
        delete next[request.project.projectRoot];
        return next;
      });
      try {
        window.localStorage.removeItem(virtualRootStorageKey(request.project.projectRoot));
      } catch {
        // The in-memory focus state has already been cleared.
      }

      if (wasActive) {
        setActiveView("dashboard");
        const nextIndex = Math.min(
          Math.max(activeProjectIndex, 0),
          Math.max(remaining.length - 1, 0),
        );
        const nextProject = remaining[nextIndex];
        if (nextProject) await host.openProject(nextProject.projectRoot);
      }
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setPendingAction(null);
    }
  }

  async function startProjectEditor(projectRoot: string): Promise<void> {
    await perform(`edit:${projectRoot}`, async () => {
      if (snapshot?.projectRoot !== projectRoot) await host.openProject(projectRoot);
      const focusedSource = snapshot?.projectRoot === projectRoot
        ? virtualRoot?.node.sourceConfigPath
        : undefined;
      const source = await host.getDashboardConfigSource(focusedSource);
      const validation = await host.validateDashboardDraft(source.config, source.configPath);
      setActiveView("dashboard");
      setEditSession({
        projectRoot,
        configPath: source.configPath,
        componentCatalog: source.componentCatalog,
        original: structuredClone(source.config),
        draft: structuredClone(source.config),
        expectedConfigRevision: source.configRevision,
        validation,
      });
    });
  }

  function cancelDashboardEdit(): void {
    if (!editSession) return;
    if (requireDiscard("Discard the unsaved dashboard changes and exit edit mode?", () => undefined)) {
      setEditSession(null);
    }
  }

  async function toggleProjectEditor(projectRoot: string): Promise<void> {
    if (editSession?.projectRoot === projectRoot) {
      cancelDashboardEdit();
      return;
    }
    if (editSession && !requireDiscard(
      "Discard the unsaved dashboard changes and edit another project?",
      () => void startProjectEditor(projectRoot),
    )) return;
    await startProjectEditor(projectRoot);
  }

  function showSettings(): void {
    if (editSession && !requireDiscard(
      "Discard the unsaved dashboard changes and open settings?",
      () => setActiveView("settings"),
    )) return;
    setActiveView("settings");
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
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setSavingDraft(false);
    }
  }

  const editingCurrentProject = Boolean(editSession && editSession.projectRoot === snapshot?.projectRoot);
  const draftDirty = editingCurrentProject && editSessionDirty();
  const draftValid = editingCurrentProject && Boolean(
    editSession?.validation.diagnostics.every((item) => item.severity !== "error"),
  );
  const applicationActions = buildApplicationActions({
    snapshot,
    projects,
    activeView,
    sidebarExpanded,
    pendingAction,
    editing: editingCurrentProject,
    draftDirty,
    draftValid,
    savingDraft,
    callbacks: {
      showDashboard: () => setActiveView("dashboard"),
      showSettings,
      toggleSidebar: () => setSidebarExpanded((expanded) => !expanded),
      addDashboard,
      openProject: selectProject,
      editDashboard: () => snapshot?.projectRoot
        ? toggleProjectEditor(snapshot.projectRoot)
        : undefined,
      saveDashboard: () => saveDashboardDraft(),
      cancelDashboard: cancelDashboardEdit,
      reloadProject: () => perform("reload", host.reloadProject),
      trustProject: () => perform("trust", host.trustProject),
      revokeTrust: () => perform("revoke", host.revokeTrust),
      startProcess: async (nodeId) => {
        await host.startProcess(nodeId);
      },
      stopProcess: async (nodeId) => {
        await host.stopProcess(nodeId);
      },
    },
  });
  const projectRoot = snapshot?.projectRoot ?? null;
  const storedVirtualRoot = projectRoot ? virtualRoots[projectRoot] : null;
  const virtualRoot = snapshot?.tree
    ? resolveVirtualRoot(snapshot.tree, storedVirtualRoot ?? null)
    : null;

  useEffect(() => {
    if (!projectRoot || Object.hasOwn(virtualRoots, projectRoot)) return;
    let saved: string | null = null;
    try {
      saved = window.localStorage.getItem(virtualRootStorageKey(projectRoot));
    } catch {
      // Local storage can be unavailable in hardened webviews; focus still works for this session.
    }
    setVirtualRoots((current) => Object.hasOwn(current, projectRoot)
      ? current
      : { ...current, [projectRoot]: saved });
  }, [projectRoot, virtualRoots]);

  useEffect(() => {
    if (!projectRoot || !snapshot?.tree || !storedVirtualRoot) return;
    const resolved = resolveVirtualRoot(snapshot.tree, storedVirtualRoot);
    if (resolved.node.id === storedVirtualRoot) return;
    setVirtualRoots((current) => ({ ...current, [projectRoot]: null }));
    try {
      window.localStorage.removeItem(virtualRootStorageKey(projectRoot));
    } catch {
      // See the read path above.
    }
  }, [projectRoot, snapshot?.tree, storedVirtualRoot]);

  function storeVirtualRoot(targetProjectRoot: string, nodeId: string): void {
    setVirtualRoots((current) => ({ ...current, [targetProjectRoot]: nodeId }));
    try {
      window.localStorage.setItem(virtualRootStorageKey(targetProjectRoot), nodeId);
    } catch {
      // Session state remains usable when persistence is unavailable.
    }
  }

  function focusComponent(nodeId: string): void {
    if (!projectRoot) return;
    storeVirtualRoot(projectRoot, nodeId);
  }

  async function focusProjectNode(targetProjectRoot: string, nodeId: string): Promise<void> {
    if (snapshot?.projectRoot === targetProjectRoot) {
      setActiveView("dashboard");
      storeVirtualRoot(targetProjectRoot, nodeId);
      return;
    }
    if (editSession && editSession.projectRoot !== targetProjectRoot && !requireDiscard(
      "Discard the unsaved dashboard changes and navigate to another dashboard node?",
      () => void focusProjectNode(targetProjectRoot, nodeId),
    )) return;

    let opened = false;
    await perform(`open:${targetProjectRoot}`, async () => {
      await host.openProject(targetProjectRoot);
      setActiveView("dashboard");
      opened = true;
    });
    if (opened) storeVirtualRoot(targetProjectRoot, nodeId);
  }

  const nodeFocusActions = buildNodeFocusActions(
    snapshot,
    virtualRoot?.node.id ?? null,
    editingCurrentProject,
    (nodeId) => {
      setActiveView("dashboard");
      focusComponent(nodeId);
    },
  );
  const allActions = [...applicationActions, ...nodeFocusActions, ...componentActions];
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
  const headerTitle = activeView === "settings" ? "Settings" : title;
  const headerProjectRoot = snapshot?.projectRoot;
  const actionScope = `${snapshot?.projectRoot ?? "no-project"}\u0000${
    snapshot?.revision ?? 0
  }\u0000${snapshot?.trusted ? "trusted" : "restricted"}`;
  const shortcutLabel =
    typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)
      ? "⌘K"
      : "Ctrl K";
  return (
    <div className="app-window">
      <div className="window-chrome" aria-hidden="true" />
      <div className={`app-shell${sidebarExpanded ? " app-shell--sidebar-expanded" : ""}`}>
      <aside className="sidebar" aria-label="Dashboards">
        <button
          className="sidebar__toggle"
          type="button"
          aria-expanded={sidebarExpanded}
          aria-label={sidebarExpanded ? "Collapse sidebar" : "Expand sidebar"}
          title={sidebarExpanded ? "Collapse sidebar" : "Expand sidebar"}
          onClick={() => setSidebarExpanded((expanded) => !expanded)}
        >
          <div className="brand-mark" aria-hidden="true"><span /><span /><span /></div>
          <span className="sidebar__brand">dash-bored</span>
          <span className="sidebar__chevron"><ShellIcon name={sidebarExpanded ? "collapse" : "expand"} /></span>
        </button>

        <nav className="sidebar__projects" aria-label="Projects">
          {projects.map((project, projectIndex) => {
            const label = projectLabel(project);
            const active = activeView === "dashboard" && project.projectRoot === snapshot?.projectRoot;
            const opening = pendingAction === `open:${project.projectRoot}`;
            const outlineExpanded = expandedProjectOutlines[project.projectRoot] === true;
            const outline = projectOutlines[project.projectRoot] ?? {
              tree: null,
              loading: false,
              error: null,
            };
            const outlineId = `sidebar-project-tree-${projectIndex}`;
            return (
              <div className="sidebar__project" key={project.projectRoot}>
                <div className="sidebar__project-row">
                  <button
                    className={`sidebar__item sidebar__project-link${active ? " sidebar__item--active" : ""}`}
                    type="button"
                    aria-current={active ? "page" : undefined}
                    aria-label={label}
                    title={label}
                    disabled={pendingAction !== null}
                    onClick={() => void selectProject(project.projectRoot)}
                  >
                    <span className="sidebar__item-icon"><ShellIcon name="project" /></span>
                    <span className="sidebar__label">{opening ? "Opening…" : label}</span>
                  </button>
                  <button
                    className={`sidebar__project-action sidebar__project-tree-toggle${outlineExpanded ? " sidebar__project-tree-toggle--active" : ""}`}
                    type="button"
                    aria-label={`${outlineExpanded ? "Collapse" : "Show"} ${label} tree`}
                    aria-expanded={outlineExpanded}
                    aria-controls={outlineId}
                    title={outlineExpanded ? "Collapse dashboard tree" : "Show dashboard tree"}
                    tabIndex={sidebarExpanded ? 0 : -1}
                    disabled={pendingAction !== null}
                    onClick={() => toggleProjectOutline(project)}
                  >
                    <ShellIcon name="tree" />
                  </button>
                  <button
                    className="sidebar__project-action sidebar__project-remove"
                    type="button"
                    aria-label={`Remove ${label}`}
                    title="Remove dashboard"
                    tabIndex={sidebarExpanded ? 0 : -1}
                    disabled={pendingAction !== null}
                    onClick={() => void openDeletionDialog(project)}
                  >
                    <ShellIcon name="trash" />
                  </button>
                </div>
                {outlineExpanded ? (
                  <div id={outlineId}>
                    <DashboardOutlineTree
                      tree={outline.tree}
                      loading={outline.loading}
                      error={outline.error}
                      label={label}
                      onSelect={(nodeId) => void focusProjectNode(project.projectRoot, nodeId)}
                    />
                  </div>
                ) : null}
              </div>
            );
          })}
        </nav>

        <div className="sidebar__footer">
          <button className="sidebar__item" type="button" aria-label="Add dashboard" title="Add dashboard" disabled={pendingAction !== null} onClick={() => void addDashboard()}>
            <span className="sidebar__item-icon"><ShellIcon name="add" /></span>
            <span className="sidebar__label">{pendingAction === "choose" ? "Opening…" : "Add dashboard"}</span>
          </button>
          <button className={`sidebar__item${activeView === "settings" ? " sidebar__item--active" : ""}`} type="button" aria-label="Settings" title="Settings" onClick={showSettings}>
            <span className="sidebar__item-icon"><ShellIcon name="settings" /></span>
            <span className="sidebar__label">Settings</span>
          </button>
        </div>
      </aside>

      <div className="app-frame">
        <header className={`app-header${editingCurrentProject ? " app-header--editing" : ""}`}>
          <div className="app-header__identity">
            <div>
              <span className="app-header__title">{headerTitle}</span>
              {activeView === "settings" ? (
                <span className="app-header__path">Application preferences</span>
              ) : snapshot?.projectRoot ? (
                <span className="app-header__path" title={snapshot.projectRoot}>{snapshot.projectRoot}</span>
              ) : (
                <span className="app-header__path">No project open</span>
              )}
            </div>
          </div>
          <div className="app-header__actions">
            <button
              className="command-palette-trigger"
              type="button"
              aria-label={`Open command palette, ${shortcutLabel}`}
              onClick={() => setPaletteOpen(true)}
            >
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <circle cx="8.5" cy="8.5" r="4.5" />
                <path d="m12 12 4 4" />
              </svg>
              <span>Commands</span>
              <kbd>{shortcutLabel}</kbd>
            </button>
            {activeView === "dashboard" && headerProjectRoot ? (
              <>
                {editSession && editingCurrentProject ? (
                  <div className="app-header__editor-toolbar">
                    <DashboardEditorToolbar
                      diagnostics={editSession.validation.diagnostics}
                      saving={savingDraft}
                      dirty={editSessionDirty()}
                      onSave={() => void saveDashboardDraft()}
                      onCancel={cancelDashboardEdit}
                    />
                  </div>
                ) : null}
                {!editingCurrentProject ? (
                  <button
                    className="button button--quiet dashboard-edit-toggle"
                    type="button"
                    aria-label="Edit dashboard"
                    title="Edit dashboard"
                    disabled={pendingAction !== null}
                    onClick={() => {
                      if (headerProjectRoot) void toggleProjectEditor(headerProjectRoot);
                    }}
                  >
                    <ShellIcon name="edit" />
                    <span>Edit dashboard</span>
                  </button>
                ) : null}
              </>
            ) : null}
          </div>
        </header>

        {actionError ? (
          <div className="global-error" role="alert">
            <strong>Action failed</strong>
            <span>{actionError}</span>
            <button type="button" aria-label="Dismiss error" onClick={() => setActionError(null)}>×</button>
          </div>
        ) : null}

        {activeView === "settings" ? (
          <SettingsPanel
            snapshot={snapshot}
            pendingAction={pendingAction}
            onReload={() => void perform("reload", host.reloadProject)}
            onTrust={() => void perform("trust", host.trustProject)}
            onRevoke={() => void perform("revoke", host.revokeTrust)}
          />
        ) : !snapshot?.projectRoot ? (
          <EmptyProject pending={pendingAction === "choose"} onChoose={() => void addDashboard()} />
        ) : (
          <main className="workspace">
            {editSession && editSession.projectRoot === snapshot.projectRoot ? (
              <DashboardEditor
                config={editSession.draft}
                catalog={editSession.componentCatalog}
                diagnostics={editSession.validation.diagnostics}
                onChange={(draft) => setEditSession((current) => current ? { ...current, draft } : current)}
              />
            ) : (
              <>
            {!snapshot.trusted ? (
              <TrustPanel snapshot={snapshot} pending={pendingAction === "trust"} onTrust={() => void perform("trust", host.trustProject)} />
            ) : null}

            <Diagnostics diagnostics={snapshot.diagnostics} />

            {snapshot.tree ? (
              <section className="dashboard" aria-label={`${title} dashboard`}>
                {virtualRoot && virtualRoot.crumbs.length > 1 ? (
                  <nav className="dashboard-breadcrumbs" aria-label="Focused component path">
                    {virtualRoot.crumbs.map((crumb, index) => (
                      <span className="dashboard-breadcrumbs__item" key={crumb.id}>
                        {index < virtualRoot.crumbs.length - 1 ? (
                          <button type="button" onClick={() => focusComponent(crumb.id)}>{crumb.label}</button>
                        ) : <span aria-current="page">{crumb.label}</span>}
                        {index < virtualRoot.crumbs.length - 1 ? <span aria-hidden="true">/</span> : null}
                      </span>
                    ))}
                  </nav>
                ) : null}
                <NodeRenderer
                  node={virtualRoot?.node ?? snapshot.tree}
                  trusted={snapshot.trusted}
                  processes={processes}
                  localComponents={localComponents}
                  actionRegistry={actionRegistry}
                  actionScope={actionScope}
                  onFocus={focusComponent}
                  isVirtualRoot
                />
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
        </div>
      </div>
      <CommandPalette
        open={paletteOpen}
        actions={allActions}
        runningActionIds={runningActionIds}
        onDismiss={() => setPaletteOpen(false)}
        onExecute={(id) => void executePaletteAction(id)}
      />
      {discardConfirmation ? (
        <EditorModal title="Discard dashboard changes?" onDismiss={() => setDiscardConfirmation(null)}>
          <div className="remove-confirmation">
            <p>{discardConfirmation.message}</p>
            <p>This draft has not been written to dash-bored.yaml.</p>
            <footer className="editor-modal__actions">
              <button className="button button--quiet" type="button" onClick={() => setDiscardConfirmation(null)}>Keep editing</button>
              <button className="button button--danger" type="button" onClick={() => {
                const continueAction = discardConfirmation.continueAction;
                setDiscardConfirmation(null);
                setEditSession(null);
                queueMicrotask(continueAction);
              }}>Discard changes</button>
            </footer>
          </div>
        </EditorModal>
      ) : null}
      {deletionDialog ? (
        <EditorModal title="Remove dashboard?" onDismiss={() => setDeletionDialog(null)}>
          <div className="remove-confirmation dashboard-delete-confirmation">
            <p>
              Remove <strong>{projectLabel(deletionDialog.project)}</strong> from the dash-bored sidebar?
              The dashboard entry is removed by default; its project files stay on disk.
            </p>

            {deletionDialog.preview.dependencies.length > 0 ? (
              <section className="dashboard-delete-dependencies" aria-labelledby="dashboard-delete-dependencies-title">
                <h3 id="dashboard-delete-dependencies-title">Dashboards that use these files</h3>
                <p>
                  These links may stop working if the app-owned project files are moved to Trash.
                </p>
                <ul>
                  {deletionDialog.preview.dependencies.map((dependency) => (
                    <li key={dependency.projectRoot}>
                      <strong>{dependency.dashboardName?.trim() || basename(dependency.projectRoot)}</strong>
                      <ul>
                        {dependency.configPaths.map((configPath) => <li key={configPath}><code>{configPath}</code></li>)}
                      </ul>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {!deletionDialog.preview.analysisComplete ? (
              <section className="dashboard-delete-issues" role="alert">
                <strong>File removal is unavailable</strong>
                <p>
                  dash-bored could not safely complete dependency analysis, so the project files cannot be moved to Trash from this dialog.
                </p>
                <ul>
                  {deletionDialog.preview.analysisIssues.map((issue) => <li key={issue}>{issue}</li>)}
                </ul>
              </section>
            ) : null}

            {deletionDialog.preview.filesExist ? (
              <label className={`dashboard-delete-files-option${deletionDialog.removeFiles ? " dashboard-delete-files-option--selected" : ""}`}>
                <input
                  type="checkbox"
                  checked={deletionDialog.removeFiles}
                  disabled={!deletionDialog.preview.analysisComplete}
                  onChange={(event) => setDeletionDialog((current) => current ? { ...current, removeFiles: event.target.checked } : current)}
                />
                <span>
                  <strong>Also move project files to Trash</strong>
                  <small>Moves only {deletionDialog.preview.filesDirectory} and its nested dash-bored bundles, components, locks, and environment files.</small>
                </span>
              </label>
            ) : (
              <p className="dashboard-delete-no-files">No app-owned dash-bored/ directory was found, so only the sidebar entry will be removed.</p>
            )}

            {deletionDialog.removeFiles ? (
              <section className="dashboard-delete-warning" role="alert">
                <strong>Project files will be moved to the OS Trash.</strong>
                <p>This removes the dashboard’s app-owned files and can break the links listed above. Source project files outside dash-bored/ are never touched.</p>
              </section>
            ) : null}

            <footer className="editor-modal__actions">
              <button className="button button--quiet" data-modal-close type="button" onClick={() => setDeletionDialog(null)}>Cancel</button>
              <button
                className="button button--danger"
                type="button"
                disabled={deletionDialog.removeFiles && !deletionDialog.preview.analysisComplete}
                onClick={() => void confirmDeletion()}
              >
                {deletionDialog.removeFiles ? "Move files to Trash & remove" : "Remove dashboard"}
              </button>
            </footer>
          </div>
        </EditorModal>
      ) : null}
    </div>
  );
}
