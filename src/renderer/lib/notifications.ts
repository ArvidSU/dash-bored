import { MAX_ATTENTION_MESSAGE_CHARS } from "../../shared/action-reference";
import type { AppSettings, ProjectSnapshot } from "../../shared/contracts";
import {
  NOTIFICATION_HISTORY_MAX,
  normalizeNotificationSettings,
  type ClosedNotificationEntry,
  type DashboardNotificationLevel,
  type NotificationClosedBy,
  type NotificationCommand,
  type NotificationEntry,
  type NotificationLevel,
  type NotificationSettings,
  type NotificationState,
} from "../../shared/notifications";
import type { PaletteAction } from "./actions";
import { nodeFrame } from "./reveal-item";
import { dashboardNodeEntries } from "./virtual-root";

/*
 * Renderer-side notification rules: which presentations to put in front of
 * the user, the local effect of a command, `notify:<node>` arguments, labels,
 * and the Settings patches. The main process owns the inbox; everything here
 * is pure except the on-screen check at the end, which reads the mounted
 * dashboard.
 */

/** The presentation number already handled per open entry; main bumps it on every interrupt it presents. */
export type HandledPresentations = ReadonlyMap<string, number>;

/** Unread interrupts with a presentation this window has not handled yet, newest first. */
export function pendingPresentations(
  entries: readonly NotificationEntry[],
  handled: HandledPresentations,
): NotificationEntry[] {
  return entries
    .filter((entry) => entry.level === "interrupt" && !entry.read && entry.presentation > (handled.get(entry.id) ?? 0))
    .sort((left, right) => right.presentation - left.presentation);
}

export interface PresentationContext {
  /** The window is shown (not minimized or on another space). */
  visible: boolean;
  /** The document has keyboard focus, so the user is in this window. */
  focused: boolean;
  /** The entry's target is on screen right now. */
  targetVisible(entry: NotificationEntry): boolean;
}

export interface PresentationDecision {
  /** Entries whose target the user is already looking at; they are marked read. */
  seen: string[];
  /** The newest remaining decision to put in front of the user. */
  present: NotificationEntry | null;
  handled: Map<string, number>;
}

/**
 * One presentation pass. A decision that already went out as a system
 * notification waits until the user is back in the window; then, like an
 * in-app one, it is marked read when its target is on screen or becomes the
 * notice. Older pending decisions stay in the inbox.
 */
export function decidePresentation(
  state: NotificationState,
  handled: HandledPresentations,
  context: PresentationContext,
): PresentationDecision {
  const open = new Set(state.entries.map((entry) => entry.id));
  const next = new Map([...handled].filter(([id]) => open.has(id)));
  const decision: PresentationDecision = { seen: [], present: null, handled: next };
  if (!context.visible) return decision;
  for (const entry of pendingPresentations(state.entries, handled)) {
    if (!context.focused && entry.deliveredNatively) continue;
    next.set(entry.id, entry.presentation);
    if (context.targetVisible(entry)) decision.seen.push(entry.id);
    else decision.present ??= entry;
  }
  return decision;
}

/**
 * What a command does to the inbox, applied locally before the host confirms;
 * the host's next push is authoritative. Dismissed entries move to the history.
 */
export function applyNotificationCommand(state: NotificationState, command: NotificationCommand, now: Date = new Date()): NotificationState {
  const dismiss = (closing: (entry: NotificationEntry) => boolean): NotificationState => {
    const closedAt = now.toISOString();
    const closed = state.entries.filter(closing).map((entry): ClosedNotificationEntry => ({ ...entry, closedAt, closedBy: "dismissed" }));
    if (closed.length === 0) return state;
    return {
      ...state,
      entries: state.entries.filter((entry) => !closing(entry)),
      history: [...closed, ...state.history].slice(0, NOTIFICATION_HISTORY_MAX),
    };
  };
  switch (command.type) {
    case "read": {
      const ids = new Set(command.ids);
      if (!state.entries.some((entry) => ids.has(entry.id) && !entry.read)) return state;
      return { ...state, entries: state.entries.map((entry) => ids.has(entry.id) ? { ...entry, read: true } : entry) };
    }
    case "dismiss": {
      const ids = new Set(command.ids);
      return dismiss((entry) => ids.has(entry.id));
    }
    case "dismiss-all":
      return dismiss((entry) => command.configPath === undefined || entry.configPath === command.configPath);
    case "clear-history":
      return state.history.length === 0 ? state : { ...state, history: [] };
    default:
      return state;
  }
}

export interface NotifyRequest {
  message: string;
  item?: string;
}

