import type { ActionInvocation, AppSettings } from "./contracts";

/*
 * Notifications are decisions the app puts in front of the user about
 * something outside their current view. Every entry offers Dismiss and at
 * least one act (Show, plus at most one declared action). Acting marks it
 * read; it stays open until the user dismisses it or the condition that
 * raised it clears, and then moves to the session's history. The main
 * process owns the inbox; the renderer presents it. These types are
 * app-internal and deliberately not part of `contracts.ts`, whose
 * declarations ship in the SDK.
 */

/** Interrupt puts the decision in front of the user; inform only records it. */
export type NotificationLevel = "interrupt" | "inform";

/** The closed set of event kinds the app understands. */
export type NotificationKind =
  | "run-failed"
  | "run-finished"
  | "agent-needs-you"
  | "agent-finished"
  | "agent-failed"
  | "app-release"
  | "package-updates"
  | "notify"
  | "watch-state"
  | "watch-item"
  | "watch-error"
  | "watch-paused";

/** What Show lands on. */
export type NotificationTarget =
  /** `attention:<node>` on the entry's dashboard, optionally on one list item. */
  | { kind: "node"; nodeId: string; itemId?: string }
  /** The Agent session modal for one task. */
  | { kind: "agent-session"; taskId: string }
  /** Settings › Updates. */
  | { kind: "updates" }
  /** The entry's dashboard, without a node (for example to review trust). */
  | { kind: "dashboard" };

/** One declared act offered beside Show and Dismiss. */
export interface NotificationAction {
  label: string;
  invocation: ActionInvocation;
}

export interface NotificationEntry {
  /** Stable while the entry stays open, across coalesced raises. */
  id: string;
  /** Raises with the same key coalesce into one open entry; a cleared condition resolves its key. */
  key: string;
  kind: NotificationKind;
  level: NotificationLevel;
  /** Owning dashboard bundle, or null for app-level entries such as an app release. */
  configPath: string | null;
  dashboardName: string | null;
  title: string;
  message: string;
  target: NotificationTarget;
  action?: NotificationAction;
  createdAt: string;
  updatedAt: string;
  /** Raises coalesced into this entry. */
  count: number;
  /**
   * Increases from a global sequence each time the entry should be put in
   * front of the user; 0 when it never was (inform entries, muted interrupts).
   * The renderer presents entries whose value it has not seen yet.
   */
  presentation: number;
  /** The last presentation went to a native notification because the window was in the background. */
  deliveredNatively?: boolean;
  /**
   * The user acted on it, or saw its target on screen. Read entries stay open
   * while their condition holds but no longer count as needing the user.
   */
  read: boolean;
}

/** Why an entry left the open inbox. */
export type NotificationClosedBy =
  /** The user dismissed it. */
  | "dismissed"
  /** Its condition cleared: a new run, a recovered status, an answered request, new agent work. */
  | "cleared";

/** A closed entry, kept in the session's history so the user can tell what happened to it. */
export interface ClosedNotificationEntry extends NotificationEntry {
  closedAt: string;
  closedBy: NotificationClosedBy;
}

export interface NotificationState {
  /** Open decisions, newest first. */
  entries: NotificationEntry[];
  /** Closed entries of this app session, most recently closed first. */
  history: ClosedNotificationEntry[];
  /**
   * Main's view of whether the app window is key. The webview's own
   * `document.hasFocus()` can stay false after the app is activated (for
   * example by clicking a system notification), so presentation trusts this.
   */
  windowFocused?: boolean;
}

export type NotificationCommand =
  /** Show or the declared action ran, or the target was already on screen; the entries stay open. */
  | { type: "read"; ids: string[] }
  /** The user dismissed these entries; they move to the history. */
  | { type: "dismiss"; ids: string[] }
  /** Dismiss every open entry, or every entry of one dashboard (`null` for app-level entries). */
  | { type: "dismiss-all"; configPath?: string | null }
  /** Forget the closed entries. */
  | { type: "clear-history" }
  /** `notify:<node>` on the active dashboard. */
  | { type: "notify"; nodeId: string; message: string; itemId?: string };

/** Notification preferences as app settings persist them. */
export type NotificationSettings = NonNullable<AppSettings["notifications"]>;

/** Per-user, per-dashboard notification level; never YAML. */
export type DashboardNotificationLevel = NotificationSettings["dashboards"][string];

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = Object.freeze({
  native: true,
  watches: true,
  dashboards: Object.freeze({}) as Record<string, DashboardNotificationLevel>,
});

export const NOTIFICATION_TITLE_MAX_CHARS = 120;
export const NOTIFICATION_MESSAGE_MAX_CHARS = 200;
/** Open entries kept per dashboard (and for app-level entries); the oldest go first. */
export const NOTIFICATION_INBOX_MAX_PER_DASHBOARD = 50;
/** Closed entries kept across all dashboards for the app session; the oldest go first. */
export const NOTIFICATION_HISTORY_MAX = 100;

export const INITIAL_NOTIFICATION_STATE: NotificationState = Object.freeze({ entries: [], history: [] });

/** Bound text to `max` characters, ending in an ellipsis when it was cut. */
export function boundNotificationText(text: string, max: number): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

export function notificationLevelFor(settings: NotificationSettings | undefined, configPath: string | null): DashboardNotificationLevel {
  if (configPath === null) return "all";
  return settings?.dashboards[configPath] ?? "all";
}

/** Normalize persisted settings; unknown values fall back to the defaults. */
export function normalizeNotificationSettings(value: unknown): NotificationSettings {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const dashboards: Record<string, DashboardNotificationLevel> = {};
  const levels = record.dashboards && typeof record.dashboards === "object" && !Array.isArray(record.dashboards)
    ? record.dashboards as Record<string, unknown>
    : {};
  for (const [configPath, level] of Object.entries(levels)) {
    if (configPath.trim() && (level === "inform" || level === "off")) dashboards[configPath] = level;
  }
  return {
    native: typeof record.native === "boolean" ? record.native : DEFAULT_NOTIFICATION_SETTINGS.native,
    watches: typeof record.watches === "boolean" ? record.watches : DEFAULT_NOTIFICATION_SETTINGS.watches,
    dashboards,
  };
}

/** Unread open interrupts, which the dock badge and the header count show. */
export function unreadInterruptCount(state: Pick<NotificationState, "entries">): number {
  return state.entries.filter((entry) => entry.level === "interrupt" && !entry.read).length;
}

/** Unread open entries. */
export function unreadNotificationCount(state: Pick<NotificationState, "entries">): number {
  return state.entries.filter((entry) => !entry.read).length;
}
