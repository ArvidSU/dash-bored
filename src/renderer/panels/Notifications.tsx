import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { AppSettings, ProjectListItem } from "../../shared/contracts";
import type {
  ClosedNotificationEntry,
  DashboardNotificationLevel,
  NotificationEntry,
  NotificationLevel,
  NotificationState,
} from "../../shared/notifications";
import { projectLabel } from "../lib/action-providers";
import {
  DASHBOARD_NOTIFICATION_LEVEL_LABELS,
  NOTIFICATION_CLOSED_BY_LABELS,
  NOTIFICATION_LEVEL_LABELS,
  notificationPreferences,
  notificationShowDescription,
  notificationSourceLabel,
  notificationTime,
  withDashboardNotificationLevel,
  withNotificationSwitch,
} from "../lib/notifications";
import { RightDrawer } from "../lib/right-drawer";
import "./notifications.css";

/*
 * Notifications are decisions: every one offers Show, at most one declared
 * action, and Dismiss. Acting marks an entry read and keeps it open until it
 * is dismissed or its cause clears; closed entries stay listed under Earlier.
 * Interrupts and informs differ in shape (a diamond with a mark, a circle
 * with an i), color, and text, never color alone; unread rows add a dot and
 * the word.
 */

/** How long the decision notice stays without hover or focus; the decision stays in the inbox. */
export const DECISION_NOTICE_MS = 15_000;

/** Header and sidebar triggers restore focus here after the notice or drawer closes. */
export const NOTIFICATIONS_TRIGGER_SELECTOR = ".notifications-trigger";

export function NotificationGlyph({ level }: { level: NotificationLevel }): ReactNode {
  return (
    <svg className={`notification-glyph notification-glyph--${level}`} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      {level === "interrupt" ? (
        <>
          <path d="M8 1.9 14.1 8 8 14.1 1.9 8Z" />
          <path d="M8 5.3v3.2" />
          <circle cx="8" cy="10.7" r="0.55" fill="currentColor" />
        </>
      ) : (
        <>
          <circle cx="8" cy="8" r="5.5" />
          <path d="M8 7.4v3.4" />
          <circle cx="8" cy="5.2" r="0.55" fill="currentColor" />
        </>
      )}
    </svg>
  );
}

export function NotificationBellIcon(): ReactNode {
  return (
    <svg className="notifications-trigger__icon" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path d="M5.5 13.5V9a4.5 4.5 0 0 1 9 0v4.5l1.5 1.5H4Z" />
      <path d="M8.3 16.6a1.9 1.9 0 0 0 3.4 0" />
    </svg>
  );
}

function focusNotificationsTrigger(): void {
  requestAnimationFrame(() => document.querySelector<HTMLElement>(NOTIFICATIONS_TRIGGER_SELECTOR)?.focus());
}

interface DecisionHandlers {
  onShow(entry: NotificationEntry): void;
  onAction(entry: NotificationEntry): void;
  onDismiss(entry: NotificationEntry): void;
}

function DecisionButtons({ entry, describedBy, onShow, onAction, onDismiss }: DecisionHandlers & {
  entry: NotificationEntry;
  describedBy: string;
}): ReactNode {
  return (
    <>
      <button className="button button--primary button--small" type="button" aria-describedby={describedBy}
        title={notificationShowDescription(entry)} onClick={() => onShow(entry)}>
        Show
      </button>
      {entry.action ? (
        <button className="button button--quiet button--small" type="button" aria-describedby={describedBy} onClick={() => onAction(entry)}>
          {entry.action.label}
        </button>
      ) : null}
      <button className="button button--quiet button--small notification__dismiss" type="button" aria-describedby={describedBy}
        onClick={() => onDismiss(entry)}>
        Dismiss
      </button>
    </>
  );
}

/** The plain-text announcement of one decision. */
function announcement(entry: NotificationEntry, source: string | null): string {
  return [`${NOTIFICATION_LEVEL_LABELS[entry.level]}: ${entry.title}.`, entry.message, source ? `From ${source}.` : ""]
    .filter(Boolean).join(" ");
}

/**
 * The decision in front of the user: title, message, where it comes from,
 * and its acts. It stays while hovered or focused and otherwise hides after
 * a while; hiding (also Escape) never decides, the entry stays in the inbox.
 */
