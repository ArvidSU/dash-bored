import { afterEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { loadProjectDefinition, type ProjectDefinition } from "../../src/core/project";
import { createProject, removeTemporaryDirectory, temporaryDirectory, waitFor } from "../core/helpers";
import type { NotificationRaise } from "../../src/main/notification-center";
import {
  WATCH_FIRST_OBSERVATION_MS,
  WATCH_PLAN_DEBOUNCE_MS,
  WATCH_PLAN_INTERVAL_MS,
  WatchRunner,
  type WatchScheduler,
} from "../../src/main/watches";
import type { ComponentNode, NodeWatch, ResolvedComponentNode } from "../../src/shared/contracts";
import { DEFAULT_NOTIFICATION_SETTINGS, type NotificationSettings } from "../../src/shared/notifications";
import { WATCH_LIMIT_APP, type WatchSource } from "../../src/shared/watches";

class FakeScheduler implements WatchScheduler {
  now = 0;
  private nextId = 1;
  readonly timers = new Map<number, { at: number; callback: () => void }>();

  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { at: this.now + ms, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  /** Run every timer due within `ms`, in order, letting each callback's async work settle. */
  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.now = due[1].at;
      due[1].callback();
      await settle();
    }
    this.now = target;
    await settle();
  }
}

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

class FakeCenter {
  readonly raised: NotificationRaise[] = [];
  readonly resolved: string[] = [];
  readonly prefixes: string[] = [];
  raise(input: NotificationRaise) {
    this.raised.push(input);
    return null;
  }
  resolve(keys: string | readonly string[]) {
    this.resolved.push(...(typeof keys === "string" ? [keys] : keys));
  }
  resolvePrefix(prefix: string) {
    this.prefixes.push(prefix);
  }
}

const configA = "/work/a/.dash-bored/dash-bored.yaml";
const configB = "/work/b/.dash-bored/dash-bored.yaml";

function node(id: string, watch: NodeWatch | undefined, source: Record<string, unknown> = { shell: `check-${id}` }, sourceConfigPath?: string): ResolvedComponentNode {
  return {
    id,
    component: "./components/external/core/status",
    manifest: { schemaVersion: 3, apiVersion: "2.0.0", id: "status", name: "Status", description: "Status", entry: "./index.tsx", propsSchema: {}, resources: { observation: { sourceProp: "source", kind: "status" } } },
    props: { label: id.toUpperCase(), source },
    ...(watch ? { watch } : {}),
    source: "external",
    ...(sourceConfigPath ? { sourceConfigPath } : {}),
  };
}

function definition(configPath: string, nodes: ResolvedComponentNode[], options: { ok?: boolean; root?: ComponentNode } = {}): ProjectDefinition {
  const ok = options.ok ?? true;
  const configDirectory = dirname(configPath);
  return {
    ok,
    tree: ok ? {
      id: "root",
      component: "./components/external/core/group",
      props: {},
      source: "external",
      sourceConfigPath: configPath,
      children: nodes.map((child) => ({ node: { sourceConfigPath: configPath, ...child } })),
    } : null,
    config: ok ? { schemaVersion: 4, name: `Dashboard ${configPath.split("/")[2]}`, root: { component: "group" } } : null,
    location: {
      projectRoot: dirname(configDirectory),
      configDirectory,
      configPath,
      lockPath: join(configDirectory, "dash-bored-lock.yaml"),
      componentsDirectory: join(configDirectory, "components"),
    },
    permissionsByNode: new Map(),
    projectRootsByNode: new Map(),
    permissions: ["background:watch", "process:execute"],
    diagnostics: [],
    trustReview: { available: true, hasLocalCode: false },
    configRevision: "r1",
    themeCatalog: [],
    animationCatalog: [],
    componentCatalog: [],
    lock: null,
    manifests: [],
    localComponents: [],
    compiledComponents: [],
  };
}

