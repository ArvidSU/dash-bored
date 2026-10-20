import {
  boundNotificationText,
  NOTIFICATION_HISTORY_MAX,
  NOTIFICATION_INBOX_MAX_PER_DASHBOARD,
  NOTIFICATION_MESSAGE_MAX_CHARS,
  NOTIFICATION_TITLE_MAX_CHARS,
  notificationLevelFor,
  unreadInterruptCount,
  type ClosedNotificationEntry,
  type NotificationAction,
  type NotificationClosedBy,
  type NotificationCommand,
  type NotificationEntry,
  type NotificationKind,
  type NotificationLevel,
  type NotificationSettings,
  type NotificationState,
  type NotificationTarget,
} from "../shared/notifications";

/** One event as a producer reports it; the center decides level, coalescing, and delivery. */
export interface NotificationRaise {
  key: string;
  kind: NotificationKind;
  level: NotificationLevel;
  configPath: string | null;
  dashboardName: string | null;
  title: string;
  message: string;
  target: NotificationTarget;
  action?: NotificationAction;
  /** Record the decision without putting it in front of the user, such as a baseline that was already bad. */
  quiet?: boolean;
}

export interface NativeNotification {
  title: string;
  subtitle?: string;
  body: string;
}

export interface NotificationCenterOptions {
  publish(state: NotificationState): void;
  /** Deliver a system notification; failures are the caller's to log. */
  showNative(notification: NativeNotification): void;
  /** Show the open-interrupt count on the dock icon; 0 clears it. */
  setBadge(count: number): void;
  isWindowFocused(): boolean;
  settings(): NotificationSettings;
  now?(): Date;
  newId?(): string;
}

/** A repeated presentation of one key, or another `notify` from one dashboard, within this window only records. */
export const PRESENTATION_COOLDOWN_MS = 30_000;

/**
 * The inbox of open decisions and the session's history of closed ones.
 * Producers raise events and resolve keys whose condition cleared; the
 * renderer marks entries read when the user acts and closes the ones they
 * dismiss. Every change is pushed whole, and the dock badge follows the
 * unread open interrupts.
 */
export class NotificationCenter {
  private entries: NotificationEntry[] = [];
  private history: ClosedNotificationEntry[] = [];
  private sequence = 0;
  private readonly presentedAt = new Map<string, number>();
  private badge = -1;

  constructor(private readonly options: NotificationCenterOptions) {}

  state(): NotificationState {
    return {
      entries: this.entries.map((entry) => ({ ...entry, target: { ...entry.target } })),
      history: this.history.map((entry) => ({ ...entry, target: { ...entry.target } })),
      windowFocused: this.options.isWindowFocused(),
    };
  }

  /** Record an event; returns the open entry, or null when the dashboard's level is Off. */
  raise(input: NotificationRaise): NotificationEntry | null {
    const dashboardLevel = notificationLevelFor(this.options.settings(), input.configPath);
    if (dashboardLevel === "off") return null;
    const level: NotificationLevel = dashboardLevel === "inform" ? "inform" : input.level;
    const now = this.now();
    const title = boundNotificationText(input.title, NOTIFICATION_TITLE_MAX_CHARS) || "dash-bored";
    const message = boundNotificationText(input.message, NOTIFICATION_MESSAGE_MAX_CHARS);
    const existing = this.entries.find((entry) => entry.key === input.key);
    const entry: NotificationEntry = existing
      ? {
          ...existing,
          kind: input.kind,
          // A coalesced raise never quietly downgrades an open interrupt.
          level: existing.level === "interrupt" ? "interrupt" : level,
          dashboardName: input.dashboardName,
          title,
          message,
          target: input.target,
          ...(input.action ? { action: input.action } : {}),
          updatedAt: now.toISOString(),
          count: existing.count + 1,
        }
      : {
          id: this.newId(),
          key: input.key,
          kind: input.kind,
          level,
          configPath: input.configPath,
          dashboardName: input.dashboardName,
          title,
          message,
          target: input.target,
          ...(input.action ? { action: input.action } : {}),
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
          count: 1,
          presentation: 0,
          read: false,
        };
    if (!input.action && existing?.action) delete entry.action;
    // Read entries stay read through repeated observations; news makes them unread again.
    if (existing?.read && (existing.title !== title || existing.message !== message)) entry.read = false;
    if (level === "interrupt" && !input.quiet && this.mayPresent(input, now.getTime())) {
      this.sequence += 1;
      entry.presentation = this.sequence;
      entry.read = false;
      const native = !this.options.isWindowFocused();
      entry.deliveredNatively = native;
      if (native && this.options.settings().native) {
        this.options.showNative({
          title: entry.title,
          ...(entry.dashboardName ? { subtitle: entry.dashboardName } : {}),
          body: entry.message,
        });
      }
    }
    this.entries = [entry, ...this.entries.filter((candidate) => candidate.key !== input.key)];
    this.bound(entry.configPath);
    this.changed();
    return { ...entry };
  }