export function DecisionNotice({
  entry,
  noticeKey,
  activeConfigPath,
  moreCount,
  onHide,
  onOpenInbox,
  ...handlers
}: DecisionHandlers & {
  entry: NotificationEntry | null;
  noticeKey: string | null;
  /** The dashboard on screen; the source is named when the entry belongs elsewhere. */
  activeConfigPath: string | null;
  /** Other open interrupts in the inbox. */
  moreCount: number;
  onHide(): void;
  onOpenInbox(): void;
}): ReactNode {
  const titleId = useId();
  const messageId = useId();
  const ref = useRef<HTMLElement>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [spoken, setSpoken] = useState("");
  const held = hovered || focused;
  const source = entry && (entry.configPath === null || entry.configPath !== activeConfigPath) ? notificationSourceLabel(entry) : null;

  useEffect(() => {
    if (!noticeKey || held) return;
    const timer = window.setTimeout(onHide, DECISION_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [held, noticeKey, onHide]);

  // Announce each presentation once; clearing first lets a repeated text speak again.
  const text = entry ? announcement(entry, source) : "";
  useEffect(() => {
    setSpoken("");
    if (!noticeKey) return;
    const frame = requestAnimationFrame(() => setSpoken(text));
    return () => cancelAnimationFrame(frame);
    // One presentation is read once, not again on every coalesced edit of its text.
  }, [noticeKey]);

  useEffect(() => {
    if (!entry) {
      setHovered(false);
      setFocused(false);
    }
  }, [entry]);

  /** Leaves keyboard focus somewhere useful when the notice goes away under it. */
  function leave(after: () => void): void {
    const hadFocus = ref.current?.contains(document.activeElement) ?? false;
    after();
    if (hadFocus) focusNotificationsTrigger();
  }

  return (
    <>
      <p className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">{spoken}</p>
      {entry ? (
        <section
          ref={ref}
          className={`decision-notice decision-notice--${entry.level}`}
          data-level={entry.level}
          data-notification-id={entry.id}
          aria-labelledby={titleId}
          aria-describedby={messageId}
          onPointerEnter={() => setHovered(true)}
          onPointerLeave={() => setHovered(false)}
          onFocus={() => setFocused(true)}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            leave(onHide);
          }}
        >
          <NotificationGlyph level={entry.level} />
          <div className="decision-notice__copy">
            <span className="decision-notice__heading">
              <span className="visually-hidden">{NOTIFICATION_LEVEL_LABELS[entry.level]}: </span>
              <strong id={titleId}>{entry.title}</strong>
              {entry.count > 1 ? <span className="notification__count" aria-label={`${entry.count} times`}>×{entry.count}</span> : null}
            </span>
            <span id={messageId} className="decision-notice__message">{entry.message}</span>
            {source || moreCount > 0 ? (
              <span className="decision-notice__meta">
                {source ? <span className="notification__source">{source}</span> : null}
                {moreCount > 0 ? (
                  <button className="decision-notice__more" type="button" onClick={onOpenInbox}>
                    {moreCount} more {moreCount === 1 ? "decision" : "decisions"}
                  </button>
                ) : null}
              </span>
            ) : null}
          </div>
          <div className="decision-notice__actions">
            <DecisionButtons
              entry={entry}
              describedBy={titleId}
              onShow={handlers.onShow}
              onAction={handlers.onAction}
              onDismiss={(dismissed) => leave(() => handlers.onDismiss(dismissed))}
            />
          </div>
        </section>
      ) : null}
    </>
  );
}

/** Ticks once a minute so relative times stay current while the drawer is open. */
function useMinuteClock(active: boolean): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!active) return;
    setNow(new Date());
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

