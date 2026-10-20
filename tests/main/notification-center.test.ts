import { describe, expect, test } from "bun:test";
import { NotificationCenter, PRESENTATION_COOLDOWN_MS, type NativeNotification, type NotificationRaise } from "../../src/main/notification-center";
import {
  AgentNotifications,
  PackageUpdateNotifications,
  ReleaseNotifications,
  RUN_FINISHED_MIN_MS,
  RunNotifications,
} from "../../src/main/notification-producers";
import type { AgentSessionTask } from "../../src/shared/agent-session";
import type { ProcessSnapshot, ResolvedComponentNode } from "../../src/shared/contracts";
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  NOTIFICATION_HISTORY_MAX,
  NOTIFICATION_INBOX_MAX_PER_DASHBOARD,
  type NotificationSettings,
  type NotificationState,
} from "../../src/shared/notifications";
import { INITIAL_PACKAGE_UPDATE_STATE, type PackageUpdateState } from "../../src/shared/package-updates";
import type { UpdateState } from "../../src/shared/updates";

function harness(options: { focused?: boolean; settings?: Partial<NotificationSettings> } = {}) {
  let clock = Date.parse("2026-10-19T10:00:00.000Z");
  let ids = 0;
  const published: NotificationState[] = [];
  const native: NativeNotification[] = [];
  const badges: number[] = [];
  const state = { focused: options.focused ?? true, settings: { ...DEFAULT_NOTIFICATION_SETTINGS, ...options.settings } };
  const center = new NotificationCenter({
    publish: (value) => published.push(value),
    showNative: (notification) => native.push(notification),
    setBadge: (count) => badges.push(count),
    isWindowFocused: () => state.focused,
    settings: () => state.settings,
    now: () => new Date(clock),
    newId: () => `n${++ids}`,
  });
  return {
    center,
    published,
    native,
    badges,
    state,
    advance(ms: number) { clock += ms; },
    entries: () => center.state().entries,
    history: () => center.state().history,
  };
}

const raise = (overrides: Partial<NotificationRaise> = {}): NotificationRaise => ({
  key: "watch:/p/dash-bored.yaml:ci",
  kind: "watch-state",
  level: "interrupt",
  configPath: "/p/dash-bored.yaml",
  dashboardName: "Project",
  title: "CI",
  message: "Error: main is red",
  target: { kind: "node", nodeId: "ci" },
  ...overrides,
});

