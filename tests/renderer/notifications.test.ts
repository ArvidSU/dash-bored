import { describe, expect, test } from "bun:test";
import { buildApplicationActions, type ApplicationActionCallbacks } from "../../src/renderer/lib/action-providers";
import { rankActions } from "../../src/renderer/lib/actions";
import {
  applyNotificationCommand,
  boxOnScreen,
  buildNotifyActions,
  decidePresentation,
  notificationMarkLabel,
  notificationMarks,
  notificationPreferences,
  notificationSourceLabel,
  notificationTime,
  notificationTriggerLabel,
  notificationTriggerTitle,
  notifyArguments,
  pendingPresentations,
  withDashboardNotificationLevel,
  withNotificationSwitch,
  type PresentationContext,
} from "../../src/renderer/lib/notifications";
import { cloneDefaultAppSettings } from "../../src/shared/app-settings";
import type { ResolvedComponentNode } from "../../src/shared/contracts";
import { normalizeNotificationSettings, type NotificationEntry, type NotificationState } from "../../src/shared/notifications";

const DASHBOARD = "/work/app/.dash-bored/dash-bored.yaml";

function entry(id: string, patch: Partial<NotificationEntry> = {}): NotificationEntry {
  return {
    id,
    key: `key:${id}`,
    kind: "run-failed",
    level: "interrupt",
    configPath: DASHBOARD,
    dashboardName: "App",
    title: `${id} failed`,
    message: "Exited with code 1.",
    target: { kind: "node", nodeId: id },
    createdAt: "2026-10-19T10:00:00.000Z",
    updatedAt: "2026-10-19T10:00:00.000Z",
    count: 1,
    presentation: 0,
    read: false,
    ...patch,
  };
}

function inbox(entries: NotificationEntry[], history: NotificationState["history"] = []): NotificationState {
  return { entries, history };
}

function context(patch: Partial<PresentationContext> = {}): PresentationContext {
  return { visible: true, focused: true, targetVisible: () => false, ...patch };
}

describe("notification presentation", () => {
  test("presents the newest unhandled interrupt and leaves older ones in the inbox", () => {
    const state = inbox([
      entry("info", { level: "inform", presentation: 0 }),
      entry("older", { presentation: 2 }),
      entry("newest", { presentation: 5 }),
      entry("never", { presentation: 0 }),
      entry("read", { presentation: 7, read: true }),
    ]);
    // A read entry is not presented again, for example after the window reloads.
    expect(pendingPresentations(state.entries, new Map()).map(({ id }) => id)).toEqual(["newest", "older"]);
    const decision = decidePresentation(state, new Map(), context());
    expect(decision.present?.id).toBe("newest");
    expect(decision.seen).toEqual([]);
    expect([...decision.handled]).toEqual([["newest", 5], ["older", 2]]);

    // Handled presentations never return; a coalesced raise that bumps one does.
    expect(decidePresentation(state, decision.handled, context()).present).toBeNull();
    const raisedAgain = inbox(state.entries.map((item) => item.id === "older" ? { ...item, presentation: 6, count: 2 } : item));
    expect(decidePresentation(raisedAgain, decision.handled, context()).present?.id).toBe("older");
  });

  test("marks decisions about targets on screen as seen and presents the rest", () => {
    const state = inbox([entry("visible", { presentation: 3 }), entry("elsewhere", { presentation: 2 })]);
    const decision = decidePresentation(state, new Map(), context({ targetVisible: (item) => item.id === "visible" }));
    expect(decision.seen).toEqual(["visible"]);
    expect(decision.present?.id).toBe("elsewhere");
  });

  test("a system notification waits for focus; an in-app one does not", () => {
    const state = inbox([entry("native", { presentation: 4, deliveredNatively: true }), entry("in-app", { presentation: 3, deliveredNatively: false })]);
    const away = decidePresentation(state, new Map(), context({ focused: false }));
    expect(away.present?.id).toBe("in-app");
    expect(away.handled.has("native")).toBeFalse();

    const back = decidePresentation(state, away.handled, context({ focused: true }));
    expect(back.present?.id).toBe("native");
    expect(decidePresentation(state, new Map(), context({ visible: false })).present).toBeNull();
  });

  test("forgets closed entries", () => {
    const decision = decidePresentation(inbox([entry("open", { presentation: 1 })]), new Map([["closed", 9]]), context());
    expect([...decision.handled.keys()]).toEqual(["open"]);
  });
});

