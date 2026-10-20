import { ThemeNotice } from "../lib/theme";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { keyboardShortcutLabel } from "../../shared/keyboard-shortcut";
import { summarizeAgentDiagnostics } from "../../shared/agent-control";
import type { AppView } from "../lib/action-providers";
import { CommandPalette } from "../panels/CommandPalette";
import { AppShell, BootScreen } from "./app-shell";
import { AgentActivity } from "../panels/AgentActivity";
import { busyAgentTaskCount, waitingAgentTaskCount } from "../lib/agent-tasks";
import { DashboardEditorToolbar } from "./DashboardEditorToolbar";
import { CompositionFlyout } from "../composition/CompositionFlyout";
import { useCompositionInteractionController } from "../composition/composition-interaction-controller";
import { compositionPayloadLabel } from "../composition/composition-labels";
import { CompositionDragChip } from "../composition/CompositionDragChip";
import { DashboardAppearanceFields } from "../composition/DashboardAppearanceFields";
import { useLocalComponents } from "../render/local-components";
import { useComponentUpdateBatch } from "../render/NodeRenderer";
import { host } from "../lib/rpc-client";
import { useDashboardViewState } from "./use-dashboard-view-state";
import { mergeThemeCatalog, EMPTY_SPLIT_RATIO_OVERRIDES, resolvedConfigLinkNodeId, resolvedLocalComponentIds } from "./app-utils";
import { EmptyProject } from "../panels/EmptyProject";
import { SettingsPanel } from "../panels/SettingsPanel";
import { AppDialogs, type AppDialog } from "./AppDialogs";
import { DashboardWorkspace } from "./DashboardWorkspace";
import { useNotices } from "./use-notices";
import { useHostSession } from "./use-host-session";
import { useAppSettings, useDashboardSettings, useSettingsAgentOptions } from "./use-app-settings";
import { useAppTheme } from "./use-app-theme";
import { useDashboardDraft } from "./use-dashboard-draft";
import { useCompositionSession } from "./use-composition-session";
import { useAgentWork } from "./use-agent-work";
import { ComponentPickerHighlight, useComponentPicker } from "./component-picker";
import { findResolvedNode } from "../../shared/component-agent";
import { useProjectNavigation } from "./use-project-navigation";
import { useActionRegistry } from "./use-action-registry";
import { useAppActions } from "./use-app-actions";
import { useAppShortcuts, useCommandHeld } from "./use-app-keyboard";
import { useAgentControl } from "./use-agent-control";
import { usePaletteRecents } from "./use-palette-recents";
import { useAppUpdates } from "./use-app-updates";
import { usePackageUpdates } from "./use-package-updates";
import { pendingUpdateCount } from "../lib/update-actions";
import type { SettingsTab } from "../panels/SettingsPanel";
import { unreadInterruptCount, unreadNotificationCount, type NotificationEntry } from "../../shared/notifications";
import { nodeOnScreen, notificationMarks } from "../lib/notifications";
import { DecisionNotice, NotificationInbox } from "../panels/Notifications";
import { useNotificationLanding, useNotificationPresentation, useNotifications } from "./use-notifications";