interface HarnessOptions {
  definitions: Record<string, ProjectDefinition>;
  trusted?: Set<string>;
  settings?: Partial<NotificationSettings>;
  active?: { configPath: string | null };
  declaredRoots?: Record<string, ComponentNode>;
}

function harness(options: HarnessOptions) {
  const scheduler = new FakeScheduler();
  const center = new FakeCenter();
  const state = {
    definitions: options.definitions,
    trusted: options.trusted ?? new Set(Object.keys(options.definitions)),
    settings: { ...DEFAULT_NOTIFICATION_SETTINGS, ...options.settings } as NotificationSettings,
    active: options.active ?? { configPath: null },
    values: new Map<string, () => unknown>(),
    reads: [] as Array<{ nodeId: string; at: number; source: WatchSource }>,
    pending: new Map<string, (value: unknown) => void>(),
  };
  const runner = new WatchRunner({
    center,
    dashboards: async () => Object.keys(state.definitions).map((configPath) => ({ configPath, dashboardName: null })),
    active: () => state.active,
    loadDefinition: async (configPath) => {
      const found = state.definitions[configPath];
      if (!found) throw new Error(`No definition for ${configPath}`);
      return found;
    },
    isTrusted: async (candidate) => state.trusted.has(candidate.location.configPath),
    settings: () => state.settings,
    getPublishedEnvironment: () => ({}),
    readDeclaredRoot: async (configPath) => options.declaredRoots?.[configPath] ?? null,
    readSource: async (_capabilities, nodeId, source) => {
      state.reads.push({ nodeId, at: scheduler.now, source });
      const value = state.values.get(nodeId);
      if (value) return value();
      return new Promise((resolve) => state.pending.set(nodeId, resolve));
    },
    scheduler,
    log: () => undefined,
  });
  return { runner, scheduler, center, state };
}

const healthy = () => ({ state: "healthy" });
const red = () => ({ state: "error", detail: "main is red" });