function InboxRow({ entry, now, ...handlers }: DecisionHandlers & { entry: NotificationEntry; now: Date }): ReactNode {
  const titleId = useId();
  const time = notificationTime(entry.updatedAt, now);
  return (
    <li className={`notification-row notification-row--${entry.level}${entry.read ? "" : " notification-row--unread"}`}
      data-notification-id={entry.id} data-level={entry.level} data-read={entry.read} aria-labelledby={titleId}>
      <NotificationGlyph level={entry.level} />
      <div className="notification-row__copy">
        <span className="notification-row__heading">
          <span className="visually-hidden">{NOTIFICATION_LEVEL_LABELS[entry.level]}{entry.read ? "" : ", unread"}: </span>
          <strong id={titleId}>{entry.title}</strong>
          {entry.count > 1 ? <span className="notification__count" aria-label={`${entry.count} times`}>×{entry.count}</span> : null}
          {entry.read ? null : <span className="notification-row__unread" aria-hidden="true" title="Unread" />}
        </span>
        {entry.message ? <span className="notification-row__message">{entry.message}</span> : null}
        <span className="notification-row__meta">
          <span className="notification__source">{notificationSourceLabel(entry)}</span>
          {time ? <time dateTime={entry.updatedAt} title={new Date(entry.updatedAt).toLocaleString()}>{time}</time> : null}
        </span>
        <span className="notification-row__actions">
          <DecisionButtons entry={entry} describedBy={titleId} {...handlers} />
        </span>
      </div>
    </li>
  );
}

/** A closed entry: what it was, how it ended, and Show to look again. */
function HistoryRow({ entry, now, onShow }: { entry: ClosedNotificationEntry; now: Date; onShow(entry: NotificationEntry): void }): ReactNode {
  const titleId = useId();
  const time = notificationTime(entry.closedAt, now);
  const closedBy = NOTIFICATION_CLOSED_BY_LABELS[entry.closedBy];
  return (
    <li className={`notification-row notification-row--closed notification-row--${entry.level}`} data-notification-id={entry.id}
      data-level={entry.level} data-closed-by={entry.closedBy} aria-labelledby={titleId}>
      <NotificationGlyph level={entry.level} />
      <div className="notification-row__copy">
        <span className="notification-row__heading">
          <span className="visually-hidden">{NOTIFICATION_LEVEL_LABELS[entry.level]}: </span>
          <strong id={titleId}>{entry.title}</strong>
          {entry.count > 1 ? <span className="notification__count" aria-label={`${entry.count} times`}>×{entry.count}</span> : null}
        </span>
        {entry.message ? <span className="notification-row__message">{entry.message}</span> : null}
        <span className="notification-row__meta">
          <span className={`notification-row__outcome notification-row__outcome--${entry.closedBy}`} title={closedBy.description}>
            <svg viewBox="0 0 12 12" aria-hidden="true" focusable="false">
              {entry.closedBy === "cleared" ? <path d="m2.5 6.3 2.3 2.2 4.7-5" /> : <path d="m3.2 3.2 5.6 5.6M8.8 3.2 3.2 8.8" />}
            </svg>
            {closedBy.label}
          </span>
          <span className="notification__source">{notificationSourceLabel(entry)}</span>
          {time ? <time dateTime={entry.closedAt} title={new Date(entry.closedAt).toLocaleString()}>{time}</time> : null}
        </span>
        <span className="notification-row__actions">
          <button className="button button--quiet button--small" type="button" aria-describedby={titleId}
            title={notificationShowDescription(entry)} onClick={() => onShow(entry)}>
            Show
          </button>
        </span>
      </div>
    </li>
  );
}

