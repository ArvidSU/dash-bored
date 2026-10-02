import { useCallback, useEffect, useState } from "react";
import type { DashboardConfig, ProjectSnapshot, ResolvedComponentNode } from "../../shared/contracts";
import { nodePathFromSourcePath, updateNodeProps } from "../composition/dashboard-editor";
import { host } from "../lib/rpc-client";
import type { AppDialog } from "./AppDialogs";
import {
  createDashboardEditSession,
  errorMessage,
  patchDashboardAppearance,
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
  showDashboard,
  setDialog,
  onEnd,
}: DashboardDraftOptions) {
  const [editSession, setEditSession] = useState<DashboardEditSession | null>(null);
  const [saving, setSaving] = useState(false);
  // Stable prop updates (builtins hold the callback) read the newest session,
  // including one written by the previous call before it rendered.
  const sessionRef = useLatestRef(editSession);

  useEffect(() => {
    if (!editSession) return;
    const source = JSON.stringify(editSession.draft);
    let cancelled = false;
    const timer = setTimeout(() => {
      void host.validateDashboardDraft(editSession.draft, editSession.configPath)
        .then((validation) => {
          if (cancelled) return;
          setEditSession((current) =>
            current && JSON.stringify(current.draft) === source
              ? { ...current, validation }
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
  }, [editSession?.draft]);

  function end(): void {
    setEditSession(null);
    onEnd();
  }

  /** Replaces the draft of the open session (only of `configPath`, when given). */
  function setDraft(draft: DashboardConfig, configPath?: string): void {
    setEditSession((current) => current && (configPath === undefined || current.configPath === configPath)
      ? { ...current, draft }
      : current);
  }

  /** Continues at once when nothing would be lost; otherwise asks first. */
  function requireDiscard(message: string, continueAction: () => void): boolean {
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
    await notices.perform(`edit:${snapshot.configPath}`, async () => {
      const source = await host.getDashboardConfigSource(requestedConfigPath ?? focusedSourcePath);
      const validation = await host.validateDashboardDraft(source.config, source.configPath);
      loaded = createDashboardEditSession(snapshot.projectRoot!, source, validation);
      if (!preserveView) showDashboard();
      setEditSession(loaded);
    });
    return loaded;
  }

  function updateAppearance(change: Pick<DashboardConfig, "theme" | "themeMode">): void {
    void (async () => {
      const configPath = snapshotRef.current?.configPath;
      if (!configPath) return;
      const session = await ensureCurrent(configPath, true);
      if (!session || snapshotRef.current?.configPath !== session.configPath) return;
      const updated = { ...session, draft: patchDashboardAppearance(session.draft, change) };
      sessionRef.current = updated;
      setEditSession((current) => current?.configPath === session.configPath ? updated : current);
    })();
  }

  const updateComponentProps = useCallback(async (
    node: ResolvedComponentNode,
    props: Record<string, unknown>,
  ): Promise<void> => {
    const currentSnapshot = snapshotRef.current;
    const currentSession = sessionRef.current;
    const configPath = node.sourceConfigPath;
    const path = node.sourcePath ? nodePathFromSourcePath(node.sourcePath) : null;
    if (!currentSnapshot?.projectRoot || !configPath || !path) {
      throw new Error("This component cannot locate its owning dashboard configuration.");
    }
    if (currentSession && currentSession.configPath !== configPath) {
      throw new Error("Finish the current dashboard draft before editing another dashboard component.");
    }
    let session = currentSession;
    if (!session) {
      const source = await host.getDashboardConfigSource(configPath);
      const validation = await host.validateDashboardDraft(source.config, source.configPath);
      session = createDashboardEditSession(currentSnapshot.projectRoot, source, validation);
      sessionRef.current = session;
      showDashboard();
      setEditSession(session);
    }
    const updated = { ...session, draft: updateNodeProps(session.draft, path, props) };
    sessionRef.current = updated;
    setEditSession((current) => current && current.configPath === updated.configPath ? updated : current);
  }, [showDashboard]);

  async function save(): Promise<boolean> {
    if (!editSession) return false;
    setSaving(true);
    notices.setError(null);
    try {
      await host.saveDashboardConfig(editSession.draft, editSession.expectedConfigRevision, editSession.configPath);
      end();
      return true;
    } catch (error) {
      notices.setError(errorMessage(error));
      return false;
    } finally {
      setSaving(false);
    }
  }

  function cancel(): void {
    if (!editSession) return;
    requireDiscard("Discard the unsaved dashboard changes and exit edit mode?", () => undefined);
  }

  function confirmDiscard(continueAction: () => void): void {
    setDialog(null);
    end();
    queueMicrotask(continueAction);
  }

  function saveThenContinue(continueAction: () => void): void {
    void save().then((saved) => {
      if (!saved) return;
      setDialog(null);
      continueAction();
    });
  }

  const editingActiveProject = Boolean(editSession && editSession.projectRoot === snapshot?.projectRoot);
  return {
    session: editSession,
    saving,
    dirty: isDirty(editSession),
    valid: Boolean(editSession?.validation.diagnostics.every((item) => item.severity !== "error")),
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