describe("NotificationCenter", () => {
  test("an interrupt in the foreground is presented in the app, not as a system notification", () => {
    const { center, native, entries, badges } = harness({ focused: true });
    center.raise(raise());
    expect(native).toEqual([]);
    expect(entries()).toHaveLength(1);
    expect(entries()[0]!.presentation).toBe(1);
    expect(entries()[0]!.deliveredNatively).toBe(false);
    expect(badges.at(-1)).toBe(1);
  });

  test("an interrupt in the background becomes a system notification unless native delivery is off", () => {
    const background = harness({ focused: false });
    background.center.raise(raise());
    expect(background.native).toEqual([{ title: "CI", subtitle: "Project", body: "Error: main is red" }]);
    expect(background.entries()[0]!.deliveredNatively).toBe(true);

    const silent = harness({ focused: false, settings: { native: false } });
    silent.center.raise(raise());
    expect(silent.native).toEqual([]);
    expect(silent.entries()[0]!.presentation).toBe(1);
  });

  test("inform entries are recorded without presentation and do not count on the badge", () => {
    const { center, entries, badges, native } = harness({ focused: false });
    center.raise(raise({ level: "inform" }));
    expect(entries()[0]!.presentation).toBe(0);
    expect(native).toEqual([]);
    expect(badges.at(-1)).toBe(0);
  });

  test("per-dashboard levels downgrade interrupts or drop events entirely", () => {
    const informOnly = harness({ settings: { dashboards: { "/p/dash-bored.yaml": "inform" } } });
    informOnly.center.raise(raise());
    expect(informOnly.entries()[0]!.level).toBe("inform");
    expect(informOnly.entries()[0]!.presentation).toBe(0);

    const off = harness({ settings: { dashboards: { "/p/dash-bored.yaml": "off" } } });
    expect(off.center.raise(raise())).toBeNull();
    expect(off.entries()).toEqual([]);
  });

  test("raises with one key coalesce into one open decision and repeated presentation is rate limited", () => {
    const { center, entries, advance } = harness();
    center.raise(raise());
    const first = entries()[0]!;
    advance(1_000);
    center.raise(raise({ message: "Error: still red" }));
    expect(entries()).toHaveLength(1);
    expect(entries()[0]!.id).toBe(first.id);
    expect(entries()[0]!.count).toBe(2);
    expect(entries()[0]!.message).toBe("Error: still red");
    expect(entries()[0]!.presentation).toBe(first.presentation);
    advance(PRESENTATION_COOLDOWN_MS);
    center.raise(raise({ message: "Error: red again" }));
    expect(entries()[0]!.presentation).toBeGreaterThan(first.presentation);
  });

  test("notify presents at most once per dashboard within the cooldown", () => {
    const { center, entries } = harness();
    center.raise(raise({ key: "notify:/p/dash-bored.yaml:a:", kind: "notify" }));
    center.raise(raise({ key: "notify:/p/dash-bored.yaml:b:", kind: "notify" }));
    const [second, first] = entries();
    expect(first!.presentation).toBe(1);
    expect(second!.presentation).toBe(0);
  });

  test("acting marks an entry read and keeps it open; only news makes it unread again", () => {
    const { center, entries, history, badges, advance } = harness();
    const acted = center.raise(raise())!;
    expect(acted.read).toBeFalse();
    expect(badges.at(-1)).toBe(1);
    center.command({ type: "read", ids: [acted.id] });
    expect(entries()).toHaveLength(1);
    expect(entries()[0]).toMatchObject({ id: acted.id, read: true });
    expect(history()).toEqual([]);
    expect(badges.at(-1)).toBe(0);

    // A repeated observation keeps it read; a changed message or a new presentation does not.
    center.raise(raise());
    expect(entries()[0]!.read).toBeTrue();
    center.raise(raise({ message: "Error: worse" }));
    expect(entries()[0]!.read).toBeFalse();
    center.command({ type: "read", ids: [acted.id] });
    advance(PRESENTATION_COOLDOWN_MS);
    center.raise(raise({ message: "Error: worse" }));
    expect(entries()[0]).toMatchObject({ id: acted.id, read: false, count: 4 });
    expect(badges.at(-1)).toBe(1);
  });

  test("dismissed and cleared entries move to the history, which is bounded and can be cleared", () => {
    const { center, entries, history, advance } = harness();
    const dismissed = center.raise(raise({ key: "a" }))!;
    center.raise(raise({ key: "b" }));
    center.raise(raise({ key: "agent:t1:needs", configPath: "/q/dash-bored.yaml" }));
    center.raise(raise({ key: "agent:t1:outcome", configPath: "/q/dash-bored.yaml" }));
    center.command({ type: "dismiss", ids: [dismissed.id] });
    expect(entries().map((entry) => entry.key)).toEqual(["agent:t1:outcome", "agent:t1:needs", "b"]);
    advance(1_000);
    center.resolvePrefix("agent:t1:");
    expect(entries().map((entry) => entry.key)).toEqual(["b"]);
    expect(history().map(({ key, closedBy }) => [key, closedBy])).toEqual([
      ["agent:t1:outcome", "cleared"],
      ["agent:t1:needs", "cleared"],
      ["a", "dismissed"],
    ]);
    expect(history()[0]!.closedAt).toBe("2026-10-19T10:00:01.000Z");

    // The same key raises a new entry; its closed predecessor stays in the history.
    const again = center.raise(raise({ key: "a" }))!;
    expect(again.id).not.toBe(dismissed.id);
    expect(history().at(-1)!.id).toBe(dismissed.id);

    center.command({ type: "clear-history" });
    expect(history()).toEqual([]);
    for (let index = 0; index < NOTIFICATION_HISTORY_MAX + 5; index += 1) {
      center.raise(raise({ key: `h${index}` }));
      center.resolve(`h${index}`);
    }
    expect(history()).toHaveLength(NOTIFICATION_HISTORY_MAX);
    expect(history()[0]!.key).toBe(`h${NOTIFICATION_HISTORY_MAX + 4}`);
  });

  test("a dashboard that leaves the registry takes its open and closed entries along", () => {
    const { center, entries, history, badges } = harness();
    center.raise(raise({ key: "a" }));
    center.raise(raise({ key: "b" }));
    center.raise(raise({ key: "q", configPath: "/q/dash-bored.yaml" }));
    center.raise(raise({ key: "app-release", configPath: null }));
    center.resolve("a");
    center.retainDashboards(new Set(["/q/dash-bored.yaml"]));
    expect(entries().map((entry) => entry.key)).toEqual(["app-release", "q"]);
    expect(history()).toEqual([]);
    center.command({ type: "dismiss-all" });
    expect(badges.at(-1)).toBe(0);
  });

  test("dismiss-all can target one dashboard or app-level entries", () => {
    const { center, entries, history } = harness();
    center.raise(raise({ key: "a" }));
    center.raise(raise({ key: "app-release", configPath: null }));
    center.command({ type: "dismiss-all", configPath: null });
    expect(entries().map((entry) => entry.key)).toEqual(["a"]);
    center.command({ type: "dismiss-all" });
    expect(entries()).toEqual([]);
    expect(history().map(({ key, closedBy }) => [key, closedBy])).toEqual([["a", "dismissed"], ["app-release", "dismissed"]]);
  });

  test("each dashboard keeps a bounded inbox, dropping the oldest informs first, then read interrupts", () => {
    const { center, entries } = harness();
    center.raise(raise({ key: "old-interrupt" }));
    const read = center.raise(raise({ key: "read-interrupt" }))!;
    center.command({ type: "read", ids: [read.id] });
    center.raise(raise({ key: "old-inform", level: "inform" }));
    for (let index = 0; index < NOTIFICATION_INBOX_MAX_PER_DASHBOARD - 2; index += 1) {
      center.raise(raise({ key: `k${index}` }));
    }
    const keys = entries().map((entry) => entry.key);
    expect(keys).toHaveLength(NOTIFICATION_INBOX_MAX_PER_DASHBOARD);
    expect(keys).toContain("old-interrupt");
    expect(keys).not.toContain("old-inform");
    center.raise(raise({ key: "one-more" }));
    expect(entries().map((entry) => entry.key)).not.toContain("read-interrupt");
    expect(entries().map((entry) => entry.key)).toContain("old-interrupt");
  });

  test("text is bounded and whitespace collapsed", () => {
    const { center, entries } = harness();
    center.raise(raise({ title: "  CI \n status ", message: "x".repeat(400) }));
    expect(entries()[0]!.title).toBe("CI status");
    expect(entries()[0]!.message).toHaveLength(200);
    expect(entries()[0]!.message.endsWith("…")).toBe(true);
  });
});