export function App(): ReactNode {
  const notices = useNotices();
  const [activeView, setActiveView] = useState<AppView>("dashboard");
  const updates = useAppUpdates();
  const packageUpdates = usePackageUpdates();
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");
  const showUpdates = () => { setSettingsTab("updates"); setActiveView("settings"); };
  const showDashboard = useCallback(() => setActiveView("dashboard"), []);
  const [dialog, setDialog] = useState<AppDialog | null>(null);
  const [agentActivityOpen, setAgentActivityOpen] = useState(false);
  const [agentSessionTaskId, setAgentSessionTaskId] = useState<string | null>(null);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const interaction = useCompositionInteractionController();
  const settings = useAppSettings(notices);
  const notifications = useNotifications(notices.setError);
  const actions = useActionRegistry(notices.setError);
  const session = useHostSession({
    onBoot: settings.load,
    onAgentTaskActivated: () => setAgentActivityOpen(true),
    onPaletteRequested: actions.palette.show,
    onError: notices.setError,
  });
  const { snapshot } = session;
  const commandHeld = useCommandHeld();

  const dashboardPath = snapshot?.configPath ?? null;
  const viewState = useDashboardViewState(dashboardPath, snapshot?.tree);
  const paletteRecents = usePaletteRecents(dashboardPath);
  const { virtualRoot } = viewState;
  const focusedSourcePath = virtualRoot?.target.sourceConfigPath;
  const focusedSourceNodeId = resolvedConfigLinkNodeId(
    snapshot?.tree,
    virtualRoot?.target.id,
    focusedSourcePath,
  );

  const draft = useDashboardDraft({
    snapshot,
    snapshotRef: session.snapshotRef,
    notices,
    focusedSourcePath,
    focusedSourceNodeId,
    showDashboard,
    setDialog,
    onEnd: interaction.reset,
  });
  const editSession = draft.session;
  function focusComponent(nodeId: string): void {
    if (draft.session && !draft.blocksNavigation) draft.end();
    viewState.focusComponent(nodeId);
  }
  const draftLocalIds = resolvedLocalComponentIds(editSession?.validation.tree);
  const runtimeComponents = editSession
    ? [
        ...(snapshot?.components ?? []).filter((component) => !draftLocalIds.has(component.componentId)),
        ...(editSession.validation.trusted ? editSession.validation.components : []),
      ]
    : snapshot?.components ?? [];
  const localComponents = useLocalComponents(runtimeComponents, snapshot?.configPath ?? null);
  const componentUpdateBatch = useComponentUpdateBatch(snapshot?.tree, snapshot?.configPath, snapshot?.trusted, localComponents);
  useAppTheme(session.themes, snapshot, editSession, settings);

  const agent = useAgentWork({
    notices,
    activityOpen: agentActivityOpen,
    setActivityOpen: setAgentActivityOpen,
    applyAgentTask: session.applyAgentTask,
    snapshot,
    appAgentCommand: settings.settings.dashBoredAgent,
    enabledAgentIds: settings.settings.enabledAgentIds,
    focusedNodeId: virtualRoot?.target.id,
    setDialog,
    endDraft: draft.end,
    closeLibrary: () => {
      interaction.closeLibrary();
      setNotificationsOpen(false);
    },
  });
  const composition = useCompositionSession({
    interaction,
    snapshot,
    draft,
    notices,
    virtualRoot,
    focusedSourceNodeId,
    storedVirtualRoot: viewState.storedVirtualRoot ?? null,
    updateSplitRatio: viewState.updateSplitRatio,
    setDialog,
    runCreationAgent: agent.runCreationAgent,
  });
  const agentPicker = useComponentPicker(
    activeView === "dashboard" && Boolean(snapshot?.tree),
    (nodeId) => (snapshot?.tree ? findResolvedNode(snapshot.tree, nodeId) : null),
    agent.openChangeWithAgent,
  );
  const navigation = useProjectNavigation({
    session,
    draft,
    notices,
    activeView,
    setActiveView,
    toggleSidebar: () => settings.setSidebarExpanded((expanded) => !expanded),
    dialog,
    setDialog,
    focusComponent,
    expandComponent: viewState.expandComponent,
    storeVirtualRoot: viewState.storeVirtualRoot,
    forgetDashboard: (configPath) => {
      viewState.forgetDashboard(configPath);
      paletteRecents.forget(configPath);
    },
    editNode: (node) => void composition.editNode(node),
    toggleCollapse: viewState.toggleComponentCollapse,
    openChangeWithAgent: (node) => agent.openChangeWithAgent([node]),
  });
  const dashboardSettings = useDashboardSettings(notices, activeView === "settings", session.projects, snapshot?.revision);
  const settingsAgentOptions = useSettingsAgentOptions(activeView === "settings", settings.settings);

  function toggleCompositionLibrary(): void {
    setAgentActivityOpen(false);
    setNotificationsOpen(false);
    interaction.toggleLibrary();
  }

  // The right drawers are mutually exclusive; agent work also opens on its own.
  useEffect(() => {
    if (agentActivityOpen || interaction.libraryOpen) setNotificationsOpen(false);
  }, [agentActivityOpen, interaction.libraryOpen]);

  function openNotifications(): void {
    setAgentActivityOpen(false);
    interaction.closeLibrary();
    setNotificationsOpen(true);
  }

  function toggleNotifications(): void {
    // Render-state based, like the other drawer triggers.
    if (notificationsOpen) setNotificationsOpen(false);
    else openNotifications();
  }

  function openAgentSession(taskId: string): void {
    setNotificationsOpen(false);
    interaction.closeLibrary();
    setAgentActivityOpen(true);
    setAgentSessionTaskId(taskId);
  }

  async function repairInstalledTools(): Promise<void> {
    await notices.perform("installed-tools-repair", async () => {
      const { conflictsRemain } = await host.repairInstalledTools();
      notices.showNotice(conflictsRemain
        ? "Installed-tool repair needs attention; review the remaining warning."
        : "Moved the old installed tools to Trash and installed the current dash-bored tools.");
    });
  }

  const allActions = useAppActions({
    snapshot,
    projects: session.projects,
    themeCatalog: mergeThemeCatalog(session.themes, snapshot?.themeCatalog),
    activeView,
    setActiveView,
    notices,
    settings,
    draft,
    navigation,
    viewState,
    agent,
    actions,
    toggleLibrary: toggleCompositionLibrary,
    updates,
    packageUpdates,
    showUpdates,
    notifications,
    toggleNotifications,
  });
  const visibleDiagnostics = [...(snapshot?.diagnostics ?? []), ...actions.diagnostics];

  useAppShortcuts({
    settings: settings.settings,
    paletteOpen: actions.palette.open,
    projects: session.projects,
    pending: notices.pending,
    selectProject: navigation.selectProject,
    openPalette: actions.palette.showFresh,
    runAction: actions.request,
  });
  useAgentControl(actions.store, {
    view: activeView,
    configPath: snapshot?.configPath ?? null,
    dashboardName: snapshot?.dashboardName ?? null,
    focusedNodeId: virtualRoot?.target.id ?? null,
    editing: draft.blocksNavigation,
    diagnostics: summarizeAgentDiagnostics(visibleDiagnostics),
    trust: {
      trusted: snapshot?.trusted ?? false,
      pendingPermissions: snapshot && !snapshot.trusted ? snapshot.requestedPermissions : [],
    },
  }, snapshot?.tree, setActiveView);

  // What the user is looking at decides whether a new decision interrupts.
  const dashboardCovered = dialog !== null || interaction.dialog !== null || actions.palette.open;
  const notificationTargetVisible = (entry: NotificationEntry): boolean => {
    const target = entry.target;
    if (target.kind === "updates") return activeView === "settings" && settingsTab === "updates";
    if (target.kind === "agent-session") {
      if (!agentActivityOpen) return false;
      return agentSessionTaskId === null
        ? session.agentTasks.some((task) => task.id === target.taskId)
        : agentSessionTaskId === target.taskId;
    }
    if (activeView !== "dashboard" || dashboardCovered || entry.configPath !== snapshot?.configPath) return false;
    return target.kind === "dashboard" || nodeOnScreen(target.nodeId, target.itemId);
  };
  const presentation = useNotificationPresentation(notifications.state, notificationTargetVisible, notifications.markRead);
  const landing = useNotificationLanding({
    snapshot,
    projects: session.projects,
    store: actions.store,
    request: actions.request,
    setActiveView,
    openDashboard: (project) => navigation.selectProject(project),
    showUpdates,
    openAgentSession,
    markRead: notifications.markRead,
    setError: notices.setError,
    showNotice: notices.showNotice,
  });
  const marks = useMemo(() => notificationMarks(notifications.state), [notifications.state]);
  const interruptCount = unreadInterruptCount(notifications.state);
  const notificationCounts = {
    interrupts: interruptCount,
    unread: unreadNotificationCount(notifications.state),
    open: notifications.state.entries.length,
  };
  const decisionHandlers = {
    onShow: (entry: NotificationEntry) => {
      setNotificationsOpen(false);
      landing.show(entry);
    },
    onAction: (entry: NotificationEntry) => {
      setNotificationsOpen(false);
      landing.runAction(entry);
    },
    onDismiss: (entry: NotificationEntry) => notifications.dismiss([entry.id]),
  };

  if (session.loading) return <BootScreen />;
  if (!snapshot && notices.error) return <BootScreen error={notices.error} />;

  const pendingAction = notices.pending;
  const compositionUiActive = interaction.libraryOpen
    || interaction.dialog !== null
    || interaction.removePath !== null
    || dialog !== null
    || actions.palette.open
    // Native webviews sit above the DOM; hiding them lets the dropper reach their frames.
    || agentPicker.active
    || (composition.editing && (draft.dirty || interaction.dragging !== null));
  const actionScope = `${snapshot?.projectRoot ?? "no-project"}\u0000${
    snapshot?.revision ?? 0
  }\u0000${snapshot?.trusted ? "trusted" : "restricted"}`;
  const shortcutLabel = keyboardShortcutLabel(
    settings.settings.commandPaletteShortcut,
    typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform),
  );
  const visibleVirtualRoot = composition.editing ? composition.previewVirtualRoot : virtualRoot;
  const workspace = (
    <>
      {activeView === "settings" ? (
        <SettingsPanel
            draftsOpen={draft.blocksNavigation}
            updates={updates}
            packageUpdates={packageUpdates}
            activeTab={settingsTab}
            onSelectTab={setSettingsTab}
            appSettings={settings.settings}
            dashboardSettings={dashboardSettings.items}
            projects={session.projects}
            actions={allActions}
            pendingAction={pendingAction}
            agentOptions={settingsAgentOptions}
            onSaveAgent={settings.saveAgent}
            onUpdateSettings={settings.update}
            onUpdateDashboardAppearance={dashboardSettings.updateAppearance}
          />
      ) : !snapshot?.projectRoot ? (
        <EmptyProject
          pending={pendingAction === "choose"}
          onChoose={() => void navigation.addDashboard()}
        />
      ) : (
        <DashboardWorkspace
          snapshot={snapshot}
          virtualRoot={visibleVirtualRoot}
          tree={composition.editing ? composition.previewTree : snapshot.tree}
          draftPreviewUnavailable={Boolean(editSession && !editSession.validation.tree)}
          diagnostics={[
            ...visibleDiagnostics,
            ...(editSession?.validation.diagnostics ?? []),
          ]}
          pendingAction={pendingAction}
          componentsVisible={!compositionUiActive}
          composition={composition.contextValue}
          render={{
            trusted: editSession ? editSession.validation.trusted : snapshot.trusted,
            processesRef: session.processesRef,
            environmentByNode: snapshot.environmentByNode,
            localComponents,
            actionStore: actions.store,
            actionScope,
            actionController: actions.controller,
            updateBatch: componentUpdateBatch,
            collapsedNodeIds: viewState.activeCollapsedComponentIds,
            splitRatioOverrides: composition.editing ? EMPTY_SPLIT_RATIO_OVERRIDES : viewState.activeSplitRatioOverrides,
            componentHeightOverrides: viewState.activeComponentHeightOverrides,
            childSelections: viewState.activeChildSelections,
            onFocus: focusComponent,
            onToggleCollapse: viewState.toggleComponentCollapse,
            onSplitRatioChange: composition.changeSplitRatio,
            onComponentHeightChange: viewState.updateComponentHeight,
            onCopyPath: (node) => void navigation.copyComponentPath(node),
            onEditComponent: (node) => void composition.editNode(node),
            onOpenAgent: (node) => agent.openChangeWithAgent([node]),
            onUpdateProps: draft.updateComponentProps,
          }}
          onFocus={focusComponent}
          onTrust={() => void notices.perform("trust", () => host.setTrust(true))}
          onReload={() => void notices.perform("reload", host.reloadProject)}
          onRestorePackages={() => void notices.perform("package-restore", () => host.manageExternalComponent({ op: "restore" }))}
          onSyncPackages={() => void notices.perform("package-sync", () => host.manageExternalComponent({ op: "sync" }))}
          onFixWithAgent={() => void agent.runDiagnosticsAgent()}
          onRepairInstalledTools={() => void repairInstalledTools()}
        />
      )}
    </>
  );
  return (
    <>
      <AppShell
        snapshot={snapshot}
        projects={session.projects}
        activeView={activeView}
        sidebarExpanded={settings.sidebarExpanded}
        expandedProjectOutlines={navigation.expandedOutlines}
        pendingAction={pendingAction}
        projectOutlines={session.outlines}
        currentVirtualRootId={virtualRoot?.target.id ?? null}
        collapsedNodeIds={viewState.activeCollapsedComponentIds}
        shortcutLabel={shortcutLabel}
        editing={draft.blocksNavigation}
        componentLibraryOpen={interaction.libraryOpen}
        agentActivityOpen={agentActivityOpen}
        activeAgentTaskCount={busyAgentTaskCount(session.agentTasks)}
        waitingAgentTaskCount={waitingAgentTaskCount(session.agentTasks)}
        pendingUpdateCount={pendingUpdateCount(updates.state, packageUpdates.state)}
        notificationsOpen={notificationsOpen}
        notificationCounts={notificationCounts}
        notificationMarks={marks}
        decisionNotice={
          <DecisionNotice
            entry={presentation.notice}
            noticeKey={presentation.noticeKey}
            activeConfigPath={activeView === "dashboard" ? snapshot?.configPath ?? null : null}
            moreCount={interruptCount - (presentation.notice?.level === "interrupt" ? 1 : 0)}
            onHide={presentation.hide}
            onOpenInbox={() => {
              presentation.hide();
              openNotifications();
            }}
            {...decisionHandlers}
          />
        }
        agentPickerAvailable={agentPicker.enabled}
        agentPickerActive={agentPicker.active}
        editorToolbar={
          editSession && draft.editingActiveProject && draft.blocksNavigation ? (
            <div className="app-header__editor-toolbar">
              <DashboardEditorToolbar
                diagnostics={editSession.validation.diagnostics}
                saving={draft.saving}
                dirty={draft.dirty}
                resolving={draft.resolving}
                onSave={() => void draft.save()}
                onCancel={draft.cancel}
              />
            </div>
          ) : null
        }
        actionError={notices.error}
        actionNotice={notices.notice}
        onToggleSidebar={() => settings.setSidebarExpanded((expanded) => !expanded)}
        showDashboardNumbers={commandHeld && !actions.palette.open}
        onMoveProject={navigation.moveProject}
        onSelectProject={(project) => void navigation.selectProject(project, true)}
        onToggleProjectOutline={navigation.toggleOutline}
        onFocusProjectNode={(project, nodeId) => void navigation.focusProjectNode(project, nodeId)}
        onProjectNodeAction={navigation.outlineNodeAction}
        onOpenDeletion={(project) => void navigation.openDeletion(project)}
        onAddDashboard={() => void navigation.addDashboard()}
        onShowSettings={() => setActiveView("settings")}
        onOpenPalette={actions.palette.show}
        onToggleLibrary={toggleCompositionLibrary}
        onToggleAgentActivity={agent.toggleActivity}
        onToggleAgentPicker={agentPicker.toggle}
        onToggleNotifications={toggleNotifications}
        onDismissError={() => notices.setError(null)}
        onDismissNotice={notices.dismissNotice}
      >
        <ThemeNotice />
        {workspace}
      </AppShell>
      <ComponentPickerHighlight hover={agentPicker.hover} selection={agentPicker.selection} />
      <AgentActivity
        open={agentActivityOpen}
        tasks={session.agentTasks}
        selectedTaskId={agentSessionTaskId}
        onSelectTask={setAgentSessionTaskId}
        onClose={() => setAgentActivityOpen(false)}
        onCommand={agent.taskCommand}
      />
      <NotificationInbox
        open={notificationsOpen}
        state={notifications.state}
        onClose={() => setNotificationsOpen(false)}
        onDismissAll={notifications.dismissAll}
        onClearHistory={notifications.clearHistory}
        {...decisionHandlers}
      />
      <CommandPalette
        open={actions.palette.open}
        initialQuery={actions.palette.initialQuery}
        resetSequence={actions.palette.resetSequence}
        actions={allActions}
        runningActionIds={actions.runningActionIds}
        favoriteActionIds={settings.favoriteActionIds}
        recentRuns={paletteRecents.recents}
        actionShortcuts={settings.settings.actionShortcuts}
        clearInputOnKeepOpen={settings.settings.clearPaletteInputOnKeepOpen}
        executionError={notices.error}
        favoritesDisabled={pendingAction !== null}
        initialActionId={actions.palette.initialActionId}
        onDismiss={actions.palette.dismiss}
        initialSelections={actions.palette.initialSelections}
        onExecute={(id, selections) => {
          if (actions.palette.execute(id, selections)) paletteRecents.record(id, selections);
        }}
        onToggleFavorite={settings.toggleFavoriteAction}
      />
      <CompositionFlyout
        dashboardAppearance={snapshot?.configPath ? (
          <DashboardAppearanceFields
            config={editSession?.configPath === snapshot.configPath ? editSession.draft : snapshot.config}
            onChange={draft.updateAppearance}
          />
        ) : undefined}
        open={interaction.libraryOpen}
        dragging={interaction.dragging}
        catalog={composition.catalog}
        onClose={interaction.closeLibrary}
        onInsert={composition.insert}
        onInsertSwitchablePanels={() => void composition.insertSwitchablePanels()}
        onExternalOperation={async (operation) => (await host.manageExternalComponent(operation)).message}
        onBuildWithAgent={(description) => void composition.buildWithAgent(description)}
        onPointerDragMove={composition.libraryPointerDragMove}
        onPointerDrop={composition.libraryPointerDrop}
        onDragStateChange={composition.changeLibraryDrag}
        agentPending={pendingAction === "component-agent:create"}
        loading={composition.sourcePending}
      />
      {interaction.dragging && composition.config ? (
        <CompositionDragChip
          ref={composition.dragChip}
          dragging={interaction.dragging}
          label={compositionPayloadLabel(interaction.dragging, composition.config, composition.catalog)}
        />
      ) : null}
      <AppDialogs
      onConfigureAgents={() => { setDialog(null); setActiveView("settings"); }}
        compositionDialog={interaction.dialog}
        compositionRemovePath={interaction.removePath}
        editSession={editSession}
        editingActiveProject={draft.editingActiveProject}
        dialog={dialog}
        pendingAction={pendingAction}
        agentCommand={agent.effectiveAgentCommand}
        agentCreatePending={pendingAction === "component-agent:create"}
        onApplyCompositionDraft={composition.applyDraft}
        onDismissCompositionDialog={interaction.dismissDialog}
        onDismissRemoval={interaction.dismissRemoval}
        onConfirmRemoval={composition.confirmRemoval}
        onBuildWithAgent={composition.requestCreationAgent}
        onRunComponentAgent={agent.runComponentAgent}
        onPreviewComponentAgent={agent.previewComponentAgent}
        onDismissDialog={() => setDialog(null)}
        onConfirmDiscard={draft.confirmDiscard}
        onSaveDiscard={draft.saveThenContinue}
        onToggleDeletionFiles={navigation.toggleDeletionFiles}
        onConfirmDeletion={() => void navigation.confirmDeletion()}
      />
    </>
  );
}
