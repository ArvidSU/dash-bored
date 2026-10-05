import { useEffect, useMemo, useRef } from "react";
import type { ComponentCatalogItem, DashboardConfig, ProjectSnapshot, ResolvedComponentNode } from "../../shared/contracts";
import { planCompositionOperation } from "../composition/composition-operation";
import type { ComponentPointerDragPoint } from "../composition/CompositionFlyout";
import type { CompositionDragPayload, CompositionTarget } from "../composition/composition-context";
import { createCompositionTargets } from "../composition/composition-targets";
import { siblingMoveTarget } from "../composition/composition-movement";
import type { useCompositionInteractionController } from "../composition/composition-interaction-controller";
import { isRootCompositionTarget } from "../composition/composition-labels";
import { positionCompositionDragChip } from "../composition/CompositionDragChip";
import {
  insertNode,
  nodeAtPath,
  removeNode,
  switchablePanelsNode,
  updateTiledSplitRatio,
  type InsertionTarget,
  type NodePath,
} from "../composition/dashboard-editor";
import type { LayoutBranch } from "../lib/component-children";
import { host } from "../lib/rpc-client";
import { resolveVirtualRoot } from "../lib/virtual-root";
import type { AppDialog } from "./AppDialogs";
import {
  errorMessage,
  isCompositionSourceCurrent,
  replaceResolvedConfigLinkTree,
} from "./app-utils";
import { isDraftDirty, type DashboardDraft } from "./use-dashboard-draft";
import type { Notices } from "./use-notices";

type VirtualRoot = ReturnType<typeof resolveVirtualRoot>;

export interface CompositionSessionOptions {
  interaction: ReturnType<typeof useCompositionInteractionController>;
  snapshot: ProjectSnapshot | null;
  draft: DashboardDraft;
  notices: Notices;
  virtualRoot: VirtualRoot | null;
  focusedSourceNodeId: string | undefined;
  storedVirtualRoot: string | null;
  updateSplitRatio(branchKey: string, defaultRatio: number, ratio: number | null): void;
  setDialog(dialog: AppDialog | null): void;
  runCreationAgent(configPath: string, target: InsertionTarget, prompt: string): Promise<void>;
}

/**
 * Composition over the dashboard tree: the preview of the draft (or of a
 * focused linked bundle before a draft exists), its drop targets, pointer
 * drags, and the library operations. Every mutation lands in the draft.
 */