const NOTIFY_ITEM_MAX_CHARS = 512;
const NOTIFY_USAGE = `notify accepts only { message: text of at most ${MAX_ATTENTION_MESSAGE_CHARS} characters, item?: stable item ID }.`;

/** Read `notify:<node>` arguments; a message is required and anything else is refused. */
export function notifyArguments(args: Record<string, unknown> | undefined): NotifyRequest {
  let message: string | undefined;
  let item: string | undefined;
  for (const [key, value] of Object.entries(args ?? {})) {
    if (key === "message" && typeof value === "string" && value.trim() && value.length <= MAX_ATTENTION_MESSAGE_CHARS) message = value.trim();
    else if (key === "item" && typeof value === "string" && value.trim() && value.length <= NOTIFY_ITEM_MAX_CHARS) item = value;
    else throw new Error(NOTIFY_USAGE);
  }
  if (message === undefined) throw new Error(`notify needs a message. ${NOTIFY_USAGE}`);
  return { message, ...(item === undefined ? {} : { item }) };
}

/**
 * `notify:<node>` for every node of the active dashboard. They need a message,
 * which the palette cannot ask for, so they are sub-actions: agents, buttons,
 * and shortcuts with arguments reach them, palette searches do not.
 */
export function buildNotifyActions(
  snapshot: Pick<ProjectSnapshot, "tree"> | null,
  notify: (nodeId: string, request: NotifyRequest) => Promise<void>,
): PaletteAction[] {
  if (!snapshot?.tree) return [];
  return dashboardNodeEntries(snapshot.tree).map(({ node, label }): PaletteAction => ({
    id: `notify:${encodeURIComponent(node.id)}`,
    reference: `notify:${encodeURIComponent(node.id)}`,
    parentActionId: "project:notify",
    label: `Notify about ${label}`,
    description: `Leave the user a decision about ${label}: a notification with Show and Dismiss. Needs a message; an item argument targets one list item.`,
    keywords: ["notify", "notification", "done", "blocked", node.id, node.component, label],
    group: "Notifications",
    source: node.id,
    enabled: true,
    run: (_selections, args) => notify(node.id, notifyArguments(args)),
  }));
}