describe("WatchRunner planning", () => {
  test("runs only trusted, valid dashboards and pauses the rest with one reason each", async () => {
    const configC = "/work/c/.dash-bored/dash-bored.yaml";
    const { runner, center, state } = harness({
      definitions: {
        [configA]: definition(configA, [node("ci", { on: ["error"] }), node("plain", undefined)]),
        [configB]: definition(configB, [node("deploy", { on: ["error"] }), node("smoke", { on: ["warning"] })]),
        [configC]: definition(configC, [], { ok: false }),
      },
      trusted: new Set([configA]),
      declaredRoots: { [configC]: { component: "group", children: [{ node: { component: "status", watch: { on: ["error"] } } }] } },
    });
    runner.start();
    await runner.refresh();
    expect(runner.runningWatches().map((watch) => [watch.configPath, watch.nodeId, watch.every])).toEqual([[configA, "ci", 300_000]]);
    expect(center.raised).toEqual([
      expect.objectContaining({
        key: `watch-paused:${configB}`,
        kind: "watch-paused",
        level: "inform",
        title: "Watches paused",
        message: "2 watches paused: review and trust this dashboard to run them.",
        target: { kind: "dashboard" },
        dashboardName: "Dashboard b",
      }),
      expect.objectContaining({
        key: `watch-paused:${configC}`,
        message: "1 watch paused: fix this dashboard's configuration errors to run it.",
      }),
    ]);

    // Planning again with the same reasons raises nothing new.
    await runner.refresh();
    expect(center.raised).toHaveLength(2);

    state.trusted.add(configB);
    await runner.refresh();
    expect(center.resolved).toContain(`watch-paused:${configB}`);
    expect(runner.runningWatches().map((watch) => watch.nodeId)).toEqual(["ci", "deploy", "smoke"]);
    runner.stop();
  });

  test("runs only watches the bundle owns", async () => {
    const linkedConfig = "/work/a/.dash-bored/arvid/dash-bored.yaml";
    const { runner } = harness({
      definitions: {
        [configA]: definition(configA, [node("own", { on: ["error"] }), node("personal::linked", { on: ["error"] }, undefined, linkedConfig)]),
      },
    });
    runner.start();
    await runner.refresh();
    expect(runner.runningWatches().map((watch) => watch.nodeId)).toEqual(["own"]);
    runner.stop();
  });

  test("caps watches app-wide and says which dashboard paused", async () => {
    const many = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => node(`${prefix}${index}`, { on: ["error"] }));
    const configs = Array.from({ length: 5 }, (_, index) => `/work/p${index}/.dash-bored/dash-bored.yaml`);
    const { runner, center } = harness({
      definitions: Object.fromEntries(configs.map((configPath, index) => [configPath, definition(configPath, many(`p${index}-`, 9))])),
    });
    runner.start();
    await runner.refresh();
    expect(runner.runningWatches()).toHaveLength(WATCH_LIMIT_APP);
    expect(center.raised).toEqual([expect.objectContaining({
      key: `watch-paused:${configs[4]}`,
      message: `5 of 9 watches paused: dash-bored runs at most ${WATCH_LIMIT_APP} watches at once.`,
    })]);
    runner.stop();
  });

  test("the watches setting stops everything; a muted dashboard does not run", async () => {
    const { runner, scheduler, state } = harness({
      definitions: {
        [configA]: definition(configA, [node("ci", { on: ["error"] })]),
        [configB]: definition(configB, [node("deploy", { on: ["error"] })]),
      },
      settings: { dashboards: { [configB]: "off" } },
    });
    state.values.set("ci", healthy);
    runner.start();
    await runner.refresh();
    expect(runner.runningWatches().map((watch) => watch.nodeId)).toEqual(["ci"]);

    state.settings = { ...state.settings, watches: false };
    runner.requestRefresh();
    await scheduler.advance(WATCH_PLAN_DEBOUNCE_MS);
    expect(runner.runningWatches()).toEqual([]);
    const reads = state.reads.length;
    await scheduler.advance(WATCH_PLAN_INTERVAL_MS - 1);
    expect(state.reads.length).toBe(reads);
    runner.stop();
  });

  test("a removed watch resolves its open decisions; an unchanged one keeps its baseline", async () => {
    const { runner, scheduler, center, state } = harness({
      definitions: { [configA]: definition(configA, [node("ci", { on: ["error"] }), node("deploy", { on: ["error"] })]) },
    });
    state.values.set("ci", red);
    state.values.set("deploy", healthy);
    runner.start();
    await runner.refresh();
    await scheduler.advance(WATCH_FIRST_OBSERVATION_MS + 5_000);
    expect(center.raised.filter((raise) => raise.kind === "watch-state").map((raise) => [raise.key, raise.quiet])).toEqual([
      [`watch:${configA}:ci`, true],
    ]);

    state.definitions[configA] = definition(configA, [node("ci", { on: ["error"] })]);
    await runner.refresh();
    expect(center.resolved).toEqual(expect.arrayContaining([`watch:${configA}:deploy`, `watch-error:${configA}:deploy`]));
    expect(center.prefixes).toEqual([`watch:${configA}:deploy:item:`]);
    // The unchanged watch is not re-baselined, so a later recovery still resolves.
    state.values.set("ci", healthy);
    await scheduler.advance(300_000);
    expect(center.resolved.filter((key) => key === `watch:${configA}:ci`)).toHaveLength(1);
    runner.stop();
  });
});

