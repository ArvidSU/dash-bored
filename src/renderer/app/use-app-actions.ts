import type { ProjectListItem, ProjectSnapshot } from "../../shared/contracts";
import type { ThemeCatalogItem } from "../../shared/themes";
import {
  buildApplicationActions,
  buildDeclaredComponentActions,
  buildNodeFocusActions,
  type AppView,
} from "../lib/action-providers";
import { highlightRevealedItem, scrollNodeIntoView } from "../lib/reveal-item";
import { host } from "../lib/rpc-client";
import { buildRevealActions, buildSelectionActions } from "../lib/selection-actions";
import type { useActionRegistry } from "./use-action-registry";
import { useProvidedActions } from "./use-action-registry";
import type { useAgentWork } from "./use-agent-work";
import type { useAppSettings } from "./use-app-settings";
import type { useDashboardDraft } from "./use-dashboard-draft";
import type { useDashboardViewState } from "./use-dashboard-view-state";
import type { Notices } from "./use-notices";
import type { useProjectNavigation } from "./use-project-navigation";

export interface AppActionSources {
  snapshot: ProjectSnapshot | null;
  projects: ProjectListItem[];
  themeCatalog: ThemeCatalogItem[];
  activeView: AppView;
  setActiveView(view: AppView): void;
  notices: Notices;
  settings: ReturnType<typeof useAppSettings>;
  draft: ReturnType<typeof useDashboardDraft>;
  navigation: ReturnType<typeof useProjectNavigation>;
  viewState: ReturnType<typeof useDashboardViewState>;
  agent: ReturnType<typeof useAgentWork>;
  actions: ReturnType<typeof useActionRegistry>;
  toggleLibrary(): void;
}

/** Every action source the palette, shortcuts, and agents see, registered into the store. */
export function useAppActions({
  snapshot,
  projects,
  themeCatalog,
  activeView,
  setActiveView,
  notices,
  settings,
  draft,
  navigation,
  viewState,
  agent,
  actions,
  toggleLibrary,
}: AppActionSources) {
  const showDashboard = () => setActiveView("dashboard");
  const applicationActions = buildApplicationActions({
    snapshot,
    projects,
    activeView,
    sidebarExpanded: settings.sidebarExpanded,
    pendingAction: notices.pending,
    editing: draft.editingActiveProject,
    draftDirty: draft.dirty,
    draftValid: draft.valid,
    savingDraft: draft.saving,
    appSettings: settings.settings,
    themeCatalog,
    callbacks: {
      reloadApp: () => window.location.reload(),
      showDashboard,
      showSettings: () => setActiveView("settings"),
      toggleSidebar: () => settings.setSidebarExpanded((expanded) => !expanded),
      addDashboard: navigation.addDashboard,
      openProject: navigation.selectProject,
      editDashboard: toggleLibrary,
      saveDashboard: async () => { await draft.save(); },
      cancelDashboard: draft.cancel,
      reloadProject: () => notices.perform("reload", host.reloadProject),
      trustProject: () => notices.perform("trust", () => host.setTrust(true)),
      revokeTrust: () => notices.perform("revoke", () => host.setTrust(false)),
      runProcessQuickAction: async (nodeId) => {
        await host.processCommand(nodeId, { type: "quick-action" });
      },
      stopProcess: async (nodeId) => {
        await host.processCommand(nodeId, { type: "stop" });
      },
      setDashboardAppearance: (theme, themeMode) => draft.updateAppearance({ theme, themeMode }),
      setDefaultAppearance: (theme, themeMode) => settings.update(
        { ...settings.settings, theme, themeMode },
        "Default theme and appearance updated.",
      ),
      // Every agent launch goes through the reviewed composer and the agent-work
      // surface, so the app can show what the agent is doing.
      requestAgentPrompt: agent.requestPrompt,
    },
  });
  const nodeFocusActions = buildNodeFocusActions(
    snapshot,
    viewState.virtualRoot?.target.id ?? null,
    draft.editingActiveProject,
    (nodeId) => {
      showDashboard();
      viewState.focusComponent(nodeId);
    },
  );
  const selectionActions = buildSelectionActions(snapshot, viewState.activeChildSelections, viewState.selectChild);
  // Reveal is presentation, not navigation: it never changes the focused target.
  const revealActions = buildRevealActions(snapshot, (nodeId, itemId) => {
    showDashboard();
    viewState.revealComponent(nodeId);
    if (itemId !== undefined) return highlightRevealedItem(nodeId, itemId);
    requestAnimationFrame(() => requestAnimationFrame(() => scrollNodeIntoView(nodeId)));
  });
  const declaredComponentActions = buildDeclaredComponentActions(snapshot, actions.componentActions);
  return useProvidedActions(actions.store, [
    { id: "application", actions: applicationActions },
    { id: "node-focus", actions: nodeFocusActions },
    { id: "selection", actions: selectionActions },
    { id: "reveal", actions: revealActions },
    { id: "declared-component", actions: declaredComponentActions },
  ], actions.componentActions);
}