const tree: ResolvedComponentNode = {
  id: "root",
  component: "./components/external/core/group",
  props: {},
  source: "external",
  children: [{ node: { id: "run-qa", component: "./components/external/core/command", props: { title: "QA" }, source: "external" } }],
};

function process(run: Partial<NonNullable<ProcessSnapshot["run"]>> & Pick<NonNullable<ProcessSnapshot["run"]>, "phase">): ProcessSnapshot {
  return {
    id: "run-qa",
    phase: run.phase === "running" || run.phase === "stopping" ? run.phase : "exited",
    pid: null,
    exitCode: null,
    signal: null,
    logs: [],
    run: { exitCode: null, signal: null, startedAt: "2026-10-19T10:00:00.000Z", ...run },
  };
}

describe("RunNotifications", () => {
  const active = () => ({ configPath: "/p/dash-bored.yaml", dashboardName: "Project", tree });

  test("a failed run raises a decision with Fix with agent, and the next run supersedes it", () => {
    const { center, entries } = harness();
    const runs = new RunNotifications(center, active);
    runs.observe(process({ phase: "running" }));
    runs.observe(process({ phase: "exited", exitCode: 2, durationMs: 3_000 }));
    expect(entries()).toHaveLength(1);
    expect(entries()[0]).toMatchObject({
      kind: "run-failed",
      title: "QA failed",
      message: "Exit 2 after 3s.",
      target: { kind: "node", nodeId: "run-qa" },
      action: { label: "Fix with agent", invocation: { run: "agent:prompt" } },
    });
    runs.observe(process({ phase: "running", startedAt: "2026-10-19T10:05:00.000Z" }));
    expect(entries()).toEqual([]);
  });

  test("short successes, stopped runs, interrupts, and agent-started runs stay quiet", () => {
    const { center, entries } = harness();
    const runs = new RunNotifications(center, active);
    runs.observe(process({ phase: "running" }));
    runs.observe(process({ phase: "exited", exitCode: 0, durationMs: RUN_FINISHED_MIN_MS - 1 }));

    runs.observe(process({ phase: "running", startedAt: "b" }));
    runs.observe(process({ phase: "stopping", startedAt: "b" }));
    runs.observe(process({ phase: "exited", exitCode: 1, startedAt: "b", durationMs: 60_000 }));

    runs.observe(process({ phase: "running", startedAt: "c" }));
    runs.observe(process({ phase: "exited", exitCode: 130, startedAt: "c", durationMs: 60_000 }));

    runs.noteStart("run-qa", true);
    runs.observe(process({ phase: "running", startedAt: "d" }));
    runs.observe(process({ phase: "exited", exitCode: 1, startedAt: "d", durationMs: 60_000 }));
    expect(entries()).toEqual([]);
  });

  test("a long successful run raises a finished decision once", () => {
    const { center, entries } = harness();
    const runs = new RunNotifications(center, active);
    runs.noteStart("run-qa", false);
    runs.observe(process({ phase: "running" }));
    const finished = process({ phase: "exited", exitCode: 0, durationMs: 125_000 });
    runs.observe(finished);
    runs.observe(finished);
    expect(entries()).toHaveLength(1);
    expect(entries()[0]).toMatchObject({ kind: "run-finished", title: "QA finished", message: "Finished after 2m 5s." });
    expect(entries()[0]!.action).toBeUndefined();
  });
});

