import { useState } from "react";
import type { ProjectListItem, ProjectTarget } from "../../shared/contracts";
import type { AppView } from "../lib/action-providers";
import { host } from "../lib/rpc-client";
import type { AppDialog } from "./AppDialogs";
import { dashboardKey, rememberProject } from "./app-utils";
import type { DashboardDraft } from "./use-dashboard-draft";
import type { HostSession } from "./use-host-session";
import type { Notices } from "./use-notices";

export interface ProjectNavigationOptions {
  session: HostSession;
  draft: DashboardDraft;
  notices: Notices;
  activeView: AppView;
  setActiveView(view: AppView): void;
  toggleSidebar(): void;
  dialog: AppDialog | null;
  setDialog(dialog: AppDialog | null | ((current: AppDialog | null) => AppDialog | null)): void;
  focusComponent(nodeId: string): void;
  expandComponent(configPath: string, nodeId: string): void;
  storeVirtualRoot(configPath: string, nodeId: string): void;
  forgetDashboard(configPath: string): void;
}

/**
 * Moving between registered dashboards: opening, adding, reordering, and
 * removing them, plus sidebar outlines. Leaving a dirty draft asks first.
 */
export function useProjectNavigation({
  session,
  draft,
  notices,
  activeView,
  setActiveView,
  toggleSidebar,
  dialog,
  setDialog,
  focusComponent,
  expandComponent,
  storeVirtualRoot,
  forgetDashboard,
}: ProjectNavigationOptions) {
  const { snapshot, projects, setProjects } = session;
  const { perform } = notices;
  const editSession = draft.session;
  const [expandedOutlines, setExpandedOutlines] = useState<Record<string, boolean>>({});

  async function chooseDashboard(): Promise<void> {
    await perform("choose", async () => {
      const nextSnapshot = await host.chooseProject();
      setProjects(rememberProject(await host.listProjects(), nextSnapshot));
      if (nextSnapshot.projectRoot) setActiveView("dashboard");
    });
  }

  async function addDashboard(): Promise<void> {
    if (editSession && !draft.requireDiscard(
      "Discard the unsaved dashboard changes and add another dashboard?",
      () => void chooseDashboard(),
    )) return;
    await chooseDashboard();
  }

  async function openProject(project: ProjectListItem): Promise<void> {
    if (snapshot?.configPath === project.configPath) {
      setActiveView("dashboard");
      return;
    }
    await perform(`open:${dashboardKey(project)}`, async () => {
      await host.openProject(project);
      setActiveView("dashboard");
    });
  }

  async function selectProject(project: ProjectListItem, toggleSidebarWhenActive = false): Promise<void> {
    if (toggleSidebarWhenActive && activeView === "dashboard" && snapshot?.configPath === project.configPath) {
      toggleSidebar();
      return;
    }
    if (editSession && editSession.configPath !== project.configPath && !draft.requireDiscard(
      "Discard the unsaved dashboard changes and switch projects?",
      () => void openProject(project),
    )) return;
    await openProject(project);
  }

  function moveProject(source: string, target: string, before: boolean): void {
    void perform("reorder-projects", async () => {
      setProjects(await host.moveProject(source, target, before));
    });
  }

  function toggleOutline(project: ProjectListItem): void {
    const key = dashboardKey(project);
    const closing = expandedOutlines[key] === true;
    setExpandedOutlines((current) => ({ ...current, [key]: !closing }));
    if (closing || snapshot?.configPath === project.configPath) return;
    session.loadOutline(project);
  }

  async function openDeletion(project: ProjectListItem, skipDiscard = false): Promise<void> {
    if (
      !skipDiscard
      && editSession?.configPath === project.configPath
      && !draft.requireDiscard(
        "Discard the unsaved dashboard changes and remove this dashboard?",
        () => void openDeletion(project, true),
      )
    ) return;
    await perform(`preview-delete:${dashboardKey(project)}`, async () => {
      const preview = await host.getProjectDeletionPreview(project);
      setDialog({ kind: "deletion", project, preview, removeFiles: false });
    });
  }

  function toggleDeletionFiles(removeFiles: boolean): void {
    setDialog((current) => current?.kind === "deletion" ? { ...current, removeFiles } : current);
  }

  async function confirmDeletion(): Promise<void> {
    if (dialog?.kind !== "deletion") return;
    const request = dialog;
    const wasActive = snapshot?.configPath === request.project.configPath;
    const activeProjectIndex = projects.findIndex((project) => project.configPath === request.project.configPath);
    await perform(`delete:${dashboardKey(request.project)}`, async () => {
      setDialog(null);
      await host.deleteProject(request.project, request.removeFiles);
      const remaining = await host.listProjects();
      setProjects(remaining);
      if (editSession?.configPath === request.project.configPath) draft.end();
      forgetDashboard(request.project.configPath);
      setExpandedOutlines((current) => {
        if (!Object.hasOwn(current, request.project.configPath)) return current;
        const next = { ...current };
        delete next[request.project.configPath];
        return next;
      });
      session.forgetOutline(request.project.configPath);
      if (wasActive) {
        setActiveView("dashboard");
        const nextIndex = Math.min(Math.max(activeProjectIndex, 0), Math.max(remaining.length - 1, 0));
        const nextProject = remaining[nextIndex];
        if (nextProject) await host.openProject(nextProject);
      }
    });
  }

  async function openProjectNode(targetProject: ProjectTarget, nodeId: string): Promise<void> {
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

  async function focusProjectNode(targetProject: ProjectTarget, nodeId: string): Promise<void> {
    if (snapshot?.configPath === targetProject.configPath) {
      setActiveView("dashboard");
      focusComponent(nodeId);
      return;
    }
    if (editSession && editSession.configPath !== targetProject.configPath && !draft.requireDiscard(
      "Discard the unsaved dashboard changes and navigate to another dashboard node?",
      () => void openProjectNode(targetProject, nodeId),
    )) return;
    await openProjectNode(targetProject, nodeId);
  }

  return {
    expandedOutlines,
    addDashboard,
    selectProject,
    moveProject,
    toggleOutline,
    openDeletion,
    toggleDeletionFiles,
    confirmDeletion,
    focusProjectNode,
  };
}
