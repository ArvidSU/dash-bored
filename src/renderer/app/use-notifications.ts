import { useCallback, useEffect, useRef, useState } from "react";
import { actionInvocation } from "../../shared/action-invocation";
import type { ProjectListItem, ProjectSnapshot } from "../../shared/contracts";
import {
  INITIAL_NOTIFICATION_STATE,
  type NotificationCommand,
  type NotificationEntry,
  type NotificationState,
} from "../../shared/notifications";
import type { AppView } from "../lib/action-providers";
import type { ActionStore } from "../lib/actions";
import { applyNotificationCommand, decidePresentation, type HandledPresentations } from "../lib/notifications";
import { host } from "../lib/rpc-client";
import { errorMessage } from "./app-utils";
import { useLatestRef } from "./use-latest-ref";

/**
 * The open notification decisions and the session's closed ones: read once,
 * then kept current by the host's `notifications` pushes. Commands apply
 * locally first; the push that follows is authoritative.
 */
export function useNotifications(onError: (message: string) => void) {
  const [state, setState] = useState<NotificationState>(INITIAL_NOTIFICATION_STATE);
  const onErrorRef = useLatestRef(onError);
  useEffect(() => {
    let active = true;
    let pushed = false;
    const unsubscribe = host.subscribe((event) => {
      if (event.type !== "notifications") return;
      pushed = true;
      setState(event.state);
    });
    // A push that lands before this read is newer than its answer.
    host.getNotifications().then(
      (initial) => { if (active && !pushed) setState(initial); },
      (caught: unknown) => { if (active) onErrorRef.current(errorMessage(caught)); },
    );
    return () => { active = false; unsubscribe(); };
  }, [onErrorRef]);

  const command = useCallback(async (next: NotificationCommand): Promise<void> => {
    setState((current) => applyNotificationCommand(current, next));
    try {
      await host.notificationCommand(next);
    } catch (caught) {
      // A refused notify belongs to whoever invoked it (often an agent), not the error banner.
      if (next.type === "notify") throw caught;
      onErrorRef.current(errorMessage(caught));
    }
  }, [onErrorRef]);

  /** Show or the declared action ran, or the target is on screen: the entries stay open. */
  const markRead = useCallback((ids: readonly string[]): void => {
    if (ids.length > 0) void command({ type: "read", ids: [...ids] });
  }, [command]);

  const dismiss = useCallback((ids: readonly string[]): void => {
    if (ids.length > 0) void command({ type: "dismiss", ids: [...ids] });
  }, [command]);

  const dismissAll = useCallback((): void => {
    void command({ type: "dismiss-all" });
  }, [command]);

  const clearHistory = useCallback((): void => {
    void command({ type: "clear-history" });
  }, [command]);

  return { state, command, markRead, dismiss, dismissAll, clearHistory };
}

export type NotificationsController = ReturnType<typeof useNotifications>;

/**
 * Puts new interrupts in front of the user. While the window is in front, a
 * decision about something already on screen is marked read and the newest
 * other one becomes the decision notice; one that went out as a system
 * notification waits until the window regains focus.
 */
export function useNotificationPresentation(
  state: NotificationState,
  targetVisible: (entry: NotificationEntry) => boolean,
  markRead: (ids: readonly string[]) => void,
) {
  const handled = useRef<HandledPresentations>(new Map());
  const [notice, setNotice] = useState<{ id: string; presentation: number } | null>(null);
  const stateRef = useLatestRef(state);
  const targetVisibleRef = useLatestRef(targetVisible);
  const markReadRef = useLatestRef(markRead);

  const evaluate = useCallback((): void => {
    const decision = decidePresentation(stateRef.current, handled.current, {
      visible: document.visibilityState !== "hidden",
      focused: stateRef.current.windowFocused === true || document.hasFocus(),
      targetVisible: (entry) => targetVisibleRef.current(entry),
    });
    handled.current = decision.handled;
    if (decision.seen.length > 0) markReadRef.current(decision.seen);
    const present = decision.present;
    if (present) setNotice({ id: present.id, presentation: present.presentation });
  }, [markReadRef, stateRef, targetVisibleRef]);

  // After the render that shows the new state, so frames are measured as drawn.
  useEffect(evaluate, [evaluate, state]);

  useEffect(() => {
    // Returning to the window puts decisions that went out as system notifications in front.
    const onChange = () => evaluate();
    window.addEventListener("focus", onChange);
    document.addEventListener("visibilitychange", onChange);
    return () => {
      window.removeEventListener("focus", onChange);
      document.removeEventListener("visibilitychange", onChange);
    };
  }, [evaluate]);

  // Acting on the decision anywhere marks it read, which also takes it out of the notice.
  const entry = notice ? state.entries.find((candidate) => candidate.id === notice.id && !candidate.read) ?? null : null;
  const hide = useCallback(() => setNotice(null), []);
  // Only a new presentation brings a read or closed decision back.
  useEffect(() => {
    if (notice && !entry) setNotice(null);
  }, [entry, notice]);
  return {
    /** The decision in front of the user, current with coalesced raises; null once it is read or closed. */
    notice: entry,
    /** Changes with every presentation, so the notice restarts its timer and announcement. */
    noticeKey: entry && notice ? `${notice.id}:${notice.presentation}` : null,
    hide,
  };
}