  /** The condition behind these keys cleared; their open entries move to the history without a decision. */
  resolve(keys: string | readonly string[]): void {
    const closing = new Set(typeof keys === "string" ? [keys] : keys);
    this.close((entry) => closing.has(entry.key), "cleared");
  }

  /** Close every open entry whose key starts with `prefix`, such as all of one agent task's entries. */
  resolvePrefix(prefix: string): void {
    this.close((entry) => entry.key.startsWith(prefix), "cleared");
  }

  /** Forget open and closed entries of dashboards that left the registry. */
  retainDashboards(registered: ReadonlySet<string>): void {
    const removed = (entry: NotificationEntry) => entry.configPath !== null && !registered.has(entry.configPath);
    const before = this.entries.length + this.history.length;
    this.entries = this.entries.filter((entry) => !removed(entry));
    this.history = this.history.filter((entry) => !removed(entry));
    if (this.entries.length + this.history.length !== before) this.changed();
  }

  command(command: Exclude<NotificationCommand, { type: "notify" }>): void {
    switch (command.type) {
      case "read": {
        const ids = new Set(command.ids);
        if (!this.entries.some((entry) => ids.has(entry.id) && !entry.read)) return;
        this.entries = this.entries.map((entry) => ids.has(entry.id) ? { ...entry, read: true } : entry);
        this.changed();
        return;
      }
      case "dismiss": {
        const ids = new Set(command.ids);
        this.close((entry) => ids.has(entry.id), "dismissed");
        return;
      }
      case "dismiss-all":
        this.close((entry) => command.configPath === undefined || entry.configPath === command.configPath, "dismissed");
        return;
      case "clear-history":
        if (this.history.length === 0) return;
        this.history = [];
        this.changed();
    }
  }

  /** Re-apply the badge and push the inbox after settings or window focus change. */
  refresh(): void {
    this.changed(true);
  }

  private mayPresent(input: NotificationRaise, now: number): boolean {
    const keys = [input.key, ...input.kind === "notify" ? [`notify-dashboard:${input.configPath ?? ""}`] : []];
    if (keys.some((key) => now - (this.presentedAt.get(key) ?? Number.NEGATIVE_INFINITY) < PRESENTATION_COOLDOWN_MS)) {
      return false;
    }
    for (const key of keys) this.presentedAt.set(key, now);
    return true;
  }

  /** Keep at most the newest entries per dashboard, dropping informs before interrupts and read before unread. */
  private bound(configPath: string | null): void {
    const owned = this.entries.filter((entry) => entry.configPath === configPath);
    if (owned.length <= NOTIFICATION_INBOX_MAX_PER_DASHBOARD) return;
    const excess = owned.length - NOTIFICATION_INBOX_MAX_PER_DASHBOARD;
    const oldestFirst = [...owned].reverse();
    const tier = (level: NotificationLevel, read: boolean) => oldestFirst.filter((entry) => entry.level === level && entry.read === read);
    const dropped = new Set([
      ...tier("inform", true),
      ...tier("inform", false),
      ...tier("interrupt", true),
      ...tier("interrupt", false),
    ].slice(0, excess).map((entry) => entry.id));
    this.entries = this.entries.filter((entry) => !dropped.has(entry.id));
  }

  /** Move matching open entries to the front of the history. */
  private close(predicate: (entry: NotificationEntry) => boolean, closedBy: NotificationClosedBy): void {
    const closing = this.entries.filter(predicate);
    if (closing.length === 0) return;
    const closedAt = this.now().toISOString();
    this.entries = this.entries.filter((entry) => !predicate(entry));
    this.history = [
      ...closing.map((entry): ClosedNotificationEntry => ({ ...entry, closedAt, closedBy })),
      ...this.history,
    ].slice(0, NOTIFICATION_HISTORY_MAX);
    this.changed();
  }

  private changed(forceBadge = false): void {
    const count = unreadInterruptCount({ entries: this.entries });
    if (forceBadge || count !== this.badge) {
      this.badge = count;
      this.options.setBadge(count);
    }
    this.options.publish(this.state());
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private newId(): string {
    return this.options.newId?.() ?? crypto.randomUUID();
  }
}