describe("local notification commands", () => {
  const now = new Date("2026-10-19T12:00:00.000Z");

  test("reading keeps entries open; dismissing moves them to the front of the history", () => {
    const state = inbox([entry("a"), entry("b"), entry("app", { configPath: null })], [
      { ...entry("old"), closedAt: "2026-10-19T11:00:00.000Z", closedBy: "cleared" },
    ]);
    const read = applyNotificationCommand(state, { type: "read", ids: ["a"] }, now);
    expect(read.entries.map(({ id, read: isRead }) => [id, isRead])).toEqual([["a", true], ["b", false], ["app", false]]);
    expect(read.history).toBe(state.history);
    expect(applyNotificationCommand(read, { type: "read", ids: ["a", "gone"] }, now)).toBe(read);

    const dismissed = applyNotificationCommand(read, { type: "dismiss", ids: ["a"] }, now);
    expect(dismissed.entries.map(({ id }) => id)).toEqual(["b", "app"]);
    expect(dismissed.history.map(({ id, closedBy, closedAt }) => [id, closedBy, closedAt]))
      .toEqual([["a", "dismissed", now.toISOString()], ["old", "cleared", "2026-10-19T11:00:00.000Z"]]);

    const appOnly = applyNotificationCommand(dismissed, { type: "dismiss-all", configPath: null }, now);
    expect(appOnly.entries.map(({ id }) => id)).toEqual(["b"]);
    const all = applyNotificationCommand(appOnly, { type: "dismiss-all" }, now);
    expect(all.entries).toEqual([]);
    expect(all.history.map(({ id }) => id)).toEqual(["b", "app", "a", "old"]);
    expect(applyNotificationCommand(all, { type: "clear-history" }, now)).toEqual(inbox([]));
  });
});

describe("notify actions", () => {
  test("require a bounded message and refuse anything else", () => {
    expect(notifyArguments({ message: "  Tests pass  " })).toEqual({ message: "Tests pass" });
    expect(notifyArguments({ message: "Review", item: "todo-1" })).toEqual({ message: "Review", item: "todo-1" });
    expect(() => notifyArguments(undefined)).toThrow("notify needs a message");
    expect(() => notifyArguments({ item: "todo-1" })).toThrow("notify needs a message");
    expect(() => notifyArguments({ message: " " })).toThrow("notify accepts only");
    expect(() => notifyArguments({ message: "x".repeat(201) })).toThrow("notify accepts only");
    expect(() => notifyArguments({ message: "Done", animation: "builtin:bounce" })).toThrow("notify accepts only");
    expect(() => notifyArguments({ message: "Done", item: 3 })).toThrow("notify accepts only");
  });

  test("address every node by stable ID and stay out of palette results", async () => {
    const child: ResolvedComponentNode = { id: "run-qa", component: "./components/external/core/process", props: {}, source: "external" };
    const tree: ResolvedComponentNode = {
      id: "root", component: "./components/external/core/group", props: {}, source: "external",
      children: { axis: "vertical", first: { node: child }, second: { node: { ...child, id: "logs" } } },
    };
    const calls: unknown[] = [];
    const actions = buildNotifyActions({ tree }, async (nodeId, request) => { calls.push([nodeId, request]); });
    expect(actions.map(({ id }) => id)).toEqual(["notify:root", "notify:run-qa", "notify:logs"]);
    expect(actions.every((action) => action.reference === action.id && action.enabled)).toBeTrue();
    expect(rankActions(actions, "notify")).toEqual([]);
    await actions[1]!.run({}, { message: "QA is green", item: "suite-1" });
    expect(calls).toEqual([["run-qa", { message: "QA is green", item: "suite-1" }]]);
    expect(() => actions[1]!.run({}, {})).toThrow("notify needs a message");
    expect(buildNotifyActions(null, async () => undefined)).toEqual([]);
  });
});