describe("WatchRunner scheduling", () => {
  test("observes after a short stagger, then every interval, one read in flight", async () => {
    const { runner, scheduler, state, center } = harness({
      definitions: { [configA]: definition(configA, [node("ci", { on: ["error"], every: 60_000 }), node("deploy", { on: ["error"], every: 120_000 })]) },
    });
    state.values.set("deploy", healthy);
    runner.start();
    await runner.refresh();
    await scheduler.advance(WATCH_FIRST_OBSERVATION_MS - 1);
    expect(state.reads).toEqual([]);
    await scheduler.advance(10_000);
    expect(state.reads.map((read) => [read.nodeId, read.at])).toEqual([["ci", 3_000], ["deploy", 4_500]]);
    expect(state.reads[0]!.source).toEqual({ kind: "shell", value: "check-ci" });

    // ci's read hangs: no overlapping read, and no chain until it completes.
    await scheduler.advance(240_000);
    expect(state.reads.filter((read) => read.nodeId === "ci")).toHaveLength(1);
    expect(state.reads.filter((read) => read.nodeId === "deploy").map((read) => read.at)).toEqual([4_500, 124_500, 244_500]);

    state.pending.get("ci")!({ state: "error", detail: "late" });
    await scheduler.advance(0);
    expect(center.raised).toEqual([expect.objectContaining({ key: `watch:${configA}:ci`, quiet: true })]);
    await scheduler.advance(60_000);
    expect(state.reads.filter((read) => read.nodeId === "ci")).toHaveLength(2);
    runner.stop();
  });

  test("a failing read informs once and stop discards late results", async () => {
    const { runner, scheduler, state, center } = harness({
      definitions: { [configA]: definition(configA, [node("ci", { on: ["error"], every: 60_000 })]) },
    });
    state.values.set("ci", () => { throw new Error("Command failed (exit 2)."); });
    runner.start();
    await runner.refresh();
    await scheduler.advance(WATCH_FIRST_OBSERVATION_MS + 120_000);
    expect(center.raised).toEqual([expect.objectContaining({ key: `watch-error:${configA}:ci`, message: "Watch failed: Command failed (exit 2)." })]);

    state.values.delete("ci");
    await scheduler.advance(60_000);
    runner.stop();
    state.pending.get("ci")!({ state: "error" });
    await scheduler.advance(0);
    expect(center.raised).toHaveLength(1);
    expect(scheduler.timers.size).toBe(0);
  });

  test("never reads for a dashboard that lost trust or left the registry since the plan", async () => {
    const { runner, scheduler, state, center } = harness({
      definitions: {
        [configA]: definition(configA, [node("ci", { on: ["error"], every: 60_000 })]),
        [configB]: definition(configB, [node("deploy", { on: ["error"], every: 60_000 })]),
      },
    });
    state.values.set("ci", healthy);
    state.values.set("deploy", healthy);
    runner.start();
    await runner.refresh();
    await scheduler.advance(10_000);
    expect(state.reads.map((read) => read.nodeId)).toEqual(["ci", "deploy"]);

    state.trusted.delete(configA);
    delete state.definitions[configB];
    await scheduler.advance(60_000);
    // Both reads were refused before running anything; the follow-up plan pauses A and drops B.
    expect(state.reads.map((read) => read.nodeId)).toEqual(["ci", "deploy"]);
    await scheduler.advance(WATCH_PLAN_DEBOUNCE_MS);
    expect(runner.runningWatches()).toEqual([]);
    expect(center.raised).toEqual([expect.objectContaining({ key: `watch-paused:${configA}`, message: expect.stringContaining("review and trust") })]);
    expect(center.prefixes).toEqual([`watch:${configB}:deploy:item:`]);
    await scheduler.advance(300_000);
    expect(state.reads).toHaveLength(2);
    runner.stop();
  });

  test("snapshot changes of the active dashboard plan again, debounced", async () => {
    const { runner, scheduler, state } = harness({ definitions: { [configA]: definition(configA, []) } });
    runner.observeSnapshot({ configPath: configA, configRevision: "r1", trusted: true });
    runner.start();
    await scheduler.advance(10_000);
    expect(runner.runningWatches()).toEqual([]);

    state.definitions[configA] = definition(configA, [node("ci", { on: ["error"] })]);
    runner.observeSnapshot({ configPath: configA, configRevision: "r1", trusted: true });
    await scheduler.advance(WATCH_PLAN_DEBOUNCE_MS);
    expect(runner.runningWatches()).toEqual([]);
    runner.observeSnapshot({ configPath: configA, configRevision: "r2", trusted: true });
    runner.observeSnapshot({ configPath: configA, configRevision: "r2", trusted: false });
    await scheduler.advance(WATCH_PLAN_DEBOUNCE_MS);
    expect(runner.runningWatches().map((watch) => watch.nodeId)).toEqual(["ci"]);
    runner.stop();
  });
});

