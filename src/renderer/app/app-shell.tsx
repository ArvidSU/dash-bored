import { useState, type ReactNode } from "react";
import type { ProjectListItem, ProjectSnapshot, ResolvedComponentNode } from "../../shared/contracts";
import { projectLabel, type AppView } from "../lib/action-providers";
import {
  DashboardOutlineTree,
  type DashboardOutlineNodeAction,
} from "../composition/DashboardOutlineTree";
import { dashboardTitle, type ActionNotice } from "./app-utils";
import { COMPONENT_PICKER_TOGGLE } from "./component-picker";
import {
  notificationMarkLabel,
  notificationTriggerLabel,
  notificationTriggerTitle,
  type NotificationTriggerCounts,
} from "../lib/notifications";
import { NotificationBellIcon } from "../panels/Notifications";

/** Unread open entries of one dashboard by level, as the sidebar marks it. */
export interface NotificationMark {
  interrupt: number;
  inform: number;
}

export interface ProjectOutlineState {
  tree: ProjectSnapshot["tree"];
  loading: boolean;
  error: string | null;
}

type ShellIconName =
  | "collapse"
  | "expand"
  | "project"
  | "add"
  | "settings"
  | "library"
  | "tree"
  | "trash";

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
  if (name === "add")
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="M10 4v12M4 10h12" />
      </svg>
    );
  if (name === "settings") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="m9.5 3-.5 2.5-1.5.9-2.4-.8-2.5 4.3L4 11.6v1.8l-1.9 1.7 2.5 4.3 2.4-.8 1.5.9.5 2.5h5l.5-2.5 1.5-.9 2.4.8 2.5-4.3-1.9-1.7v-1.8l1.9-1.7-2.5-4.3-2.4.8-1.5-.9L14.5 3Z" transform="translate(0 -.5)" />
        <circle cx="12" cy="12" r="3" />
      </svg>
    );
  }
  if (name === "library")
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <rect x="3" y="4" width="5" height="5" rx="1" />
        <rect x="12" y="4" width="5" height="5" rx="1" />
        <rect x="3" y="11" width="5" height="5" rx="1" />
        <rect x="12" y="11" width="5" height="5" rx="1" />
      </svg>
    );
  if (name === "tree")
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="M5 4v9.5M5 7h4M5 13h4" />
        <rect x="10" y="4.5" width="5" height="5" rx="1" />
        <rect x="10" y="11" width="5" height="5" rx="1" />
        <circle cx="5" cy="4" r="1.25" />
      </svg>
    );
  if (name === "trash")
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="M4.5 6.5h11M8 6.5V4h4v2.5M6.5 8.5l.5 7h6l.5-7M8.5 10v3.5M11.5 10v3.5" />
      </svg>
    );
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d={name === "collapse" ? "M12 5 7 10l5 5" : "m8 5 5 5-5 5"} />
    </svg>
  );
}

