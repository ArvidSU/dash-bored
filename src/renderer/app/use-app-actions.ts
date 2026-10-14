import type { ProjectListItem, ProjectSnapshot } from "../../shared/contracts";
import { buildPackageUpdateActions, buildUpdateActions } from "../lib/update-actions";
import type { AppUpdatesController } from "./use-app-updates";
import type { PackageUpdatesController } from "./use-package-updates";
import type { ThemeCatalogItem } from "../../shared/themes";
import {
  buildApplicationActions,
  buildDeclaredComponentActions,
  buildNodeFocusActions,
  type AppView,
} from "../lib/action-providers";
import { buildAttentionActions, loadAttentionAnimation, requestAttention } from "../lib/attention";
import { highlightRevealedItem, scrollNodeIntoView } from "../lib/reveal-item";
import { host } from "../lib/rpc-client";
import { buildRevealActions, buildSelectionActions } from "../lib/selection-actions";
import { dashboardNodeEntries } from "../lib/virtual-root";
import type { useActionRegistry } from "./use-action-registry";
import { useProvidedActions } from "./use-action-registry";
import type { useAgentWork } from "./use-agent-work";
import type { useAppSettings } from "./use-app-settings";
import type { useDashboardDraft } from "./use-dashboard-draft";
import type { useDashboardViewState } from "./use-dashboard-view-state";
import type { Notices } from "./use-notices";
import type { useProjectNavigation } from "./use-project-navigation";

export interface AppActionSources {
  updates: AppUpdatesController;
  packageUpdates: PackageUpdatesController;
  showUpdates(): void;
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
  updates,
  packageUpdates,
  showUpdates,
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
    editing: draft.blocksNavigation,
    draftDirty: draft.dirty,
    draftValid: draft.valid,
    savingDraft: draft.saving,
    appSettings: settings.settings,
    themeCatalog,
    promptTemplates: agent.promptTemplates,
    promptTemplatesReason: agent.promptTemplatesReason,
    callbacks: {
      openCommandPalette: (query) => actions.palette.showFresh(query),
      reloadApp: () => window.location.reload(),
      focusWindow: () => host.focusWindow(),
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
    draft.blocksNavigation,
    (nodeId) => {
      if (draft.session) draft.end();
      showDashboard();
      if (nodeId === null) viewState.clearFocus();
      else viewState.focusComponent(nodeId);
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
  // Attention reveals like reveal:, then animates and says why in the notice.
  const attentionActions = buildAttentionActions(snapshot, async (nodeId, request, callerNodeId) => {
    if (!snapshot) throw new Error("Open a dashboard first.");
    const manifest = await loadAttentionAnimation(snapshot, request.animation, callerNodeId, (reference, configPath) => host.readAnimation(reference, configPath));
    const label = snapshot.tree ? dashboardNodeEntries(snapshot.tree).find((entry) => entry.node.id === nodeId)?.label ?? nodeId : nodeId;
    showDashboard();
    viewState.revealComponent(nodeId);
    await requestAttention(nodeId, manifest, {
      ...(request.item === undefined ? {} : { item: request.item }),
      onPlay: () => notices.showNotice(request.message ? `${label}: ${request.message}` : `${label} needs your attention.`),
    });
  });
  const declaredComponentActions = buildDeclaredComponentActions(snapshot, actions.componentActions);
  return useProvidedActions(actions.store, [
    { id: "application", actions: applicationActions },
    { id: "updates", actions: [
      ...buildUpdateActions(updates, draft.blocksNavigation, showUpdates),
      ...buildPackageUpdateActions(packageUpdates, showUpdates),
    ] },
    { id: "node-focus", actions: nodeFocusActions },
    { id: "selection", actions: selectionActions },
    { id: "reveal", actions: revealActions },
    { id: "attention", actions: attentionActions },
    { id: "declared-component", actions: declaredComponentActions },
  ], actions.componentActions);
}