describe("WatchRunner with a real dashboard", () => {
  const cleanup: string[] = [];
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map(removeTemporaryDirectory));
  });

  test("reads shell and file sources through the node's own capabilities", async () => {
    const root = await temporaryDirectory();
    cleanup.push(root);
    await createProject(root, {
      schemaVersion: 4,
      name: "Real",
      root: {
        id: "root",
        component: "./components/external/core/tabs",
        children: [
          { metadata: { label: "CI" }, node: {
            id: "ci",
            component: "./components/external/core/status",
            props: { label: "CI", source: { shell: "printf '%s' \"$WATCH_DETAIL\" | sed 's/.*/{\"state\":\"error\",\"detail\":\"&\"}/'", env: { WATCH_DETAIL: "main is red" } } },
            watch: { on: ["error"] },
          } },
          { metadata: { label: "Backlog" }, node: {
            id: "backlog",
            component: "./components/external/core/list",
            props: { title: "Backlog", source: { file: "backlog.json" } },
            watch: { on: ["added"], action: { name: "Ask", run: "agent:prompt", with: { prompt: "${item.title}" } } },
          } },
          { metadata: { label: "Broken" }, node: {
            id: "broken",
            component: "./components/external/core/status",
            props: { label: "Broken", source: { shell: "echo nope >&2; exit 3" } },
            watch: { on: ["error"] },
          } },
        ],
      },
    });
    await writeFile(join(root, "backlog.json"), JSON.stringify([{ id: "a", title: "First" }]));
    const definition = await loadProjectDefinition(root);
    expect(definition.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    const configPath = definition.location.configPath;
    const scheduler = new FakeScheduler();
    const center = new FakeCenter();
    const runner = new WatchRunner({
      center,
      dashboards: async () => [{ configPath, dashboardName: "Real" }],
      active: () => ({ configPath: null }),
      loadDefinition: () => loadProjectDefinition(configPath),
      isTrusted: async () => true,
      settings: () => DEFAULT_NOTIFICATION_SETTINGS,
      getPublishedEnvironment: () => ({}),
      scheduler,
    });
    runner.start();
    await runner.refresh();
    // Fake time starts the reads; real commands finish on real time.
    await scheduler.advance(10_000);
    // Every watch has finished its first read once each chained its next one (plus the plan timer).
    await waitFor(() => center.raised.length >= 2 && scheduler.timers.size === 4, 10_000);
    expect(center.raised).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: `watch:${configPath}:ci`, message: "Error: main is red", quiet: true, dashboardName: "Real" }),
      expect.objectContaining({ key: `watch-error:${configPath}:broken`, message: "Watch failed: Command failed (exit 3): nope" }),
    ]));

    await writeFile(join(root, "backlog.json"), JSON.stringify([{ id: "a", title: "First" }, { id: "b", title: "Second" }]));
    await scheduler.advance(300_000);
    await waitFor(() => center.raised.some((raise) => raise.kind === "watch-item"), 10_000);
    expect(center.raised).toEqual(expect.arrayContaining([expect.objectContaining({
      key: `watch:${configPath}:backlog:item:b`,
      message: "Second",
      target: { kind: "node", nodeId: "backlog", itemId: "b" },
      action: { label: "Ask", invocation: { run: "agent:prompt", with: { prompt: "Second" } } },
    })]));
    runner.stop();
  }, 30_000);
});