export interface AppShellProps {
  snapshot: ProjectSnapshot | null;
  projects: readonly ProjectListItem[];
  activeView: AppView;
  sidebarExpanded: boolean;
  expandedProjectOutlines: Readonly<Record<string, boolean>>;
  pendingAction: string | null;
  projectOutlines: Readonly<Record<string, ProjectOutlineState>>;
  currentVirtualRootId: string | null;
  collapsedNodeIds: ReadonlySet<string>;
  shortcutLabel: string;
  editing: boolean;
  componentLibraryOpen: boolean;
  agentActivityOpen: boolean;
  /** Agent sessions that are working or waiting on the user (permission or sign-in). */
  activeAgentTaskCount: number;
  /** Agent sessions blocked on the user (a permission request or sign-in). */
  waitingAgentTaskCount: number;
  /** App releases and pinned packages ready to update; Settings shows a badge. */
  pendingUpdateCount: number;
  notificationsOpen: boolean;
  /** Unread and open notifications across dashboards; the header badge counts unread ones. */
  notificationCounts: NotificationTriggerCounts;
  /** Unread open entries per dashboard config path, for sidebar marks. */
  notificationMarks: ReadonlyMap<string, NotificationMark>;
  /** The decision notice, seated below the header like the other banners. */
  decisionNotice: ReactNode;
  /** Whether the header dropper can pick a dashboard component for the agent. */
  agentPickerAvailable: boolean;
  agentPickerActive: boolean;
  editorToolbar: ReactNode;
  actionError: string | null;
  actionNotice: ActionNotice | null;
  children: ReactNode;
  onToggleSidebar(): void;
  showDashboardNumbers: boolean;
  onMoveProject(source: string, target: string, before: boolean): void;
  onSelectProject(project: ProjectListItem): void;
  onToggleProjectOutline(project: ProjectListItem): void;
  onFocusProjectNode(project: ProjectListItem, nodeId: string): void;
  onProjectNodeAction(
    project: ProjectListItem,
    node: ResolvedComponentNode,
    action: DashboardOutlineNodeAction,
  ): void;
  onOpenDeletion(project: ProjectListItem): void;
  onAddDashboard(): void;
  onShowSettings(): void;
  onOpenPalette(): void;
  onToggleLibrary(): void;
  onToggleAgentActivity(): void;
  onToggleAgentPicker(): void;
  onToggleNotifications(): void;
  onDismissError(): void;
  onDismissNotice(): void;
}

function updatesAvailable(count: number): string {
  return `${count} ${count === 1 ? "update" : "updates"} available`;
}

/** Window chrome, navigation, and header only. Dashboard state stays with its workspace. */
/** The Agent work trigger's name: its action, then the counts its badge shows. */
function agentActivityTriggerLabel(open: boolean, active: number, waiting: number): string {
  const counts = [
    ...(active > 0 ? [`${active} active`] : []),
    ...(waiting > 0 ? [`${waiting} ${waiting === 1 ? "needs" : "need"} you`] : []),
  ];
  return [open ? "Close agent work" : "Open agent work", ...counts].join(", ");
}

