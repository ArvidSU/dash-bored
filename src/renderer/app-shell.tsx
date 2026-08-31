import type { ReactNode } from "react";
import type { ProjectListItem, ProjectSnapshot } from "../shared/contracts";
import { projectLabel, type AppView } from "./action-providers";
import { DashboardOutlineTree } from "./DashboardOutlineTree";

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
        <path d="M12.22 2h-.44a2 2 0 0 0-1.99 1.67l-.06.36a2 2 0 0 1-2.99 1.4l-.31-.18a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.31.18a2 2 0 0 1 0 3.46l-.31.18a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.31-.18a2 2 0 0 1 2.99 1.4l.06.36A2 2 0 0 0 10 20h.44a2 2 0 0 0 1.99-1.67l.06-.36a2 2 0 0 1 2.99-1.4l.31.18a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.31-.18a2 2 0 0 1 0-3.46l.31-.18a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.31.18a2 2 0 0 1-2.99-1.4l-.06-.36A2 2 0 0 0 12.22 2Z" />
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
  title: string;
  dashboardPath: string | null;
  shortcutLabel: string;
  editing: boolean;
  componentLibraryOpen: boolean;
  editorToolbar: ReactNode;
  actionError: string | null;
  actionNotice: ReactNode;
  children: ReactNode;
  onToggleSidebar(): void;
  onSelectProject(project: ProjectListItem): void;
  onToggleProjectOutline(project: ProjectListItem): void;
  onFocusProjectNode(project: ProjectListItem, nodeId: string): void;
  onOpenDeletion(project: ProjectListItem): void;
  onAddDashboard(): void;
  onShowSettings(): void;
  onOpenPalette(): void;
  onToggleLibrary(): void;
  onDismissError(): void;
}

/** Window chrome, navigation, and header only. Dashboard state stays with its workspace. */
export function AppShell({
  snapshot,
  projects,
  activeView,
  sidebarExpanded,
  expandedProjectOutlines,
  pendingAction,
  projectOutlines,
  title,
  dashboardPath,
  shortcutLabel,
  editing,
  componentLibraryOpen,
  editorToolbar,
  actionError,
  actionNotice,
  children,
  onToggleSidebar,
  onSelectProject,
  onToggleProjectOutline,
  onFocusProjectNode,
  onOpenDeletion,
  onAddDashboard,
  onShowSettings,
  onOpenPalette,
  onToggleLibrary,
  onDismissError,
}: AppShellProps): ReactNode {
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
                  onSelect={onSelectProject}
                  onToggleOutline={onToggleProjectOutline}
                  onFocusNode={onFocusProjectNode}
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
              aria-label="Settings"
              title="Settings"
              onClick={onShowSettings}
            >
              <span className="sidebar__item-icon">
                <ShellIcon name="settings" />
              </span>
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
          {actionNotice}
          {children}
        </div>
      </div>
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
  onSelect(project: ProjectListItem): void;
  onToggleOutline(project: ProjectListItem): void;
  onFocusNode(project: ProjectListItem, nodeId: string): void;
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
  onSelect,
  onToggleOutline,
  onFocusNode,
  onOpenDeletion,
}: ProjectSidebarItemProps): ReactNode {
  const outlineId = `sidebar-project-tree-${index}`;
  return (
    <div className="sidebar__project">
      <div className="sidebar__project-row">
        <button
          className={`sidebar__item sidebar__project-link${active ? " sidebar__item--active" : ""}`}
          type="button"
          aria-current={active ? "page" : undefined}
          aria-label={label}
          title={label}
          disabled={pending}
          onClick={() => onSelect(project)}
        >
          {project.iconDataUrl ? (
            <img
              className="sidebar__item-icon sidebar__project-icon"
              src={project.iconDataUrl}
              alt=""
              width={20}
              height={20}
            />
          ) : (
            <span className="sidebar__item-icon">
              <ShellIcon name="project" />
            </span>
          )}
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
            onSelect={(nodeId) => onFocusNode(project, nodeId)}
          />
        </div>
      ) : null}
    </div>
  );
}