/** Unread open entries per dashboard config path (`""` for app-level entries), by level. */
export function notificationMarks(state: Pick<NotificationState, "entries">): Map<string, { interrupt: number; inform: number }> {
  const marks = new Map<string, { interrupt: number; inform: number }>();
  for (const entry of state.entries) {
    if (entry.read) continue;
    const key = entry.configPath ?? "";
    const mark = marks.get(key) ?? { interrupt: 0, inform: 0 };
    mark[entry.level] += 1;
    marks.set(key, mark);
  }
  return marks;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** What a sidebar mark says about unread entries: interrupts first, then the total. */
export function notificationMarkLabel(mark: { interrupt: number; inform: number }): string {
  const total = mark.interrupt + mark.inform;
  const unread = plural(total, "unread notification", "unread notifications");
  if (mark.interrupt === 0) return unread;
  return `${unread}, ${mark.interrupt} ${mark.interrupt === 1 ? "needs" : "need"} you`;
}

export interface NotificationTriggerCounts {
  /** Unread open interrupts. */
  interrupts: number;
  /** Unread open entries of both levels. */
  unread: number;
  /** Open entries, read or not. */
  open: number;
}

/** The header trigger's name: its action, then what is unread, then what is open but read. */
export function notificationTriggerLabel(expanded: boolean, counts: NotificationTriggerCounts): string {
  const informs = counts.unread - counts.interrupts;
  const read = counts.open - counts.unread;
  return [
    expanded ? "Close notifications" : "Open notifications",
    ...(counts.interrupts > 0 ? [`${counts.interrupts} ${counts.interrupts === 1 ? "needs" : "need"} you`] : []),
    ...(informs > 0 ? [`${informs} for information`] : []),
    ...(read > 0 ? [`${read} read and still open`] : []),
  ].join(", ");
}

/** The header trigger's tooltip: the most pressing count. */
export function notificationTriggerTitle(counts: NotificationTriggerCounts): string {
  if (counts.interrupts > 0) return `${counts.interrupts} ${counts.interrupts === 1 ? "notification needs" : "notifications need"} you`;
  if (counts.unread > 0) return plural(counts.unread, "unread notification", "unread notifications");
  if (counts.open > 0) return plural(counts.open, "open notification", "open notifications");
  return "Notifications";
}

export const NOTIFICATION_LEVEL_LABELS: Record<NotificationLevel, string> = {
  interrupt: "Needs you",
  inform: "For information",
};

/** How a closed entry ended, as its history row names it. */
export const NOTIFICATION_CLOSED_BY_LABELS: Record<NotificationClosedBy, { label: string; description: string }> = {
  cleared: { label: "Cleared", description: "Its cause cleared, such as a new run, a recovered status, or an answered request." },
  dismissed: { label: "Dismissed", description: "You dismissed it." },
};

/** Where an entry comes from: its dashboard, or the app for app-level entries. */
export function notificationSourceLabel(entry: Pick<NotificationEntry, "configPath" | "dashboardName">): string {
  if (entry.configPath === null) return "dash-bored";
  return entry.dashboardName?.trim() || entry.configPath.split(/[\\/]/).filter(Boolean).slice(-3, -2)[0] || "Dashboard";
}

/** What Show does for an entry, for the button's description. */
export function notificationShowDescription(entry: Pick<NotificationEntry, "target">): string {
  switch (entry.target.kind) {
    case "node": return entry.target.itemId ? "Show the item on its dashboard" : "Show the component on its dashboard";
    case "agent-session": return "Open the agent session";
    case "updates": return "Open Settings › Updates";
    default: return "Open the dashboard";
  }
}

/** A short relative time for rows: "now", "5 min ago", "3 h ago", or the date. */
export function notificationTime(iso: string, now: Date = new Date()): string {
  const time = new Date(iso);
  if (Number.isNaN(time.getTime())) return "";
  const seconds = Math.max(0, Math.round((now.getTime() - time.getTime()) / 1000));
  if (seconds < 45) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return time.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** The persisted preferences, normalized like main reads them. */
export function notificationPreferences(settings: Pick<AppSettings, "notifications">): NotificationSettings {
  return normalizeNotificationSettings(settings.notifications);
}

/** Settings with one switch changed. */
export function withNotificationSwitch(settings: AppSettings, key: "native" | "watches", value: boolean): AppSettings {
  return { ...settings, notifications: normalizeNotificationSettings({ ...notificationPreferences(settings), [key]: value }) };
}

/** Settings with one dashboard's level changed; `all` is the default and is not stored. */
export function withDashboardNotificationLevel(settings: AppSettings, configPath: string, level: DashboardNotificationLevel): AppSettings {
  const current = notificationPreferences(settings);
  const dashboards = { ...current.dashboards, [configPath]: level };
  return { ...settings, notifications: normalizeNotificationSettings({ ...current, dashboards }) };
}

export const DASHBOARD_NOTIFICATION_LEVEL_LABELS: Record<DashboardNotificationLevel, string> = {
  all: "All",
  inform: "Inform only",
  off: "Off",
};

export interface ViewportBox {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Visible pixels of `box` that fall inside `viewport`, per axis. */
export function visibleExtent(box: ViewportBox, viewport: ViewportBox): { width: number; height: number } {
  return {
    width: Math.max(0, Math.min(box.right, viewport.right) - Math.max(box.left, viewport.left)),
    height: Math.max(0, Math.min(box.bottom, viewport.bottom) - Math.max(box.top, viewport.top)),
  };
}

/** On screen means a meaningful part shows: 24 px each way, or all of a smaller box. */
export function boxOnScreen(box: ViewportBox, viewport: ViewportBox): boolean {
  const width = box.right - box.left;
  const height = box.bottom - box.top;
  if (width <= 0 || height <= 0) return false;
  const visible = visibleExtent(box, viewport);
  return visible.width >= Math.min(24, width) && visible.height >= Math.min(24, height);
}

/**
 * Whether a node (or one of its items) is mounted and on screen in the
 * dashboard: inside the window's page scroller, not just in the document.
 */
export function nodeOnScreen(nodeId: string, itemId?: string): boolean {
  const frame = nodeFrame(nodeId);
  if (!frame?.closest(".workspace")) return false;
  const target = itemId === undefined
    ? frame
    : [...frame.querySelectorAll<HTMLElement>("[data-item-id]")].find((element) => element.dataset.itemId === itemId);
  if (!target) return false;
  const scroller = document.querySelector<HTMLElement>(".app-frame__scroll")?.getBoundingClientRect();
  const viewport: ViewportBox = {
    top: Math.max(0, scroller?.top ?? 0),
    left: Math.max(0, scroller?.left ?? 0),
    bottom: Math.min(window.innerHeight, scroller?.bottom ?? window.innerHeight),
    right: Math.min(window.innerWidth, scroller?.right ?? window.innerWidth),
  };
  return boxOnScreen(target.getBoundingClientRect(), viewport);
}