function task(overrides: Partial<AgentSessionTask>): AgentSessionTask {
  return {
    id: "t1",
    agent: { command: "claude-code-acp", name: "Claude" },
    prompt: "",
    componentPath: "dash-bored.yaml#root",
    request: "Fix the failing QA run. Then report.",
    configPath: "/p/dash-bored.yaml",
    startedAt: "2026-10-19T10:00:00.000Z",
    state: "starting",
    sessionId: null,
    pid: null,
    entries: [],
    truncated: 0,
    plan: null,
    permission: null,
    configOptions: [],
    turns: 0,
    handoff: null,
    dashboardChanged: false,
    log: [],
    ...overrides,
  };
}

describe("AgentNotifications", () => {
  test("a permission request interrupts and clears once answered; the finished turn follows", () => {
    const { center, entries } = harness();
    const agents = new AgentNotifications(center, () => "Project");
    agents.observe(task({ state: "working" }));
    agents.observe(task({
      state: "waiting",
      permission: { id: "p", toolCallId: "c", title: "Run bun test", locations: [], options: [] },
    }));
    expect(entries()).toHaveLength(1);
    expect(entries()[0]).toMatchObject({
      kind: "agent-needs-you",
      title: "Claude needs permission",
      message: "Run bun test",
      dashboardName: "Project",
      target: { kind: "agent-session", taskId: "t1" },
    });
    agents.observe(task({ state: "working" }));
    expect(entries()).toEqual([]);
    agents.observe(task({ state: "idle", turns: 1 }));
    expect(entries()[0]).toMatchObject({ kind: "agent-finished", title: "Claude finished", message: "Fix the failing QA run." });
    agents.observe(task({ state: "working", turns: 1 }));
    expect(entries()).toEqual([]);
  });

  test("the finished decision waits for validation and reports its failure", () => {
    const { center, entries } = harness();
    const agents = new AgentNotifications(center, () => null);
    agents.observe(task({ state: "working" }));
    agents.observe(task({ state: "idle", validation: { status: "checking", diagnostics: [] } }));
    expect(entries()).toEqual([]);
    agents.observe(task({ state: "idle", validation: { status: "failed", diagnostics: [], message: "2 errors remain" } }));
    expect(entries()[0]).toMatchObject({ kind: "agent-failed", message: "2 errors remain" });
  });

  test("cancelled work stays quiet and closing the session closes its decisions", () => {
    const { center, entries } = harness();
    const agents = new AgentNotifications(center, () => null);
    agents.observe(task({ state: "working" }));
    agents.observe(task({ state: "idle", cancelled: true }));
    expect(entries()).toEqual([]);
    agents.observe(task({ state: "working" }));
    agents.observe(task({ state: "failed", error: "Agent exited" }));
    expect(entries()[0]).toMatchObject({ kind: "agent-failed", message: "Agent exited" });
    agents.observe(task({ state: "closed" }));
    expect(entries()).toEqual([]);
  });
});