export function useCompositionSession({
  interaction,
  snapshot,
  draft,
  notices,
  virtualRoot,
  focusedSourceNodeId,
  storedVirtualRoot,
  updateSplitRatio,
  setDialog,
  runCreationAgent,
}: CompositionSessionOptions) {
  const editSession = draft.session;
  const { setError } = notices;
  const sourceRequestId = useRef(0);
  const pointerFrame = useRef<number | null>(null);
  const dragChip = useRef<HTMLDivElement | null>(null);
  const pendingPointer = useRef<{ payload: CompositionDragPayload; point: ComponentPointerDragPoint } | null>(null);
  const focusedSourcePath = virtualRoot?.target.sourceConfigPath;
  const activeSource = isCompositionSourceCurrent(interaction.source, snapshot, focusedSourcePath, focusedSourceNodeId)
    ? interaction.source
    : null;

  useEffect(() => () => {
    if (pointerFrame.current !== null) cancelAnimationFrame(pointerFrame.current);
  }, []);

  async function loadSource(): Promise<void> {
    const requestId = ++sourceRequestId.current;
    if (!snapshot?.projectRoot || !snapshot.configPath) return;
    if (!focusedSourcePath || focusedSourcePath === snapshot.configPath) {
      interaction.setSource(null);
      return;
    }
    const request = {
      projectRoot: snapshot.projectRoot,
      activeDashboardPath: snapshot.configPath,
      focusedSourcePath,
      snapshotRevision: snapshot.revision,
      configPath: focusedSourcePath,
      sourceNodeId: focusedSourceNodeId,
    };
    interaction.setSource(null);
    try {
      const source = await host.getDashboardConfigSource(focusedSourcePath);
      // A newer focus change superseded this request; drop its late response.
      if (requestId !== sourceRequestId.current) return;
      if (source.configPath !== request.configPath) return;
      const validation = await host.validateDashboardDraft(source.config, source.configPath, request.sourceNodeId);
      if (requestId !== sourceRequestId.current) return;
      interaction.setSource({ ...request, config: source.config, componentCatalog: source.componentCatalog, validation });
    } catch (error) {
      if (requestId !== sourceRequestId.current) return;
      setError(errorMessage(error));
    }
  }

  useEffect(() => {
    if (!interaction.libraryOpen || editSession || !snapshot?.projectRoot || !snapshot.configPath) {
      sourceRequestId.current += 1;
      return;
    }
    if (!focusedSourcePath || focusedSourcePath === snapshot.configPath) {
      sourceRequestId.current += 1;
      if (interaction.source !== null) interaction.setSource(null);
      return;
    }
    if (
    isCompositionSourceCurrent(interaction.source, snapshot, focusedSourcePath, focusedSourceNodeId)
      && interaction.source.configPath === focusedSourcePath
    ) return;
    void loadSource();
    return () => {
      sourceRequestId.current += 1;
    };
  }, [
    interaction.libraryOpen,
    Boolean(editSession),
    snapshot?.configPath,
    snapshot?.projectRoot,
    snapshot?.revision,
    focusedSourcePath,
    focusedSourceNodeId,
  ]);

  const previewTree = useMemo(() => {
    if (!snapshot?.tree) return null;
    if (!editSession) {
      if (!activeSource || activeSource.configPath === snapshot.configPath) return snapshot.tree;
      return activeSource.validation.tree && activeSource.sourceNodeId
        ? replaceResolvedConfigLinkTree(snapshot.tree, activeSource.sourceNodeId, activeSource.validation.tree)
        : null;
    }
    const resolvedDraft = editSession.validation.tree;
    if (!resolvedDraft) return null;
    if (editSession.configPath === snapshot.configPath) return resolvedDraft;
    return editSession.sourceNodeId
      ? replaceResolvedConfigLinkTree(snapshot.tree, editSession.sourceNodeId, resolvedDraft)
      : null;
  }, [activeSource, editSession, snapshot?.configPath, snapshot?.tree]);

  const previewVirtualRoot = previewTree ? resolveVirtualRoot(previewTree, storedVirtualRoot) : null;
  const config = editSession ? editSession.draft : activeSource?.config ?? snapshot?.config ?? null;
  const catalog = editSession
    ? editSession.componentCatalog
    : activeSource?.componentCatalog ?? snapshot?.componentCatalog ?? [];
  const sourcePending = Boolean(
    interaction.libraryOpen
    && !editSession
    && focusedSourcePath
    && snapshot?.configPath
    && focusedSourcePath !== snapshot.configPath
    && !activeSource,
  );
  const editing = Boolean(editSession && draft.editingActiveProject && previewTree);

  function sourceIsReady(): boolean {
    if (draft.saving) {
      setError("Wait for the dashboard save to finish before composing.");
      return false;
    }
    if (editSession && draft.resolving) {
      setError("Wait for the dashboard draft check to finish before composing.");
      return false;
    }
    if (!sourcePending) return true;
    setError("Loading the focused dashboard bundle before composing.");
    return false;
  }

  const targets = useMemo(() => createCompositionTargets({
    config,
    catalog,
    previewTree,
    owningConfigPath: editSession?.configPath ?? activeSource?.configPath ?? snapshot?.configPath,
    dragging: interaction.dragging,
  }), [
    config,
    catalog,
    previewTree,
    editSession?.configPath,
    activeSource?.configPath,
    snapshot?.configPath,
    interaction.dragging,
  ]);

  function removalTargetAt(point: ComponentPointerDragPoint): boolean {
    return document.elementFromPoint(point.clientX, point.clientY)
      ?.closest("[data-composition-removal-target]") != null;
  }

  function updatePointerDrag(payload: CompositionDragPayload, point: ComponentPointerDragPoint): void {
    const target = targets.pointerTargetAt(point, payload, interaction.currentPointer());
    positionCompositionDragChip(
      dragChip.current,
      point,
      target ? "target" : payload.type === "node" && removalTargetAt(point) ? "remove" : "none",
    );
    interaction.updatePointer(target ? {
      nodeId: target.node.id,
      zoneId: target.zone.id,
      clientX: point.clientX,
      clientY: point.clientY,
    } : null);
  }

  function schedulePointerDrag(payload: CompositionDragPayload, point: ComponentPointerDragPoint): void {
    pendingPointer.current = { payload, point };
    if (pointerFrame.current !== null) return;
    pointerFrame.current = requestAnimationFrame(() => {
      pointerFrame.current = null;
      const pending = pendingPointer.current;
      pendingPointer.current = null;
      if (pending) updatePointerDrag(pending.payload, pending.point);
    });
  }

  function clearPendingPointer(): void {
    pendingPointer.current = null;
    if (pointerFrame.current !== null) {
      cancelAnimationFrame(pointerFrame.current);
      pointerFrame.current = null;
    }
  }

  function dropPointer(payload: CompositionDragPayload, point: ComponentPointerDragPoint): void {
    // Resolve against the advertised zone so the drop lands where the
    // indicator (with hysteresis) said it would, not a raw re-hit-test.
    const target = targets.pointerTargetAt(point, payload, interaction.currentPointer());
    clearPendingPointer();
    interaction.updatePointer(null);
    if (target) {
      drop(target.zone.target, payload);
      return;
    }
    if (payload.type === "node" && removalTargetAt(point)) void requestRemoval(payload.path);
  }

  async function openDialog(target: CompositionTarget, reference?: string): Promise<void> {
    if (!sourceIsReady()) return;
    if (!config || !snapshot?.tree) return;
    const payload: CompositionDragPayload = { type: "component", reference: reference ?? "" };
    if (!reference || !targets.targetIsValid(target, payload)) {
      setError("Choose a valid component and insertion target before composing.");
      return;
    }
    const session = await draft.ensureCurrent();
    if (!session) return;
    interaction.showDialog(isRootCompositionTarget(target)
      ? { mode: "replace", reference }
      : { mode: "add", target, reference });
  }

  function insert(entry: ComponentCatalogItem): void {
    if (!sourceIsReady()) return;
    const target = interaction.selectedTarget ?? targets.defaultTarget();
    if (!target) {
      setError("No dashboard insertion target is available.");
      return;
    }
    void openDialog(target, entry.reference);
  }

  async function insertSwitchablePanels(): Promise<void> {
    if (!sourceIsReady()) return;
    const target = interaction.selectedTarget ?? targets.defaultTarget();
    if (!target || isRootCompositionTarget(target)) {
      setError("Choose a non-root insertion target for switchable panels.");
      return;
    }
    const session = await draft.ensureCurrent();
    if (!session) return;
    const planned = planCompositionOperation({
      config: session.draft,
      catalog: session.componentCatalog,
      payload: { type: "component", reference: "./components/external/core/group" },
      target,
    });
    if (planned.status !== "planned") {
      setError(planned.reason);
      return;
    }
    try {
      draft.setDraft(insertNode(session.draft, target, switchablePanelsNode(session.draft), session.componentCatalog), session.configPath);
      interaction.closeLibrary();
      interaction.clearTarget();
    } catch (error) {
      setError(errorMessage(error));
    }
  }

  /** Building a component with the agent replaces the draft, so a dirty one asks first. */
  function requestCreationAgent(target: InsertionTarget, description: string): void {
    if (!editSession || draft.resolving || notices.pending !== null) return;
    const configPath = editSession.configPath;
    const launch = (): void => void runCreationAgent(configPath, target, description);
    if (draft.dirty) {
      setDialog({
        kind: "discard",
        message: "Discard the dashboard draft and ask the configured agent to build this component?",
        continueAction: launch,
      });
      return;
    }
    launch();
  }

  async function buildWithAgent(description: string): Promise<void> {
    if (!sourceIsReady()) return;
    let target = interaction.selectedTarget ?? targets.defaultTarget();
    if (!target || isRootCompositionTarget(target)) {
      const fallback = targets.defaultTarget();
      target = fallback && !isRootCompositionTarget(fallback) ? fallback : null;
    }
    if (!target || isRootCompositionTarget(target) || !snapshot?.projectRoot) {
      setError("Choose a component insertion target before asking the agent to build one.");
      return;
    }
    const session = await draft.ensureCurrent();
    if (!session) return;
    const chosen = target;
    if (isDraftDirty(session)) {
      setDialog({
        kind: "discard",
        message: "Discard the dashboard draft and ask the configured agent to build this component?",
        continueAction: () => void runCreationAgent(session.configPath, chosen, description),
      });
      return;
    }
    void runCreationAgent(session.configPath, chosen, description);
  }

  async function requestRemoval(path: NodePath): Promise<void> {
    const session = await draft.ensureCurrent();
    if (!session || path.length === 0) return;
    try {
      nodeAtPath(session.draft.root, path);
    } catch {
      setError("The component moved before removal could be confirmed.");
      return;
    }
    interaction.requestRemoval(path);
  }

  function drop(target: CompositionTarget, payload: CompositionDragPayload): void {
    if (!sourceIsReady()) return;
    if (!targets.targetIsValid(target, payload)) return;
    if (payload.type === "component") {
      void openDialog(target, payload.reference);
      return;
    }
    void draft.ensureCurrent().then((session) => {
      if (!session || isRootCompositionTarget(target)) return;
      const planned = planCompositionOperation({ config: session.draft, catalog: session.componentCatalog, payload, target });
      if (planned.status !== "planned") {
        setError(planned.message);
        return;
      }
      draft.setDraft(planned.nextConfig, session.configPath);
      interaction.endDrag();
      interaction.clearTarget();
    });
  }

  function changeSplitRatio(
    branchKey: string,
    defaultRatio: number,
    ratio: number | null,
    node: ResolvedComponentNode,
    splitPath: readonly LayoutBranch[],
  ): void {
    if (!sourceIsReady()) return;
    const applyTo = (sessionDraft: DashboardConfig, configPath: string, nextRatio: number | null): void => {
      const path = node.sourceNodePath;
      if (!path) {
        setError("The tiled component moved before its split could be updated.");
        return;
      }
      try {
        draft.setDraft(nextRatio === null ? sessionDraft : updateTiledSplitRatio(sessionDraft, path, splitPath, nextRatio), configPath);
      } catch (error) {
        setError(errorMessage(error));
      }
    };
    if (editing && editSession) {
      applyTo(editSession.draft, editSession.configPath, ratio);
      return;
    }
    if (interaction.libraryOpen) {
      void draft.ensureCurrent().then((session) => {
        if (session) applyTo(session.draft, session.configPath, ratio ?? defaultRatio);
      });
      return;
    }
    updateSplitRatio(branchKey, defaultRatio, ratio);
  }

  async function editNode(node: ResolvedComponentNode): Promise<void> {
    if (!sourceIsReady()) return;
    const path = node.sourceNodePath;
    if (!path) {
      setError("The component could not be located in its dashboard configuration.");
      return;
    }
    const session = await draft.ensureCurrent();
    if (!session) return;
    if (node.sourceConfigPath !== session.configPath) {
      setError("Finish editing the component's owning dashboard before opening its settings.");
      return;
    }
    try {
      nodeAtPath(session.draft.root, path);
    } catch {
      setError("The component moved before editing could be opened.");
      return;
    }
    interaction.showDialog({ mode: "configure", path });
  }

  function applyDraft(next: DashboardConfig): void {
    if (!sourceIsReady()) return;
    draft.setDraft(next);
    interaction.dismissDialog();
    interaction.clearTarget();
  }

  async function moveSibling(path: NodePath, direction: "previous" | "next"): Promise<void> {
    if (!sourceIsReady()) return;
    const session = editSession ?? await draft.ensureCurrent();
    if (!session) return;
    const target = siblingMoveTarget(session.draft.root, path, direction);
    if (!target) {
      setError("This component has no movable sibling in that direction.");
      return;
    }
    const planned = planCompositionOperation({
      config: session.draft,
      catalog: session.componentCatalog,
      payload: { type: "node", path },
      target,
    });
    if (planned.status !== "planned") {
      setError(planned.reason);
      return;
    }
    draft.setDraft(planned.nextConfig, session.configPath);
  }

  function confirmRemoval(): void {
    if (!interaction.removePath || !editSession || !sourceIsReady()) return;
    try {
      draft.setDraft(removeNode(editSession.draft, interaction.removePath, editSession.componentCatalog), editSession.configPath);
      interaction.dismissRemoval();
      interaction.clearTarget();
    } catch (error) {
      setError(errorMessage(error));
    }
  }

  function changeLibraryDrag(entry: { reference: string } | null): void {
    if (entry) {
      interaction.beginLibraryDrag(entry.reference);
    } else {
      clearPendingPointer();
      interaction.endDrag();
    }
  }

  // Composition is always ready for direct frame-handle drags. A drag itself opens
  // the flyout and begins a draft only after a valid move or removal.
  const contextValue = config && previewTree && !draft.resolving && !draft.saving
    ? {
        active: true,
        dragging: interaction.dragging,
        pointer: interaction.pointer,
        config,
        catalog,
        pathForNode: targets.pathForNode,
        dropZonesForNode: targets.dropZonesForNode,
        onNodeDragStart: interaction.beginNodeDrag,
        onNodeDragEnd: () => {
          clearPendingPointer();
          interaction.endDrag();
        },
        onNodePointerDragMove: (path: NodePath, point: ComponentPointerDragPoint) => {
          schedulePointerDrag({ type: "node", path }, point);
        },
        onNodePointerDrop: (path: NodePath, point: ComponentPointerDragPoint) => {
          dropPointer({ type: "node", path }, point);
        },
        onMoveSibling: (path: NodePath, direction: "previous" | "next") => {
          void moveSibling(path, direction);
        },
      }
    : null;

  return {
    previewTree,
    previewVirtualRoot,
    config,
    catalog,
    sourcePending,
    editing,
    contextValue,
    dragChip,
    insert,
    insertSwitchablePanels,
    buildWithAgent,
    requestCreationAgent,
    libraryPointerDragMove: (reference: string, point: ComponentPointerDragPoint) =>
      schedulePointerDrag({ type: "component", reference }, point),
    libraryPointerDrop: (reference: string, point: ComponentPointerDragPoint) =>
      dropPointer({ type: "component", reference }, point),
    changeLibraryDrag,
    changeSplitRatio,
    editNode,
    applyDraft,
    confirmRemoval,
  };
}