export function AppShell({
  snapshot,
  projects,
  activeView,
  sidebarExpanded,
  expandedProjectOutlines,
  pendingAction,
  projectOutlines,
  currentVirtualRootId,
  collapsedNodeIds,
  shortcutLabel,
  editing,
  componentLibraryOpen,
  agentActivityOpen,
  activeAgentTaskCount,
  waitingAgentTaskCount,
  pendingUpdateCount,
  notificationsOpen,
  notificationCounts,
  notificationMarks,
  decisionNotice,
  agentPickerAvailable,
  agentPickerActive,
  editorToolbar,
  actionError,
  actionNotice,
  children,
  onToggleSidebar,
  showDashboardNumbers,
  onMoveProject,
  onSelectProject,
  onToggleProjectOutline,
  onFocusProjectNode,
  onProjectNodeAction,
  onOpenDeletion,
  onAddDashboard,
  onShowSettings,
  onOpenPalette,
  onToggleLibrary,
  onToggleAgentActivity,
  onToggleAgentPicker,
  onToggleNotifications,
  onDismissError,
  onDismissNotice,
}: AppShellProps): ReactNode {
  const title = dashboardTitle(snapshot);
  const dashboardPath = snapshot?.configPath ?? snapshot?.projectRoot ?? null;
  const [draggedProject, setDraggedProject] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ path: string; before: boolean } | null>(null);
  const clearDrag = () => { setDraggedProject(null); setDropTarget(null); };
  return (
    <div className="app-window">
      <div className="window-chrome" aria-hidden="true" />
      <div
        className={`app-shell${sidebarExpanded ? " app-shell--sidebar-expanded" : ""}`}
      >
        <aside className="sidebar" aria-label="Dashboards">
          <button
            className="sidebar__toggle"
            type="button"
            aria-expanded={sidebarExpanded}
            aria-label={sidebarExpanded ? "Collapse sidebar" : "Expand sidebar"}
            title={sidebarExpanded ? "Collapse sidebar" : "Expand sidebar"}
            onClick={onToggleSidebar}
          >
            <div className="brand-mark" aria-hidden="true">
              <div className="brand-mark__dots" />
              <span />
              <span />
              <span />
            </div>
            <span className="sidebar__brand">dash-bored</span>
            <span className="sidebar__chevron">
              <ShellIcon name={sidebarExpanded ? "collapse" : "expand"} />
            </span>
          </button>
          <nav className="sidebar__projects" aria-label="Projects">
            {projects.map((project, projectIndex) => {
              const label = projectLabel(project);
              const active =
                activeView === "dashboard" &&
                project.configPath === snapshot?.configPath;
              const opening = pendingAction === `open:${project.configPath}`;
              return (
                <ProjectSidebarItem
                  key={project.configPath}
                  project={project}
                  index={projectIndex}
                  label={label}
                  active={active}
                  opening={opening}
                  sidebarExpanded={sidebarExpanded}
                  pending={pendingAction !== null}
                  outline={
                    projectOutlines[project.configPath] ?? {
                      tree: null,
                      loading: false,
                      error: null,
                    }
                  }
                  outlineExpanded={
                    expandedProjectOutlines[project.configPath] === true
                  }
                  collapsedNodeIds={
                    active
                      ? collapsedNodeIds
                      : undefined
                  }
                  currentVirtualRootId={
                    project.configPath === snapshot?.configPath
                      ? currentVirtualRootId
                      : null
                  }
                  shortcutNumber={showDashboardNumbers && projectIndex < 9 ? projectIndex + 1 : null}
                  notificationMark={notificationMarks.get(project.configPath)}
                  dragged={draggedProject === project.configPath}
                  dropBefore={dropTarget?.path === project.configPath ? dropTarget.before : null}
                  onDragStart={() => setDraggedProject(project.configPath)}
                  onDragEnd={clearDrag}
                  onDragOver={(before) => {
                    if (draggedProject && draggedProject !== project.configPath) setDropTarget({ path: project.configPath, before });
                  }}
                  onDragLeave={() => setDropTarget(null)}
                  onDrop={(before) => {
                    if (draggedProject && pendingAction === null) onMoveProject(draggedProject, project.configPath, before);
                    clearDrag();
                  }}
                  acceptsDrop={draggedProject !== null && draggedProject !== project.configPath && pendingAction === null}
                  onSelect={onSelectProject}
                  onToggleOutline={onToggleProjectOutline}
                  onFocusNode={onFocusProjectNode}
                  onNodeAction={onProjectNodeAction}
                  onOpenDeletion={onOpenDeletion}
                />
              );
            })}
          </nav>
          <div className="sidebar__footer">
            <button
              className="sidebar__item"
              type="button"
              aria-label="Add dashboard"
              title="Add dashboard"
              disabled={pendingAction !== null}
              onClick={onAddDashboard}
            >
              <span className="sidebar__item-icon">
                <ShellIcon name="add" />
              </span>
              <span className="sidebar__label">
                {pendingAction === "choose" ? "Opening…" : "Add dashboard"}
              </span>
            </button>
            <button
              className={`sidebar__item${activeView === "settings" ? " sidebar__item--active" : ""}`}
              type="button"
              aria-current={activeView === "settings" ? "page" : undefined}
              aria-label="Settings"
              aria-describedby={pendingUpdateCount ? "sidebar-update-count" : undefined}
              title={pendingUpdateCount ? `Settings — ${updatesAvailable(pendingUpdateCount)}` : "Settings"}
              onClick={onShowSettings}
            >
              <span className="sidebar__item-icon">
                <ShellIcon name="settings" />
                {pendingUpdateCount ? <span className="sidebar__update-dot" aria-hidden="true" /> : null}
              </span>
              {pendingUpdateCount ? <span id="sidebar-update-count" hidden>{updatesAvailable(pendingUpdateCount)}</span> : null}
              <span className="sidebar__label">Settings</span>
            </button>
          </div>
        </aside>
        <div className="app-frame">
          <header
            className={`app-header${editing ? " app-header--editing" : ""}`}
          >
            <div className="app-header__identity">
              <div>
                <span className="app-header__title">
                  {activeView === "settings" ? "Settings" : title}
                </span>
                {activeView === "settings" ? (
                  <span className="app-header__path">
                    Application preferences
                  </span>
                ) : dashboardPath ? (
                  <span className="app-header__path" title={dashboardPath}>
                    {dashboardPath}
                  </span>
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
                onClick={onOpenPalette}
              >
                <svg viewBox="0 0 20 20" aria-hidden="true">
                  <circle cx="8.5" cy="8.5" r="4.5" />
                  <path d="m12 12 4 4" />
                </svg>
                <span>Commands</span>
                <kbd>{shortcutLabel}</kbd>
              </button>
              <div className="agent-activity-control">
                <button
                  className={`button button--quiet agent-activity-trigger${agentActivityOpen ? " agent-activity-trigger--active" : ""}`}
                  type="button"
                  aria-label={agentActivityTriggerLabel(agentActivityOpen, activeAgentTaskCount, waitingAgentTaskCount)}
                  aria-expanded={agentActivityOpen}
                  title={waitingAgentTaskCount > 0
                    ? `${waitingAgentTaskCount} agent ${waitingAgentTaskCount === 1 ? "session needs" : "sessions need"} you`
                    : activeAgentTaskCount > 0
                      ? `${activeAgentTaskCount} agent ${activeAgentTaskCount === 1 ? "session is" : "sessions are"} working`
                      : undefined}
                  onClick={onToggleAgentActivity}
                >
                  <span>Agent work</span>
                  {activeAgentTaskCount > 0 ? (
                    <strong
                      className={waitingAgentTaskCount > 0 ? "agent-activity-trigger__count agent-activity-trigger__count--attention" : "agent-activity-trigger__count"}
                      data-waiting={waitingAgentTaskCount > 0 ? "true" : undefined}
                    >
                      {activeAgentTaskCount}
                    </strong>
                  ) : null}
                </button>
                {/* A sibling, not a child: buttons cannot nest. CSS seats it inside the trigger. */}
                <button
                  className={`agent-picker-trigger${agentPickerActive ? " agent-picker-trigger--active" : ""}`}
                  type="button"
                  {...{ [COMPONENT_PICKER_TOGGLE]: "" }}
                  aria-label="Pick a component to change with agent"
                  aria-pressed={agentPickerActive}
                  title={agentPickerActive
                    ? "Click a component to change it with the agent, Shift-click to select several, Esc to cancel"
                    : "Pick a component to change with agent"}
                  disabled={!agentPickerAvailable}
                  onClick={onToggleAgentPicker}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="m2 22 1-1h3l9-9" />
                    <path d="M3 21v-3l9-9" />
                    <path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z" />
                  </svg>
                </button>
              </div>
              <button
                className={`button button--quiet notifications-trigger${notificationsOpen ? " notifications-trigger--active" : ""}`}
                type="button"
                aria-label={notificationTriggerLabel(notificationsOpen, notificationCounts)}
                aria-expanded={notificationsOpen}
                title={notificationTriggerTitle(notificationCounts)}
                onClick={onToggleNotifications}
              >
                <NotificationBellIcon />
                {notificationCounts.interrupts > 0 ? (
                  <strong className="notifications-trigger__count notifications-trigger__count--attention" aria-hidden="true">
                    {notificationCounts.interrupts}
                  </strong>
                ) : notificationCounts.unread > 0 ? (
                  <strong className="notifications-trigger__count" aria-hidden="true">{notificationCounts.unread}</strong>
                ) : null}
              </button>
              {activeView === "dashboard" && snapshot?.projectRoot ? (
                <>
                  {editorToolbar}
                  <button
                    className="button button--quiet composition-library-trigger"
                    type="button"
                    aria-label={
                      componentLibraryOpen
                        ? "Close component library"
                        : "Open component library"
                    }
                    aria-expanded={componentLibraryOpen}
                    title={
                      componentLibraryOpen
                        ? "Close component library"
                        : "Open component library"
                    }
                    disabled={pendingAction !== null}
                    onClick={onToggleLibrary}
                  >
                    <ShellIcon name="library" />
                    <span>
                      {componentLibraryOpen ? "Close library" : "Components"}
                    </span>
                  </button>
                </>
              ) : null}
            </div>
          </header>
          {actionError ? (
            <div className="global-error" role="alert">
              <strong>Action failed</strong>
              <span>{actionError}</span>
              <button
                type="button"
                aria-label="Dismiss error"
                onClick={onDismissError}
              >
                ×
              </button>
            </div>
          ) : null}
          {actionNotice ? <GlobalNotice notice={actionNotice} onDismiss={onDismissNotice} /> : null}
          {decisionNotice}
          {/* The window's only page scroller: the header, banners, and sidebar stay put. */}
          <div className="app-frame__scroll">{children}</div>
        </div>
      </div>
    </div>
  );
}

/** A transient confirmation; the ring counts down the notice's five seconds. */
function GlobalNotice({ notice, onDismiss }: { notice: ActionNotice; onDismiss(): void }): ReactNode {
  return (
    <div className="global-notice" role="status">
      <span>{notice.message}</span>
      <button
        className="global-notice__close"
        type="button"
        aria-label="Dismiss message"
        onClick={onDismiss}
      >
        <svg className="global-notice__countdown" viewBox="0 0 28 28" aria-hidden="true">
          <circle className="global-notice__countdown-track" cx="14" cy="14" r="11" />
          <circle className="global-notice__countdown-progress" cx="14" cy="14" r="11" pathLength="1" />
        </svg>
        <span aria-hidden="true">×</span>
      </button>
    </div>
  );
}

interface ProjectSidebarItemProps {
  project: ProjectListItem;
  index: number;
  label: string;
  active: boolean;
  opening: boolean;
  sidebarExpanded: boolean;
  pending: boolean;
  outline: ProjectOutlineState;
  outlineExpanded: boolean;
  currentVirtualRootId: string | null;
  collapsedNodeIds?: ReadonlySet<string>;
  shortcutNumber: number | null;
  notificationMark?: NotificationMark;
  dragged: boolean;
  dropBefore: boolean | null;
  acceptsDrop: boolean;
  onDragStart(): void;
  onDragEnd(): void;
  onDragOver(before: boolean): void;
  onDragLeave(): void;
  onDrop(before: boolean): void;
  onSelect(project: ProjectListItem): void;
  onToggleOutline(project: ProjectListItem): void;
  onFocusNode(project: ProjectListItem, nodeId: string): void;
  onNodeAction(
    project: ProjectListItem,
    node: ResolvedComponentNode,
    action: DashboardOutlineNodeAction,
  ): void;
  onOpenDeletion(project: ProjectListItem): void;
}

function ProjectSidebarItem({
  project,
  index,
  label,
  active,
  opening,
  sidebarExpanded,
  pending,
  outline,
  outlineExpanded,
  currentVirtualRootId,
  collapsedNodeIds,
  shortcutNumber,
  notificationMark,
  dragged,
  dropBefore,
  acceptsDrop,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDragLeave,
  onDrop,
  onSelect,
  onToggleOutline,
  onFocusNode,
  onNodeAction,
  onOpenDeletion,
}: ProjectSidebarItemProps): ReactNode {
  const outlineId = `sidebar-project-tree-${index}`;
  const markId = `sidebar-project-notifications-${index}`;
  const markLevel = notificationMark?.interrupt ? "interrupt" : notificationMark?.inform ? "inform" : null;
  const markLabel = notificationMark && markLevel ? notificationMarkLabel(notificationMark) : null;
  return (
    <div className={`sidebar__project${dragged ? " sidebar__project--dragging" : ""}`}>
      <div
        className={`sidebar__project-row${dropBefore === null ? "" : dropBefore ? " sidebar__project-row--drop-before" : " sidebar__project-row--drop-after"}`}
        onDragOver={(event) => {
          if (!acceptsDrop) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          const bounds = event.currentTarget.getBoundingClientRect();
          onDragOver(event.clientY < bounds.top + bounds.height / 2);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onDragLeave();
        }}
        onDrop={(event) => {
          if (!acceptsDrop) return;
          event.preventDefault();
          const bounds = event.currentTarget.getBoundingClientRect();
          onDrop(event.clientY < bounds.top + bounds.height / 2);
        }}
      >
        <button
          className={`sidebar__item sidebar__project-link${active ? " sidebar__item--active" : ""}`}
          type="button"
          aria-current={active ? "page" : undefined}
          aria-label={label}
          aria-describedby={markLabel ? markId : undefined}
          title={`${label}${markLabel ? ` — ${markLabel}` : ""} · Drag to reorder${index < 9 ? ` · ⌘${index + 1}` : ""}`}
          aria-keyshortcuts={index < 9 ? `Meta+${index + 1}` : undefined}
          draggable={!pending}
          onDragStart={(event) => {
            event.dataTransfer.setData("application/x-dash-bored-project", project.configPath);
            event.dataTransfer.effectAllowed = "move";
            onDragStart();
          }}
          onDragEnd={onDragEnd}
          disabled={pending}
          onClick={() => onSelect(project)}
        >
          <span className="sidebar__item-icon sidebar__project-icon-wrap">
            {project.iconDataUrl ? (
              <img className="sidebar__project-icon" src={project.iconDataUrl} alt="" width={20} height={20} draggable={false} />
            ) : <ShellIcon name="project" />}
            {shortcutNumber !== null ? <span className="sidebar__shortcut-number" aria-hidden="true">{shortcutNumber}</span> : null}
            {markLevel ? (
              <span className={`sidebar__notification-mark sidebar__notification-mark--${markLevel}`} data-level={markLevel} aria-hidden="true" />
            ) : null}
          </span>
          {markLabel ? <span id={markId} hidden>{markLabel}</span> : null}
          <span className="sidebar__label">{opening ? "Opening…" : label}</span>
        </button>
        <button
          className={`sidebar__project-action sidebar__project-tree-toggle${outlineExpanded ? " sidebar__project-tree-toggle--active" : ""}`}
          type="button"
          aria-label={`${outlineExpanded ? "Collapse" : "Show"} ${label} tree`}
          aria-expanded={outlineExpanded}
          aria-controls={outlineId}
          title={
            outlineExpanded ? "Collapse dashboard tree" : "Show dashboard tree"
          }
          tabIndex={sidebarExpanded ? 0 : -1}
          disabled={pending}
          onClick={() => onToggleOutline(project)}
        >
          <ShellIcon name="tree" />
        </button>
        <button
          className="sidebar__project-action sidebar__project-remove"
          type="button"
          aria-label={`Remove ${label}`}
          title="Remove dashboard"
          tabIndex={sidebarExpanded ? 0 : -1}
          disabled={pending}
          onClick={() => onOpenDeletion(project)}
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
            active={active}
            collapsedNodeIds={collapsedNodeIds}
            currentVirtualRootId={currentVirtualRootId}
            onSelect={(nodeId) => onFocusNode(project, nodeId)}
            onAction={(node, action) => onNodeAction(project, node, action)}
          />
        </div>
      ) : null}
    </div>
  );
}

/** The window before the first host read lands, or when the host cannot be reached. */
export function BootScreen({ error }: { error?: string | null }): ReactNode {
  return (
    <main className={error ? "boot boot--error" : "boot"} aria-live={error ? undefined : "polite"}>
      <div className="brand-mark" aria-hidden="true"><span /><span /><span /></div>
      {error ? (
        <>
          <h1>dash-bored could not reach its desktop host</h1>
          <p>{error}</p>
        </>
      ) : (
        <>
          <span className="spinner" aria-hidden="true" />
          Loading dash-bored…
        </>
      )}
    </main>
  );
}