describe("update notifications", () => {
  const packages = (overrides: Partial<PackageUpdateState>): PackageUpdateState => ({ ...INITIAL_PACKAGE_UPDATE_STATE, ...overrides });
  const item = (name: string) => ({
    id: `component:/p:${name}`,
    kind: "component" as const,
    name,
    url: `https://example.test/${name}`,
    configPath: "/p/dash-bored.yaml",
    dashboardName: "Project",
    current: { commit: "a".repeat(40) },
    latest: { commit: "b".repeat(40) },
    status: "available" as const,
  });

  test("updatable packages inform once per finished check and clear when none remain", () => {
    const { center, entries } = harness();
    const producer = new PackageUpdateNotifications(center);
    producer.observe(packages({ phase: "checking" }));
    producer.observe(packages({ checkedAt: "1", packages: [item("core"), item("extra")] }));
    expect(entries()[0]).toMatchObject({ kind: "package-updates", level: "inform", title: "2 package updates are available", message: "core, extra", target: { kind: "updates" } });
    producer.observe(packages({ checkedAt: "2", packages: [] }));
    expect(entries()).toEqual([]);
  });

  test("a new release interrupts once per version and closes when installed", async () => {
    const { center, entries } = harness();
    let notified: string | null = null;
    const producer = new ReleaseNotifications(center, {
      notified: async () => notified,
      remember: async (version) => { notified = version; },
    });
    const state = (current: string, version: string | null) => ({
      currentVersion: current,
      release: version ? { metadata: { version } } : null,
    }) as unknown as UpdateState;
    await producer.observe(state("0.5.3", "0.5.4"));
    expect(entries()[0]).toMatchObject({ kind: "app-release", title: "dash-bored 0.5.4 is available" });
    expect(entries()[0]!.presentation).toBe(1);
    center.command({ type: "dismiss-all" });
    await producer.observe(state("0.5.3", "0.5.4"));
    expect(entries()[0]!.presentation).toBe(0);
    await producer.observe(state("0.5.4", "0.5.4"));
    expect(entries()).toEqual([]);
  });
});
