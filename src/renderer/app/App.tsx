import { ThemeNotice } from "../lib/theme";
import { useCallback, useState } from "react";
import type { ReactNode } from "react";
import { keyboardShortcutLabel } from "../../shared/keyboard-shortcut";
import { summarizeAgentDiagnostics } from "../../shared/agent-control";
import type { AppView } from "../lib/action-providers";
import { CommandPalette } from "../panels/CommandPalette";
import { AppShell, BootScreen } from "./app-shell";
import { AgentActivity, activeDashboardAgentTaskCount } from "../panels/AgentActivity";
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
import { useAppSettings, useDashboardSettings } from "./use-app-settings";
import { useAppTheme } from "./use-app-theme";
import { useDashboardDraft } from "./use-dashboard-draft";
import { useCompositionSession } from "./use-composition-session";
import { useAgentWork } from "./use-agent-work";
import { useProjectNavigation } from "./use-project-navigation";
import { useActionRegistry } from "./use-action-registry";
import { useAppActions } from "./use-app-actions";
import { useAppShortcuts, useCommandHeld } from "./use-app-keyboard";
import { useAgentControl } from "./use-agent-control";

export function App(): ReactNode {
  const notices = useNotices();
  const [activeView, setActiveView] = useState<AppView>("dashboard");
  const showDashboard = useCallback(() => setActiveView("dashboard"), []);
  const [dialog, setDialog] = useState<AppDialog | null>(null);
  const [agentActivityOpen, setAgentActivityOpen] = useState(false);
  const interaction = useCompositionInteractionController();
  const settings = useAppSettings(notices);
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
    snapshot,
    appAgentCommand: settings.settings.dashBoredAgent,
    focusedNodeId: virtualRoot?.target.id,
    dialog,
    setDialog,
    endDraft: draft.end,
    closeLibrary: interaction.closeLibrary,
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
  const navigation = useProjectNavigation({
    session,
    draft,
    notices,
    activeView,
    setActiveView,
    toggleSidebar: () => settings.setSidebarExpanded((expanded) => !expanded),
    dialog,
    setDialog,
    focusComponent: viewState.focusComponent,
    expandComponent: viewState.expandComponent,
    storeVirtualRoot: viewState.storeVirtualRoot,
    forgetDashboard: viewState.forgetDashboard,
    editNode: (node) => void composition.editNode(node),
    toggleCollapse: viewState.toggleComponentCollapse,
    openChangeWithAgent: agent.openChangeWithAgent,
  });
  const dashboardSettings = useDashboardSettings(notices, activeView === "settings", session.projects, snapshot?.revision);

  function toggleCompositionLibrary(): void {
    setAgentActivityOpen(false);
    interaction.toggleLibrary();
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
    editing: editSession !== null,
    diagnostics: summarizeAgentDiagnostics(visibleDiagnostics),
    trust: {
      trusted: snapshot?.trusted ?? false,
      pendingPermissions: snapshot && !snapshot.trusted ? snapshot.requestedPermissions : [],
    },
  }, snapshot?.tree, setActiveView);

  if (session.loading) return <BootScreen />;
  if (!snapshot && notices.error) return <BootScreen error={notices.error} />;

  const pendingAction = notices.pending;
  const compositionUiActive = interaction.libraryOpen
    || interaction.dialog !== null
    || interaction.removePath !== null
    || dialog !== null
    || actions.palette.open
    || (composition.editing && (draft.dirty || interaction.dragging !== null));
  const actionScope = `${snapshot?.projectRoot ?? "no-project"}\u0000${
    snapshot?.revision ?? 0
  }\u0000${snapshot?.trusted ? "trusted" : "restricted"}`;
  const shortcutLabel = keyboardShortcutLabel(
    settings.settings.commandPaletteShortcut,
    typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform),
  );
  const effectiveAgentCommand = agent.commandForNode(snapshot?.tree?.id);
  const visibleVirtualRoot = composition.editing ? composition.previewVirtualRoot : virtualRoot;
  const workspace = (
    <>
      {activeView === "settings" ? (
        <SettingsPanel
            draftsOpen={Boolean(editSession)}
            appSettings={settings.settings}
            dashboardSettings={dashboardSettings.items}
            actions={allActions}
            pendingAction={pendingAction}
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
            onFocus: viewState.focusComponent,
            onToggleCollapse: viewState.toggleComponentCollapse,
            onSplitRatioChange: composition.changeSplitRatio,
            onComponentHeightChange: viewState.updateComponentHeight,
            onCopyPath: (node) => void navigation.copyComponentPath(node),
            onEditComponent: (node) => void composition.editNode(node),
            onOpenAgent: agent.openChangeWithAgent,
            onUpdateProps: draft.updateComponentProps,
          }}
          onFocus={viewState.focusComponent}
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
        editing={draft.editingActiveProject}
        componentLibraryOpen={interaction.libraryOpen}
        agentActivityOpen={agentActivityOpen}
        activeAgentTaskCount={activeDashboardAgentTaskCount(session.agentTasks)}
        editorToolbar={
          editSession && draft.editingActiveProject ? (
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
        onDismissError={() => notices.setError(null)}
        onDismissNotice={notices.dismissNotice}
      >
        <ThemeNotice />
        {workspace}
      </AppShell>
      <AgentActivity
        open={agentActivityOpen}
        tasks={session.agentTasks}
        onClose={() => setAgentActivityOpen(false)}
        onDiff={host.getDashboardAgentDiff}
        onStop={agent.stopTask}
        onWrite={agent.writeTerminal}
        onResize={agent.resizeTerminal}
      />
      <CommandPalette
        open={actions.palette.open}
        actions={allActions}
        runningActionIds={actions.runningActionIds}
        favoriteActionIds={settings.favoriteActionIds}
        actionShortcuts={settings.settings.actionShortcuts}
        clearInputOnKeepOpen={settings.settings.clearPaletteInputOnKeepOpen}
        executionError={notices.error}
        favoritesDisabled={pendingAction !== null}
        initialActionId={actions.palette.initialActionId}
        onDismiss={actions.palette.dismiss}
        initialSelections={actions.palette.initialSelections}
        onExecute={actions.palette.execute}
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
        compositionDialog={interaction.dialog}
        compositionRemovePath={interaction.removePath}
        editSession={editSession}
        editingActiveProject={draft.editingActiveProject}
        dialog={dialog}
        pendingAction={pendingAction}
        agentCommand={effectiveAgentCommand}
        agentCommandForNode={(node) => agent.commandForNode(node.id)}
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
