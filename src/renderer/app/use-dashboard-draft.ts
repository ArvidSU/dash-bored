import { useCallback, useEffect, useRef, useState } from "react";
import type { DashboardConfig, ProjectSnapshot, ResolvedComponentNode } from "../../shared/contracts";
import { updateNodeProps } from "../composition/dashboard-editor";
import { host } from "../lib/rpc-client";
import type { AppDialog } from "./AppDialogs";
import {
  createDashboardEditSession,
  errorMessage,
  patchDashboardAppearance,
  resolvedConfigLinkNodeId,
  resolvedNodeById,
  sameDashboardTopology,
  type DashboardEditSession,
} from "./app-utils";
import { useLatestRef } from "./use-latest-ref";
import type { Notices } from "./use-notices";

export interface DashboardDraftOptions {
  snapshot: ProjectSnapshot | null;
  snapshotRef: { readonly current: ProjectSnapshot | null };
  notices: Notices;
  /** The focused linked bundle, which a new draft edits instead of the root. */
  focusedSourcePath: string | undefined;
  /** The concrete config-link occurrence for that focused bundle. */
  focusedSourceNodeId: string | undefined;
  showDashboard(): void;
  setDialog(dialog: AppDialog | null): void;
  /** Called whenever the draft closes, so composition UI closes with it. */
  onEnd(): void;
}

function isDirty(session: DashboardEditSession | null): boolean {
  return Boolean(session && JSON.stringify(session.original) !== JSON.stringify(session.draft));
}

/**
 * The single dashboard draft: one owning config, edited in memory until Save
 * or Cancel. Every structural or prop change goes through this session, and
 * leaving it with unsaved changes asks first.
 */