export interface NotificationLandingOptions {
  snapshot: ProjectSnapshot | null;
  projects: readonly ProjectListItem[];
  store: ActionStore;
  /** Runs a reference the way a button does: confirmations and choices still apply. */
  request(reference: string, args?: Record<string, unknown>, callerNodeId?: string): void;
  setActiveView(view: AppView): void;
  /** Opens a registered dashboard; a dirty draft may ask first. */
  openDashboard(project: ProjectListItem): void | Promise<void>;
  showUpdates(): void;
  openAgentSession(taskId: string): void;
  markRead(ids: readonly string[]): void;
  setError(message: string | null): void;
  showNotice(message: string): void;
}

/** How long a Show or action waits for its dashboard to open before it is dropped. */
const LANDING_TIMEOUT_MS = 30_000;

interface Landing {
  entry: NotificationEntry;
  kind: "show" | "action";
  startedAt: number;
}

/**
 * Acting on a decision: Show lands on its target and the declared action runs
 * through the shared executor. Both mark the entry read and leave it open, so
 * the other act and Dismiss stay available until its cause clears. A target
 * on another dashboard opens that dashboard first and acts once it is loaded.
 * Show also works on closed entries from the history.
 */
export function useNotificationLanding(options: NotificationLandingOptions) {
  const [landing, setLanding] = useState<Landing | null>(null);
  const optionsRef = useLatestRef(options);

  const land = useCallback(async (entry: NotificationEntry, kind: Landing["kind"]): Promise<void> => {
    const { snapshot, store, request, setActiveView, markRead, setError, showNotice } = optionsRef.current;
    const nodeId = entry.target.kind === "node" ? entry.target.nodeId : undefined;
    markRead([entry.id]);
    if (kind === "action" && entry.action) {
      const invocation = actionInvocation(entry.action.invocation);
      if (!invocation) {
        setError(`${entry.action.label} is not a valid action.`);
        return;
      }
      if (entry.configPath !== null) setActiveView("dashboard");
      request(invocation.run, invocation.with, nodeId);
      return;
    }
    setActiveView("dashboard");
    // A dashboard that does not load shows its diagnostics instead of the node.
    if (entry.target.kind !== "node" || !snapshot?.tree) return;
    const reference = `attention:${encodeURIComponent(entry.target.nodeId)}`;
    if (!store.get(reference)) {
      showNotice(`${entry.title}: that component is no longer on this dashboard.`);
      return;
    }
    const message = entry.message ? { message: entry.message } : {};
    let result = await store.run(reference, {}, { ...message, ...(entry.target.itemId ? { item: entry.target.itemId } : {}) });
    // A filtered or removed item still lands on its component.
    if (result.status === "failed" && entry.target.itemId) result = await store.run(reference, {}, message);
    if (result.status === "failed") setError(errorMessage(result.error));
  }, [optionsRef]);

  const act = useCallback((entry: NotificationEntry, kind: Landing["kind"]): void => {
    const { snapshot, projects, showUpdates, openAgentSession, markRead, openDashboard, setError } = optionsRef.current;
    if (kind === "show" && entry.target.kind === "agent-session") {
      markRead([entry.id]);
      openAgentSession(entry.target.taskId);
      return;
    }
    if (kind === "show" && entry.target.kind === "updates") {
      markRead([entry.id]);
      showUpdates();
      return;
    }
    if (entry.configPath === null || entry.configPath === snapshot?.configPath) {
      setLanding(null);
      void land(entry, kind);
      return;
    }
    const project = projects.find((candidate) => candidate.configPath === entry.configPath);
    if (!project) {
      setError(`${entry.dashboardName ?? "That dashboard"} is no longer registered.`);
      return;
    }
    setLanding({ entry, kind, startedAt: Date.now() });
    void openDashboard(project);
  }, [land, optionsRef]);

  // Act once the entry's dashboard is the loaded snapshot; the store already
  // holds its actions because providers register in a layout effect.
  const snapshot = options.snapshot;
  useEffect(() => {
    if (!landing || snapshot?.configPath !== landing.entry.configPath) return;
    setLanding(null);
    if (Date.now() - landing.startedAt > LANDING_TIMEOUT_MS) return;
    void land(landing.entry, landing.kind);
  }, [land, landing, snapshot]);

  return {
    show: useCallback((entry: NotificationEntry) => act(entry, "show"), [act]),
    runAction: useCallback((entry: NotificationEntry) => act(entry, "action"), [act]),
  };
}