describe("notification labels", () => {
  test("marks count unread entries per dashboard and say which need the user", () => {
    const marks = notificationMarks(inbox([
      entry("a"), entry("b", { level: "inform" }), entry("c", { level: "inform" }), entry("read", { read: true }),
      entry("release", { configPath: null, dashboardName: null, target: { kind: "updates" } }),
    ]));
    expect(marks.get(DASHBOARD)).toEqual({ interrupt: 1, inform: 2 });
    expect(marks.get("")).toEqual({ interrupt: 1, inform: 0 });
    expect(notificationMarks(inbox([entry("read", { read: true })])).size).toBe(0);
    expect(notificationMarkLabel({ interrupt: 1, inform: 2 })).toBe("3 unread notifications, 1 needs you");
    expect(notificationMarkLabel({ interrupt: 2, inform: 0 })).toBe("2 unread notifications, 2 need you");
    expect(notificationMarkLabel({ interrupt: 0, inform: 1 })).toBe("1 unread notification");
  });

  test("the header trigger names unread entries first, then what is read and still open", () => {
    expect(notificationTriggerLabel(false, { interrupts: 2, unread: 3, open: 5 }))
      .toBe("Open notifications, 2 need you, 1 for information, 2 read and still open");
    expect(notificationTriggerLabel(true, { interrupts: 0, unread: 0, open: 0 })).toBe("Close notifications");
    expect(notificationTriggerTitle({ interrupts: 1, unread: 2, open: 2 })).toBe("1 notification needs you");
    expect(notificationTriggerTitle({ interrupts: 0, unread: 2, open: 3 })).toBe("2 unread notifications");
    expect(notificationTriggerTitle({ interrupts: 0, unread: 0, open: 1 })).toBe("1 open notification");
    expect(notificationTriggerTitle({ interrupts: 0, unread: 0, open: 0 })).toBe("Notifications");
  });

  test("name the source and a relative time", () => {
    expect(notificationSourceLabel({ configPath: null, dashboardName: null })).toBe("dash-bored");
    expect(notificationSourceLabel({ configPath: DASHBOARD, dashboardName: " Ops " })).toBe("Ops");
    expect(notificationSourceLabel({ configPath: DASHBOARD, dashboardName: null })).toBe("app");
    const now = new Date("2026-10-19T12:00:00.000Z");
    expect(notificationTime("2026-10-19T11:59:40.000Z", now)).toBe("now");
    expect(notificationTime("2026-10-19T11:55:00.000Z", now)).toBe("5 min ago");
    expect(notificationTime("2026-10-19T09:00:00.000Z", now)).toBe("3 h ago");
    expect(notificationTime("not a date", now)).toBe("");
  });

  test("on screen needs a meaningful visible part inside the page scroller", () => {
    const viewport = { top: 60, left: 0, bottom: 800, right: 1200 };
    expect(boxOnScreen({ top: 100, left: 10, bottom: 300, right: 400 }, viewport)).toBeTrue();
    expect(boxOnScreen({ top: 0, left: 10, bottom: 70, right: 400 }, viewport)).toBeFalse();
    expect(boxOnScreen({ top: 790, left: 10, bottom: 1200, right: 400 }, viewport)).toBeFalse();
    expect(boxOnScreen({ top: 100, left: 10, bottom: 110, right: 30 }, viewport)).toBeTrue();
    expect(boxOnScreen({ top: 100, left: 10, bottom: 100, right: 400 }, viewport)).toBeFalse();
  });
});

describe("notification settings", () => {
  test("switches and per-dashboard levels round-trip through main's normalization", () => {
    const base = cloneDefaultAppSettings();
    expect(notificationPreferences(base)).toEqual({ native: true, watches: true, dashboards: {} });

    const quiet = withNotificationSwitch(withNotificationSwitch(base, "native", false), "watches", false);
    expect(quiet.notifications).toEqual({ native: false, watches: false, dashboards: {} });

    const muted = withDashboardNotificationLevel(quiet, DASHBOARD, "off");
    const lowered = withDashboardNotificationLevel(muted, "/other/.dash-bored/dash-bored.yaml", "inform");
    expect(lowered.notifications?.dashboards).toEqual({ [DASHBOARD]: "off", "/other/.dash-bored/dash-bored.yaml": "inform" });
    expect(normalizeNotificationSettings(JSON.parse(JSON.stringify(lowered.notifications)))).toEqual(lowered.notifications!);

    // All is the default and is not stored.
    expect(withDashboardNotificationLevel(lowered, DASHBOARD, "all").notifications?.dashboards)
      .toEqual({ "/other/.dash-bored/dash-bored.yaml": "inform" });
    expect(lowered.theme).toBe(base.theme);
  });
});

describe("notification app actions", () => {
  const callbacks: ApplicationActionCallbacks = {
    reloadApp: () => undefined, focusWindow: () => undefined, showDashboard: () => undefined, showSettings: () => undefined,
    toggleSidebar: () => undefined, addDashboard: () => undefined, openProject: () => undefined, editDashboard: () => undefined,
    saveDashboard: () => undefined, cancelDashboard: () => undefined, reloadProject: () => undefined, trustProject: () => undefined,
    revokeTrust: () => undefined, runProcessQuickAction: () => undefined, stopProcess: () => undefined,
  };
  const build = (notificationCount: number, calls: string[]) => buildApplicationActions({
    snapshot: null, projects: [], activeView: "dashboard", sidebarExpanded: false, pendingAction: null, editing: false,
    draftDirty: false, draftValid: false, savingDraft: false, notificationCount,
    callbacks: { ...callbacks, toggleNotifications: () => { calls.push("show"); }, dismissNotifications: () => { calls.push("dismiss"); } },
  });

  test("show the inbox and dismiss every open decision", async () => {
    const calls: string[] = [];
    const empty = build(0, calls);
    expect(empty.find(({ id }) => id === "app:toggle-notifications")?.enabled).toBeTrue();
    expect(empty.find(({ id }) => id === "app:dismiss-notifications")).toMatchObject({ enabled: false, disabledReason: "There are no open notifications." });

    const open = build(2, calls);
    await open.find(({ id }) => id === "app:toggle-notifications")!.run();
    await open.find(({ id }) => id === "app:dismiss-notifications")!.run();
    expect(calls).toEqual(["show", "dismiss"]);
  });
});
