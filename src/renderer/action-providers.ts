import type {
  Permission,
  ProcessSnapshot,
  ProjectListItem,
  ProjectSnapshot,
  ResolvedComponentNode,
} from "../shared/contracts";
import type { PaletteAction } from "./actions";

export type AppView = "dashboard" | "settings";

export const PERMISSION_LABELS: Record<Permission, string> = {
  "filesystem:read": "Read workspace files",
  "filesystem:write": "Write workspace files",
  "network:http": "Make HTTP requests",
  "process:execute": "Run project commands",
};

export interface ApplicationActionCallbacks {
  showDashboard(): void;
  showSettings(): void;
  toggleSidebar(): void;
  addDashboard(): void | Promise<void>;
  openProject(projectRoot: string): void | Promise<void>;
  editDashboard(): void | Promise<void>;
  saveDashboard(): void | Promise<void>;
  cancelDashboard(): void | Promise<void>;
  reloadProject(): void | Promise<void>;
  trustProject(): void | Promise<void>;
  revokeTrust(): void | Promise<void>;
  startProcess(nodeId: string): void | Promise<void>;
  stopProcess(nodeId: string): void | Promise<void>;
}

export interface ApplicationActionContext {
  snapshot: ProjectSnapshot | null;
  projects: readonly ProjectListItem[];
  activeView: AppView;
  sidebarExpanded: boolean;
  pendingAction: string | null;
  editing: boolean;
  draftDirty: boolean;
  draftValid: boolean;
  savingDraft: boolean;
  callbacks: ApplicationActionCallbacks;
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

export function projectLabel(project: ProjectListItem): string {
  return project.dashboardName?.trim() || basename(project.projectRoot);
}

export function hasLocalNode(node: ResolvedComponentNode | null): boolean {
  if (!node) return false;
  if (node.source === "local") return true;
  return Object.values(node.slots).some((children) =>
    children.some((child) => hasLocalNode(child)),
  );
}

function trustMessage(snapshot: ProjectSnapshot): string {
  const capabilities = snapshot.requestedPermissions.map(
    (permission) => PERMISSION_LABELS[permission].toLocaleLowerCase(),
  );
  if (hasLocalNode(snapshot.tree)) capabilities.unshift("load local component code");
  if (capabilities.length === 0) {
    return "This project requests no privileged capabilities.";
  }
  return `This will allow the project to ${capabilities.join(", ")}.`;
}

function blockedReason(pendingAction: string | null): string | undefined {
  return pendingAction === null
    ? undefined
    : "Another application action is in progress.";
}

function focusNodeLabel(node: ResolvedComponentNode, isRoot: boolean): string {
  if (isRoot) return "Dashboard";
  const title = node.props.title ?? node.props.label ?? node.props.name;
  if (typeof title === "string" && title.trim()) return title.trim();
  return node.manifest?.name ?? node.component.replace(/^@dash-bored\//, "");
}

interface FocusNodeContext {
  node: ResolvedComponentNode;
  path: string[];
}

function dashboardNodes(
  node: ResolvedComponentNode,
  path: readonly string[] = [],
  isRoot = true,
): FocusNodeContext[] {
  const label = focusNodeLabel(node, isRoot);
  const nextPath = [...path, label];
  return [
    { node, path: nextPath },
    ...Object.values(node.slots).flatMap((children) =>
      children.flatMap((child) => dashboardNodes(child, nextPath, false)),
    ),
  ];
}

export function buildNodeFocusActions(
  snapshot: ProjectSnapshot | null,
  focusedNodeId: string | null,
  editing: boolean,
  focusNode: (nodeId: string) => void,
): PaletteAction[] {
  if (!snapshot?.projectRoot || !snapshot.tree) return [];

  return dashboardNodes(snapshot.tree).map(({ node, path }) => {
    const alreadyFocused = node.id === focusedNodeId;
    const disabledReason = editing
      ? "Finish dashboard editing before focusing a node."
      : alreadyFocused
        ? "This node is already focused."
        : undefined;
    return {
      id: `focus:${encodeURIComponent(node.id)}`,
      label: `Focus ${path.at(-1)}`,
      description: `Show ${path.join(" / ")} in the active dashboard.`,
      keywords: [
        "focus",
        "node",
        snapshot.dashboardName ?? "",
        node.id,
        node.component,
        ...path,
      ],
      group: "Dashboard nodes",
      source: node.id,
      enabled: disabledReason === undefined,
      ...(disabledReason ? { disabledReason } : {}),
      run: () => focusNode(node.id),
    } satisfies PaletteAction;
  });
}

function appAction(
  action: Omit<PaletteAction, "keywords" | "enabled"> & {
    keywords?: string[];
    enabled?: boolean;
  },
): PaletteAction {
  return {
    ...action,
    keywords: action.keywords ?? [],
    enabled: action.enabled !== false,
  };
}

export function buildApplicationActions(
  context: ApplicationActionContext,
): PaletteAction[] {
  const {
    snapshot,
    projects,
    activeView,
    sidebarExpanded,
    pendingAction,
    editing,
    draftDirty,
    draftValid,
    savingDraft,
    callbacks,
  } =
    context;
  const projectOpen = snapshot?.projectRoot !== null && snapshot?.projectRoot !== undefined;
  const pendingReason = blockedReason(pendingAction);
  const actions: PaletteAction[] = [
    appAction({
      id: "app:show-dashboard",
      label: "Show dashboard",
      description: "Return to the active project dashboard.",
      group: "Application",
      enabled: projectOpen && activeView !== "dashboard",
      disabledReason: !projectOpen
        ? "No dashboard is open."
        : "The dashboard is already visible.",
      run: callbacks.showDashboard,
    }),
    appAction({
      id: "app:show-settings",
      label: "Open settings",
      description: "Manage the active dashboard and its capabilities.",
      group: "Application",
      enabled: activeView !== "settings",
      disabledReason: "Settings are already visible.",
      run: callbacks.showSettings,
    }),
    appAction({
      id: "app:toggle-sidebar",
      label: sidebarExpanded ? "Collapse sidebar" : "Expand sidebar",
      description: "Toggle the dashboard navigation sidebar.",
      keywords: ["navigation", "projects"],
      group: "Application",
      run: callbacks.toggleSidebar,
    }),
    appAction({
      id: "app:add-dashboard",
      label: "Add dashboard",
      description: "Choose another project folder.",
      keywords: ["open", "project", "folder", "chooser"],
      group: "Application",
      enabled: pendingAction === null,
      ...(pendingReason ? { disabledReason: pendingReason } : {}),
      run: callbacks.addDashboard,
    }),
  ];

  for (const project of projects) {
    const label = projectLabel(project);
    const current =
      project.projectRoot === snapshot?.projectRoot && activeView === "dashboard";
    actions.push(
      appAction({
        id: `dashboard:${encodeURIComponent(project.projectRoot)}`,
        label: `Open ${label}`,
        description: project.projectRoot,
        keywords: ["dashboard", "project", project.projectRoot],
        group: "Dashboards",
        source: project.projectRoot,
        enabled: pendingAction === null && !current,
        disabledReason: current
          ? "This dashboard is already open."
          : pendingReason,
        run: () => callbacks.openProject(project.projectRoot),
      }),
    );
  }

  if (projectOpen && snapshot) {
    const editingBlockedReason = !editing
      ? activeView !== "dashboard"
        ? "Open the dashboard before editing."
        : pendingReason
      : "The dashboard is already in edit mode.";
    const saveBlockedReason = !editing
      ? "Enter dashboard edit mode first."
      : savingDraft
        ? "The dashboard draft is already being saved."
        : !draftDirty
          ? "There are no dashboard changes to save."
          : !draftValid
            ? "Fix dashboard validation errors before saving."
            : pendingReason;
    const cancelBlockedReason = !editing
      ? "No dashboard draft is being edited."
      : savingDraft
        ? "The dashboard draft is being saved."
        : pendingReason;
    actions.push(
      appAction({
        id: "project:edit",
        label: "Edit dashboard",
        description: "Open the structural editor for the active dashboard.",
        keywords: ["editor", "draft", "configure"],
        group: "Dashboard editing",
        enabled: activeView === "dashboard" && !editing && pendingAction === null,
        ...(editingBlockedReason ? { disabledReason: editingBlockedReason } : {}),
        run: callbacks.editDashboard,
      }),
      appAction({
        id: "project:save-draft",
        label: "Save dashboard changes",
        description: "Write the current dashboard draft to its YAML configuration.",
        keywords: ["editor", "draft", "write", "persist"],
        group: "Dashboard editing",
        enabled: editing && draftDirty && draftValid && !savingDraft && pendingAction === null,
        ...(saveBlockedReason ? { disabledReason: saveBlockedReason } : {}),
        run: callbacks.saveDashboard,
      }),
      appAction({
        id: "project:cancel-edit",
        label: "Cancel dashboard editing",
        description: "Discard the current dashboard draft and leave edit mode.",
        keywords: ["editor", "draft", "discard", "close"],
        group: "Dashboard editing",
        enabled: editing && !savingDraft && pendingAction === null,
        ...(cancelBlockedReason ? { disabledReason: cancelBlockedReason } : {}),
        run: callbacks.cancelDashboard,
      }),
    );
    actions.push(
      appAction({
        id: "project:reload",
        label: "Reload dashboard",
        description: "Reload configuration and local components from disk.",
        keywords: ["refresh", snapshot.projectRoot ?? ""],
        group: "Dashboard",
        enabled: pendingAction === null,
        ...(pendingReason ? { disabledReason: pendingReason } : {}),
        run: callbacks.reloadProject,
      }),
    );

    if (snapshot.trusted) {
      actions.push(
        appAction({
          id: "project:revoke-trust",
          label: "Revoke project trust",
          description: "Disable local code and privileged capabilities.",
          keywords: ["security", "permissions", "capabilities"],
          group: "Dashboard",
          enabled: pendingAction === null,
          ...(pendingReason ? { disabledReason: pendingReason } : {}),
          confirmation: {
            title: "Revoke project trust?",
            message:
              "Local components will unload and supervised project processes will stop.",
            confirmLabel: "Revoke trust",
          },
          run: callbacks.revokeTrust,
        }),
      );
    } else {
      actions.push(
        appAction({
          id: "project:trust",
          label: "Trust project",
          description: "Review and enable this project's requested capabilities.",
          keywords: ["security", "permissions", "capabilities"],
          group: "Dashboard",
          enabled: pendingAction === null && snapshot.tree !== null,
          disabledReason:
            snapshot.tree === null
              ? "Fix the configuration before trusting this project."
              : pendingReason,
          confirmation: {
            title: "Trust this project?",
            message: trustMessage(snapshot),
            confirmLabel: "Trust project",
          },
          run: callbacks.trustProject,
        }),
      );
    }
  }

  actions.push(
    ...buildProcessActions(snapshot, pendingAction, {
      start: callbacks.startProcess,
      stop: callbacks.stopProcess,
    }),
  );
  return actions;
}

function commandNodes(node: ResolvedComponentNode | null): ResolvedComponentNode[] {
  if (!node) return [];
  const descendants = Object.values(node.slots).flatMap((children) =>
    children.flatMap(commandNodes),
  );
  return node.component === "@dash-bored/command"
    ? [node, ...descendants]
    : descendants;
}

export function buildProcessActions(
  snapshot: ProjectSnapshot | null,
  pendingAction: string | null,
  callbacks: {
    start(nodeId: string): void | Promise<void>;
    stop(nodeId: string): void | Promise<void>;
  },
): PaletteAction[] {
  if (!snapshot?.tree) return [];
  const processes = new Map(
    snapshot.processes.map((process) => [process.id, process] as const),
  );
  return commandNodes(snapshot.tree).map((node) => {
    const process: ProcessSnapshot | undefined = processes.get(node.id);
    const running = process?.phase === "running" || process?.phase === "stopping";
    const stopping = process?.phase === "stopping";
    const label =
      typeof node.props.label === "string"
        ? node.props.label
        : typeof node.props.title === "string"
          ? node.props.title
          : node.id;
    const command =
      typeof node.props.command === "string" ? node.props.command : undefined;
    const enabled = snapshot.trusted && !stopping && pendingAction === null;
    const disabledReason = !snapshot.trusted
      ? "Trust this project before running configured commands."
      : stopping
        ? "This process is stopping."
        : blockedReason(pendingAction);
    return {
      id: `process:${encodeURIComponent(node.id)}`,
      label: `${running ? "Stop" : "Start"} ${label}`,
      ...(command ? { description: command } : {}),
      keywords: [node.id, "process", "command", command ?? ""],
      group: "Project commands",
      source: node.id,
      enabled,
      ...(disabledReason ? { disabledReason } : {}),
      run: () => (running ? callbacks.stop(node.id) : callbacks.start(node.id)),
    };
  });
}