/** The inbox: open decisions across dashboards, newest first, then what closed earlier this session. */
export function NotificationInbox({
  open,
  state,
  onClose,
  onDismissAll,
  onClearHistory,
  ...handlers
}: DecisionHandlers & {
  open: boolean;
  state: NotificationState;
  onClose(): void;
  onDismissAll(): void;
  onClearHistory(): void;
}): ReactNode {
  const now = useMinuteClock(open);
  const historyTitleId = useId();
  const count = state.entries.length;
  const unread = state.entries.filter((entry) => !entry.read).length;
  const closed = state.history.length;
  return (
    <RightDrawer
      open={open}
      onClose={onClose}
      title="Notifications"
      eyebrow="This app session"
      description="What needs you across dashboards. Show and actions keep an entry here until you dismiss it or its cause clears; then it moves to Earlier."
      closeLabel="Close notifications"
      restoreFocusSelector={NOTIFICATIONS_TRIGGER_SELECTOR}
      bodyClassName="notification-inbox"
      headerActions={count > 0 ? (
        <button className="button button--quiet button--small notification-inbox__dismiss-all" type="button"
          aria-label={`Dismiss all ${count} open ${count === 1 ? "notification" : "notifications"}`}
          onClick={onDismissAll}>
          Dismiss all
        </button>
      ) : undefined}
    >
      {count === 0 ? (
        <p className="notification-inbox__empty">
          Nothing needs you. Failed or finished runs, agents that need you, and updates appear here while you work elsewhere.
        </p>
      ) : (
        <ol className="notification-inbox__list"
          aria-label={`${count} open ${count === 1 ? "notification" : "notifications"}${unread > 0 ? `, ${unread} unread` : ""}`}>
          {state.entries.map((entry) => <InboxRow key={entry.id} entry={entry} now={now} {...handlers} />)}
        </ol>
      )}
      {closed > 0 ? (
        <section className="notification-inbox__history" aria-labelledby={historyTitleId}>
          <div className="notification-inbox__history-header">
            <h3 id={historyTitleId}>Earlier</h3>
            <button className="button button--quiet button--small" type="button"
              aria-label={`Clear ${closed} earlier ${closed === 1 ? "notification" : "notifications"}`}
              onClick={onClearHistory}>
              Clear
            </button>
          </div>
          <ol className="notification-inbox__list notification-inbox__list--history"
            aria-label={`${closed} closed ${closed === 1 ? "notification" : "notifications"}`}>
            {state.history.map((entry) => <HistoryRow key={entry.id} entry={entry} now={now} onShow={handlers.onShow} />)}
          </ol>
        </section>
      ) : null}
    </RightDrawer>
  );
}

/** Settings › General: system notifications, background watches, and per-dashboard levels. */
export function NotificationSettingsCard({
  settings,
  projects,
  disabled,
  onUpdate,
}: {
  settings: AppSettings;
  projects: readonly ProjectListItem[];
  disabled: boolean;
  onUpdate(settings: AppSettings, notice: string): void;
}): ReactNode {
  const preferences = notificationPreferences(settings);
  return (
    <section className="settings-card settings-card--notifications" aria-labelledby="notification-settings-title">
      <div>
        <h2 id="notification-settings-title">Notifications</h2>
        <p>
          Runs, agents, and updates that need you raise a decision with Show and Dismiss. Nothing interrupts about a
          component you are already looking at. Per-dashboard levels are yours, never part of the dashboard&apos;s YAML.
        </p>
      </div>
      <div className="notification-settings">
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={preferences.native}
            disabled={disabled}
            onChange={(event) => onUpdate(
              withNotificationSwitch(settings, "native", event.target.checked),
              event.target.checked ? "System notifications are on while dash-bored is in the background." : "System notifications are off.",
            )}
          />
          <span>System notifications while dash-bored is in the background</span>
        </label>
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={preferences.watches}
            disabled={disabled}
            onChange={(event) => onUpdate(
              withNotificationSwitch(settings, "watches", event.target.checked),
              event.target.checked ? "Background watches are on." : "Background watches are paused.",
            )}
          />
          <span>Background watches</span>
        </label>
        {projects.length > 0 ? (
          <div className="notification-settings__dashboards" role="group" aria-label="Notification level per dashboard">
            {projects.map((project) => {
              const label = projectLabel(project);
              const level = preferences.dashboards[project.configPath] ?? "all";
              return (
                <label className="props-field notification-settings__dashboard" key={project.configPath}>
                  <span title={project.configPath}>{label}</span>
                  <select
                    aria-label={`Notifications for ${label}`}
                    value={level}
                    disabled={disabled}
                    onChange={(event) => {
                      const next = event.target.value as DashboardNotificationLevel;
                      onUpdate(
                        withDashboardNotificationLevel(settings, project.configPath, next),
                        `${label} notifications: ${DASHBOARD_NOTIFICATION_LEVEL_LABELS[next]}.`,
                      );
                    }}
                  >
                    {(Object.keys(DASHBOARD_NOTIFICATION_LEVEL_LABELS) as DashboardNotificationLevel[]).map((value) => (
                      <option key={value} value={value}>{DASHBOARD_NOTIFICATION_LEVEL_LABELS[value]}</option>
                    ))}
                  </select>
                </label>
              );
            })}
          </div>
        ) : null}
      </div>
    </section>
  );
}