export function useDashboardDraft({
  snapshot,
  snapshotRef,
  notices,
  focusedSourcePath,
  focusedSourceNodeId,
  showDashboard,
  setDialog,
  onEnd,
}: DashboardDraftOptions) {
  const [editSession, setEditSession] = useState<DashboardEditSession | null>(null);
  const [saving, setSaving] = useState(false);
  const sessionGeneration = useRef(0);
  // Stable prop updates (builtins hold the callback) read the newest session,
  // including one written by the previous call before it rendered.
  const sessionRef = useLatestRef(editSession);
  const savingRef = useLatestRef(saving);
  const focusedSourceRef = useLatestRef({ path: focusedSourcePath, nodeId: focusedSourceNodeId });

  useEffect(() => {
    if (!editSession) return;
    const generation = sessionGeneration.current;
    const source = JSON.stringify(editSession.draft);
    let cancelled = false;
    const timer = setTimeout(() => {
      void host.validateDashboardDraft(editSession.draft, editSession.configPath, editSession.sourceNodeId)
        .then((validation) => {
          if (cancelled || generation !== sessionGeneration.current) return;
          setEditSession((current) =>
            current
            && current.configPath === editSession.configPath
            && current.sourceNodeId === editSession.sourceNodeId
            && JSON.stringify(current.draft) === source
              ? { ...current, validation, validatedDraft: source, validatedConfig: structuredClone(current.draft) }
              : current,
          );
        })
        .catch((error: unknown) => {
          if (!cancelled) notices.setError(errorMessage(error));
        });
    }, 140);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [editSession?.configPath, editSession?.sourceNodeId, editSession?.draft]);

  function end(): void {
    sessionGeneration.current += 1;
    setEditSession(null);
    onEnd();
  }

  /** Replaces the draft of the open session (only of `configPath`, when given). */
  function setDraft(draft: DashboardConfig, configPath?: string): void {
    if (savingRef.current) return;
    const current = sessionRef.current;
    if (!current || (configPath !== undefined && current.configPath !== configPath)) return;
    const updated = { ...current, draft };
    sessionRef.current = updated;
    setEditSession((existing) => existing && existing.configPath === updated.configPath ? updated : existing);
  }

  /** Continues at once when nothing would be lost; otherwise asks first. */
  function requireDiscard(message: string, continueAction: () => void): boolean {
    if (savingRef.current) {
      notices.setError("Wait for the dashboard save to finish before leaving edit mode.");
      return false;
    }
    if (!isDirty(editSession)) {
      end();
      return true;
    }
    setDialog({ kind: "discard", message, continueAction });
    return false;
  }

  /** Opens a draft of the active (or requested) config, reusing a matching one. */
  async function ensureCurrent(requestedConfigPath?: string, preserveView = false): Promise<DashboardEditSession | null> {
    if (!snapshot?.projectRoot || !snapshot.configPath) return null;
    if (editSession?.projectRoot === snapshot.projectRoot && (!requestedConfigPath || requestedConfigPath === editSession.configPath)) {
      return editSession;
    }
    if (editSession) {
      notices.setError("Finish the current dashboard draft before composing another dashboard.");
      return null;
    }
    let loaded: DashboardEditSession | null = null;
    const generation = ++sessionGeneration.current;
    const expected = snapshot;
    await notices.perform(`edit:${snapshot.configPath}`, async () => {
      const configPath = requestedConfigPath ?? focusedSourcePath;
      const sourceNodeId = configPath && configPath !== snapshot.configPath ? focusedSourceNodeId : undefined;
      const source = await host.getDashboardConfigSource(configPath);
      const validation = await host.validateDashboardDraft(source.config, source.configPath, sourceNodeId);
      if (
        generation !== sessionGeneration.current
        || snapshotRef.current?.projectRoot !== expected.projectRoot
        || snapshotRef.current?.configPath !== expected.configPath
        || snapshotRef.current?.revision !== expected.revision
        || (!requestedConfigPath && (
          focusedSourceRef.current.path !== focusedSourcePath
          || focusedSourceRef.current.nodeId !== focusedSourceNodeId
        ))
      ) return;
      loaded = createDashboardEditSession(snapshot.projectRoot!, source, validation, sourceNodeId);
      sessionRef.current = loaded;
      if (!preserveView) showDashboard();
      setEditSession(loaded);
    });
    return loaded;
  }

  function updateAppearance(change: Pick<DashboardConfig, "theme" | "themeMode">): void {
    if (savingRef.current) return;
    void (async () => {
      const configPath = snapshotRef.current?.configPath;
      if (!configPath) return;
      const session = await ensureCurrent(configPath, true);
      const current = sessionRef.current;
      if (!session || !current || current.configPath !== session.configPath || savingRef.current || snapshotRef.current?.configPath !== session.configPath) return;
      const updated = { ...current, draft: patchDashboardAppearance(current.draft, change) };
      sessionRef.current = updated;
      setEditSession((current) => current?.configPath === session.configPath ? updated : current);
    })();
  }

  const updateComponentProps = useCallback(async (
    node: ResolvedComponentNode,
    props: Record<string, unknown>,
  ): Promise<void> => {
    const currentSnapshot = snapshotRef.current;
    const expectedFocus = {
      path: focusedSourceRef.current.path,
      nodeId: focusedSourceRef.current.nodeId,
    };
    const currentSession = sessionRef.current;
    const configPath = node.sourceConfigPath;
    const currentTree = currentSession ? currentSession.validation.tree : currentSnapshot?.tree;
    const currentNode = currentTree ? resolvedNodeById(currentTree, node.id) : null;
    const path = currentNode && currentNode.sourceConfigPath === configPath
      && currentNode.component === node.component
      ? currentNode.sourceNodePath
      : null;
    if (!currentSnapshot?.projectRoot || !configPath || !path) {
      throw new Error("This component cannot locate its owning dashboard configuration.");
    }
    if (currentSession && currentSession.configPath !== configPath) {
      throw new Error("Finish the current dashboard draft before editing another dashboard component.");
    }
    if (currentSession && savingRef.current) {
      throw new Error("Wait for the dashboard save to finish before editing component props.");
    }
    const unresolved = currentSession
      && JSON.stringify(currentSession.draft) !== currentSession.validatedDraft;
    if (currentSession && unresolved && (
      !currentSession.validation.tree
      || !sameDashboardTopology(currentSession.validatedConfig, currentSession.draft)
    )) {
      throw new Error("Wait for the dashboard draft check to finish before editing component props.");
    }
    if (currentSession && !currentSession.validation.tree) {
      throw new Error("The invalid dashboard draft has no matching component preview.");
    }
    let session = currentSession;
    if (!session) {
      const generation = ++sessionGeneration.current;
      const expected = currentSnapshot;
      const sourceNodeId = configPath === currentSnapshot.configPath
        ? undefined
        : resolvedConfigLinkNodeId(currentSnapshot.tree, node.id, configPath);
      const source = await host.getDashboardConfigSource(configPath);
      const validation = await host.validateDashboardDraft(source.config, source.configPath, sourceNodeId);
      if (
        generation !== sessionGeneration.current
        || snapshotRef.current?.projectRoot !== expected.projectRoot
        || snapshotRef.current?.configPath !== expected.configPath
        || snapshotRef.current?.revision !== expected.revision
        || sessionRef.current !== null
        || focusedSourceRef.current.path !== expectedFocus.path
        || focusedSourceRef.current.nodeId !== expectedFocus.nodeId
      ) return;
      session = createDashboardEditSession(currentSnapshot.projectRoot, source, validation, sourceNodeId);
      sessionRef.current = session;
      showDashboard();
      setEditSession(session);
    }
    const updated = { ...session, draft: updateNodeProps(session.draft, path, props) };
    sessionRef.current = updated;
    setEditSession((current) => current && current.configPath === updated.configPath ? updated : current);
  }, [showDashboard]);

  async function save(): Promise<boolean> {
    const current = sessionRef.current;
    if (!current || JSON.stringify(current.draft) !== current.validatedDraft || savingRef.current) return false;
    savingRef.current = true;
    setSaving(true);
    notices.setError(null);
    try {
      await host.saveDashboardConfig(current.draft, current.expectedConfigRevision, current.configPath);
      end();
      return true;
    } catch (error) {
      notices.setError(errorMessage(error));
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  function cancel(): void {
    if (!editSession) return;
    requireDiscard("Discard the unsaved dashboard changes and exit edit mode?", () => undefined);
  }

  function confirmDiscard(continueAction: () => void): void {
    if (savingRef.current) {
      notices.setError("Wait for the dashboard save to finish before discarding changes.");
      return;
    }
    setDialog(null);
    end();
    queueMicrotask(continueAction);
  }

  function saveThenContinue(continueAction: () => void): void {
    if (savingRef.current) return;
    void save().then((saved) => {
      if (!saved) return;
      setDialog(null);
      continueAction();
    });
  }

  const editingActiveProject = Boolean(editSession && editSession.projectRoot === snapshot?.projectRoot);
  const resolving = Boolean(editSession && JSON.stringify(editSession.draft) !== editSession.validatedDraft);
  return {
    session: editSession,
    saving,
    dirty: isDirty(editSession),
    valid: Boolean(editSession && !resolving && editSession.validation.diagnostics.every((item) => item.severity !== "error")),
    resolving,
    editingActiveProject,
    end,
    setDraft,
    requireDiscard,
    ensureCurrent,
    updateAppearance,
    updateComponentProps,
    save,
    cancel,
    confirmDiscard,
    saveThenContinue,
  };
}

export type DashboardDraft = ReturnType<typeof useDashboardDraft>;
export { isDirty as isDraftDirty };
