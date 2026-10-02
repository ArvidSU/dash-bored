import { ThemeNotice, ThemeSelect } from "../lib/theme";
import { useCallback, useLayoutEffect, useState } from "react";
import type { ReactNode } from "react";
import type { DashboardConfig, ProjectListItem, ResolvedComponentNode } from "../../shared/contracts";
import { componentPath } from "../../shared/component-agent";
import { keyboardShortcutLabel } from "../../shared/keyboard-shortcut";
import { summarizeAgentDiagnostics } from "../../shared/agent-control";
import {
  buildApplicationActions,
  buildDeclaredComponentActions,
  buildNodeFocusActions,
  type AppView,
} from "../lib/action-providers";
import { buildRevealActions, buildSelectionActions } from "../lib/selection-actions";
import { highlightRevealedItem, revealScrollBehavior } from "../lib/reveal-item";
import { writeClipboardText } from "../lib/clipboard";
import { CommandPalette } from "../panels/CommandPalette";
import { AppShell } from "./app-shell";
import type { DashboardOutlineNodeAction } from "../composition/DashboardOutlineTree";
import { AgentActivity, activeDashboardAgentTaskCount } from "../panels/AgentActivity";
import { DashboardEditor, DashboardEditorToolbar } from "../composition/DashboardEditor";
import { CompositionFlyout } from "../composition/CompositionFlyout";
import { useCompositionInteractionController } from "../composition/composition-interaction-controller";
import { compositionPayloadLabel } from "../composition/composition-labels";
import { CompositionDragChip } from "../composition/CompositionDragChip";
import { useLocalComponents } from "../render/local-components";
import { useComponentUpdateBatch } from "../render/NodeRenderer";
import { host } from "../lib/rpc-client";
import { resolveVirtualRoot } from "../lib/virtual-root";
import { useDashboardViewState } from "./use-dashboard-view-state";
import { mergeThemeCatalog, EMPTY_SPLIT_RATIO_OVERRIDES } from "./app-utils";
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
import { useActionRegistry, useProvidedActions } from "./use-action-registry";
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

  const localComponents = useLocalComponents(snapshot?.components ?? [], snapshot?.configPath ?? null);
  const componentUpdateBatch = useComponentUpdateBatch(snapshot?.tree, snapshot?.configPath, snapshot?.trusted, localComponents);

  const dashboardPath = snapshot?.configPath ?? null;
  const viewState = useDashboardViewState(dashboardPath, snapshot?.tree);
  const virtualRoot = snapshot?.tree ? resolveVirtualRoot(snapshot.tree, viewState.storedVirtualRoot ?? null) : null;
  useLayoutEffect(() => {
    const targetId = virtualRoot?.target.id;
    if (!targetId) return;
    const target = [...document.querySelectorAll<HTMLElement>("[data-node-id]")]
      .find((element) => element.dataset.nodeId === targetId);
    target?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }, [snapshot?.configPath, virtualRoot?.target.id]);

  const draft = useDashboardDraft({
    snapshot,
    snapshotRef: session.snapshotRef,
    notices,
    focusedSourcePath: virtualRoot?.target.sourceConfigPath,
    showDashboard,
    setDialog,
    onEnd: interaction.reset,
  });
  const editSession = draft.session;
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
  });
  const dashboardSettings = useDashboardSettings(notices, activeView === "settings", session.projects, snapshot?.revision);

  function toggleCompositionLibrary(): void {
    setAgentActivityOpen(false);
    interaction.toggleLibrary();
  }

  async function copyComponentPath(node: ResolvedComponentNode): Promise<void> {
    await notices.perform(`copy-component:${node.id}`, async () => {
      const locator = componentPath(node);
      await writeClipboardText(locator);
      notices.showNotice(`Copied ${locator}`);
    });
  }

  async function repairInstalledTools(): Promise<void> {
    await notices.perform("installed-tools-repair", async () => {
      const repaired = await host.repairInstalledTools();
      const hasConflicts = repaired.diagnostics.some((item) => item.code === "INSTALLED_TOOL_UPDATE_CONFLICT");
      notices.showNotice(hasConflicts
        ? "Installed-tool repair needs attention; review the remaining warning."
        : "Moved the old installed tools to Trash and installed the current dash-bored tools.");
    });
  }

  function handleProjectNodeAction(
    targetProject: ProjectListItem,
    node: ResolvedComponentNode,
    action: DashboardOutlineNodeAction,
  ): void {
    if (action === "focus") {
      void navigation.focusProjectNode(targetProject, node.id);
      return;
    }
    if (action === "copy") {
      void copyComponentPath(node);
      return;
    }
    if (activeView !== "dashboard" || snapshot?.configPath !== targetProject.configPath) {
      notices.setError("Open this dashboard before changing its component.");
      return;
    }
    if (action === "edit") void composition.editNode(node);
    else if (action === "collapse") viewState.toggleComponentCollapse(node.id);
    else agent.openChangeWithAgent(node);
  }

  const themeCatalog = mergeThemeCatalog(session.themes, snapshot?.themeCatalog);
  const applicationActions = buildApplicationActions({
    snapshot,
    projects: session.projects,
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
      editDashboard: toggleCompositionLibrary,
      saveDashboard: async () => { await draft.save(); },
      cancelDashboard: draft.cancel,
      reloadProject: () => notices.perform("reload", host.reloadProject),
      trustProject: () => notices.perform("trust", host.trustProject),
      revokeTrust: () => notices.perform("revoke", host.revokeTrust),
      runProcessQuickAction: async (nodeId) => {
        await host.runProcessQuickAction(nodeId);
      },
      stopProcess: async (nodeId) => {
        await host.stopProcess(nodeId);
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
    virtualRoot?.target.id ?? null,
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
    requestAnimationFrame(() => requestAnimationFrame(() => {
      [...document.querySelectorAll<HTMLElement>("[data-node-id]")]
        .find((element) => element.dataset.nodeId === nodeId)
        ?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: revealScrollBehavior() });
    }));
  });
  const declaredComponentActions = buildDeclaredComponentActions(snapshot, actions.componentActions);
  const allActions = useProvidedActions(actions.store, [
    { id: "application", actions: applicationActions },
    { id: "node-focus", actions: nodeFocusActions },
    { id: "selection", actions: selectionActions },
    { id: "reveal", actions: revealActions },
    { id: "declared-component", actions: declaredComponentActions },
  ], actions.componentActions);
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

  if (session.loading) {
    return (
      <main className="boot" aria-live="polite">
        <div className="brand-mark" aria-hidden="true"><span /><span /><span /></div>
        <span className="spinner" aria-hidden="true" />
        Loading dash-bored…
      </main>
    );
  }

  if (!snapshot && notices.error) {
    return (
      <main className="boot boot--error">
        <div className="brand-mark" aria-hidden="true"><span /><span /><span /></div>
        <h1>dash-bored could not reach its desktop host</h1>
        <p>{notices.error}</p>
      </main>
    );
  }

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
          draftEditor={editSession && editSession.projectRoot === snapshot.projectRoot && !composition.previewTree ? (
            <DashboardEditor
              config={editSession.draft}
              catalog={editSession.componentCatalog}
              diagnostics={editSession.validation.diagnostics}
              projectRoot={editSession.projectRoot}
              configPath={editSession.configPath}
              agentCommand={effectiveAgentCommand}
              agentPending={pendingAction === "component-agent:create"}
              onBuildWithAgent={composition.requestCreationAgent}
              onChange={(next) => draft.setDraft(next)}
            />
          ) : null}
          diagnostics={visibleDiagnostics}
          pendingAction={pendingAction}
          componentsVisible={!compositionUiActive}
          composition={composition.contextValue}
          render={{
            trusted: snapshot.trusted,
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
            onCopyPath: (node) => void copyComponentPath(node),
            onEditComponent: (node) => void composition.editNode(node),
            onOpenAgent: agent.openChangeWithAgent,
            onUpdateProps: draft.updateComponentProps,
          }}
          onFocus={viewState.focusComponent}
          onTrust={() => void notices.perform("trust", host.trustProject)}
          onReload={() => void notices.perform("reload", host.reloadProject)}
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
        onProjectNodeAction={handleProjectNodeAction}
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
        onExternalOperation={async (operation) => (await host.manageExternalComponent(operation)).result.message}
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

/** The library's window-appearance fields; changes land in the dashboard draft. */
function DashboardAppearanceFields({
  config,
  onChange,
}: {
  config: DashboardConfig | null | undefined;
  onChange(change: Pick<DashboardConfig, "theme" | "themeMode">): void;
}): ReactNode {
  return (
    <details className="dashboard-appearance">
      <summary>Dashboard appearance</summary>
      <label className="props-field"><span>Window theme</span><ThemeSelect inherit
        value={config?.theme}
        onChange={(theme) => onChange({ theme })} /></label>
      <label className="props-field"><span>Window appearance</span><select aria-label="Dashboard appearance" value={config?.themeMode ?? ""} onChange={(event) => onChange({ themeMode: (event.target.value || undefined) as DashboardConfig["themeMode"] })}>
        <option value="">Use app default</option><option value="dark">Dark</option><option value="light">Light</option><option value="system">System</option>
      </select></label>
      <p>Applies to the whole window. Save dashboard to keep the selection.</p>
    </details>
  );
}
