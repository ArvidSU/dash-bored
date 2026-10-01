import { describe, expect, test } from "bun:test";
import {
  ActionStore,
  matchActionChoiceSelections,
  rankActions,
  resolveActionChoiceOptions,
} from "../../src/renderer/lib/actions";
import type {
  ComponentActionOwner,
  PaletteAction,
} from "../../src/renderer/lib/actions";
import {
  buildApplicationActions,
  buildDeclaredComponentActions,
  buildProcessActions,
  buildNodeFocusActions,
} from "../../src/renderer/lib/action-providers";
import type {
  ProjectSnapshot,
  ResolvedComponentNode,
} from "../../src/shared/contracts";
import { projectThemeReference } from "../../src/shared/themes";

const owner: ComponentActionOwner = {
  scope: "/project\u00001\u0000trusted",
  nodeId: "health",
  componentName: "Service health",
};

function action(
  id: string,
  overrides: Partial<PaletteAction> = {},
): PaletteAction {
  return {
    id,
    label: id,
    keywords: [],
    group: "Application",
    enabled: true,
    run: () => undefined,
    ...overrides,
  };
}

function commandTree(): ResolvedComponentNode {
  return {
    id: "root",
    component: "@dash-bored/group",
    props: {},
    children: { node: {
            id: "server",
            component: "@dash-bored/command",
            props: { label: "Development server", command: "bun run dev" },
            source: "builtin",
            manifest: {
                schemaVersion: 2,
                id: "@dash-bored/command",
                name: "Command",
                description: "Runs a supervised command.",
                entry: "builtin:command",
                propsSchema: { type: "object" },
                resources: { process: { commandProp: "command" } },
                permissions: ["process:execute"]
            }
        } },
    source: "builtin",
  };
}

function snapshot(overrides: Partial<ProjectSnapshot> = {}): ProjectSnapshot {
  return {
    projectRoot: "/workspace/example",
    dashboardName: "Example",
    iconDataUrl: null,
    config: null,
    configRevision: null,
    componentCatalog: [],
    trusted: false,
    requestedPermissions: ["process:execute"],
    tree: commandTree(),
    components: [],
    processes: [
      {
        id: "server",
        phase: "idle",
        pid: null,
        exitCode: null,
        signal: null,
        logs: [],
      },
    ],
    diagnostics: [],
    revision: 1,
    ...overrides,
  };
}

describe("ActionStore component registrations", () => {
  test("rejects undeclared registrations only for manifests that opt in", () => {
    const store = new ActionStore();
    store.register({ ...owner, componentName: "package-scripts" }, {
      id: "test",
      label: "Run tests",
      run: () => undefined,
    });
    store.register({
      ...owner,
      nodeId: "strict",
      declaredActionIds: ["refresh"],
    }, {
      id: "other",
      label: "Undeclared",
      run: () => undefined,
    });

    expect(store.getSnapshot().componentActions).toHaveLength(1);
    expect(store.getDiagnostics()).toEqual([expect.objectContaining({
      code: "COMPONENT_ACTION_UNDECLARED",
      path: "strict",
    })]);
  });

  test("namespaces registrations and disposes them by token, owner, and scope", () => {
    const store = new ActionStore();
    const disposeFirst = store.register(owner, {
      id: "refresh",
      label: "Refresh service health",
      keywords: ["status"],
      run: () => undefined,
    });
    expect(store.getSnapshot().componentActions).toHaveLength(1);
    expect(store.getSnapshot().componentActions[0]).toMatchObject({
      label: "Refresh service health",
      group: "Component · Service health",
      source: "health",
      reference: "component:health:refresh",
    });

    expect(() =>
      store.register(owner, {
        id: "refresh",
        label: "Duplicate",
        run: () => undefined,
      }),
    ).toThrow("duplicate action id");

    store.clearOwner(owner);
    const disposeReplacement = store.register(owner, {
      id: "refresh",
      label: "Replacement",
      run: () => undefined,
    });
    disposeFirst();
    expect(store.getSnapshot().componentActions.map((item) => item.label)).toEqual([
      "Replacement",
    ]);

    store.register(
      { ...owner, nodeId: "secondary" },
      { id: "refresh", label: "Other instance", run: () => undefined },
    );
    expect(store.getSnapshot().componentActions).toHaveLength(2);
    store.clearScope(owner.scope);
    expect(store.getSnapshot().componentActions).toEqual([]);
    disposeReplacement();
  });

  test("refreshes dependent choice resolvers when a mounted action is replaced", () => {
    const store = new ActionStore();
    const firstOptions = [{ value: "old", label: "Old item" }];
    const disposeFirst = store.register(owner, {
      id: "choose",
      label: "Choose item",
      choices: [{ id: "item", label: "Item", options: () => firstOptions }],
      run: () => undefined,
    });
    const oldChoice = store.getSnapshot().componentActions[0]?.choices?.[0];
    expect(oldChoice).toBeDefined();
    expect(oldChoice && resolveActionChoiceOptions(oldChoice, {})).toEqual(firstOptions);

    disposeFirst();
    const latestOptions = [{ value: "new", label: "New item" }];
    store.register(owner, {
      id: "choose",
      label: "Choose item",
      choices: [{ id: "item", label: "Item", options: () => latestOptions }],
      run: () => undefined,
    });
    const latestChoice = store.getSnapshot().componentActions[0]?.choices?.[0];
    expect(latestChoice).toBeDefined();
    expect(latestChoice && resolveActionChoiceOptions(latestChoice, {})).toEqual(latestOptions);
  });

  test("validates component-owned action metadata", () => {
    const store = new ActionStore();
    expect(() =>
      store.register(owner, { id: "1bad", label: "Bad", run: () => undefined }),
    ).toThrow("must start with an ASCII letter");
    expect(() =>
      store.register(owner, { id: "bad", label: " ", run: () => undefined }),
    ).toThrow("labels must be non-empty");
    expect(() =>
      store.register(owner, {
        id: "bad",
        label: "Bad",
        keywords: [""],
        run: () => undefined,
      }),
    ).toThrow("keywords must be non-empty");
  });

  test("validates choice steps and resolves options from prior selections", () => {
    const store = new ActionStore();
    const run = () => undefined;
    store.register(owner, {
      id: "scoped",
      label: "Scoped action",
      choices: [
        { id: "kind", label: "Kind", options: [{ value: "a", label: "A" }] },
        {
          id: "detail",
          label: "Detail",
          options: (selections) => selections.kind === "a"
            ? [{ value: "one", label: "One" }]
            : [{ value: "two", label: "Two" }],
        },
      ],
      run,
    });
    const action = store.getSnapshot().componentActions[0];
    expect(action?.choices?.[1]?.options).toBeFunction();
    expect(action?.choices?.[1] && typeof action.choices[1].options === "function"
      ? action.choices[1].options({ kind: "a" })
      : []).toEqual([{ value: "one", label: "One" }]);
    expect(() => store.register(owner, {
      id: "invalid-choice",
      label: "Invalid",
      choices: [{ id: "bad", label: "Bad", options: [] }],
      run,
    })).toThrow("options must be non-empty");
  });
});

describe("ActionStore provider index", () => {
  test("keeps provider order and applies the last id/reference alias", () => {
    const first = action("shared", { reference: "public:shared", label: "First" });
    const second = action("shared", { reference: "public:shared", label: "Second" });
    const store = new ActionStore();
    store.replaceProviders([
      { id: "first", actions: [first] },
      { id: "second", actions: [second] },
    ]);

    expect(store.getSnapshot().actions.map(({ label }) => label)).toEqual(["First", "Second"]);
    expect(store.get("shared")).toBe(second);
    expect(store.get("public:shared")).toBe(second);
    expect(store.getIndexedActions()).toEqual([second]);
  });

  test("keeps callbacks fresh without notifying until presentation data changes", async () => {
    let called = "first";
    const first = action("refresh", { run: () => { called = "first"; } });
    const store = new ActionStore();
    store.replaceProviders([{ id: "application", actions: [first] }]);
    let observed = store.getSnapshot();
    let notifications = 0;
    store.subscribe(() => { notifications += 1; observed = store.getSnapshot(); });

    store.replaceProviders([{ id: "application", actions: [action("refresh", {
      run: () => { called = "latest"; },
    })] }]);
    expect(notifications).toBe(0);
    expect(store.getSnapshot()).toBe(observed);
    await store.run("refresh");
    expect(called).toBe("latest");
    notifications = 0;
    observed = store.getSnapshot();

    store.replaceProviders([{ id: "application", actions: [action("refresh", {
      label: "Refresh now",
      run: () => { called = "changed"; },
    })] }]);
    expect(notifications).toBe(1);
    expect(observed).toBe(store.getSnapshot());
    expect(observed.actions[0]?.label).toBe("Refresh now");
  });
});

describe("action search and execution", () => {
  test("matches all searchable fields while keeping groups and ties stable", () => {
    const actions = [
      action("settings", { label: "Open settings", group: "Application" }),
      action("alpha", {
        label: "Start alpha",
        description: "bun run dev",
        group: "Project commands",
      }),
      action("beta", {
        label: "Start beta",
        keywords: ["web server"],
        group: "Project commands",
      }),
      action("refresh", {
        label: "Refresh",
        source: "health-card",
        group: "Component · Health",
      }),
    ];

    expect(rankActions(actions, "start").map((item) => item.id)).toEqual([
      "alpha",
      "beta",
    ]);
    expect(rankActions(actions, "bun dev").map((item) => item.id)).toEqual([
      "alpha",
    ]);
    expect(rankActions(actions, "web").map((item) => item.id)).toEqual([
      "beta",
    ]);
    expect(rankActions(actions, "health card").map((item) => item.id)).toEqual([
      "refresh",
    ]);
    expect(rankActions(actions, "").map((item) => item.id)).toEqual(
      actions.map((item) => item.id),
    );
  });

  test("ranks relevance across groups and prefers visible labels over metadata", () => {
    const actions = [
      action("incidental", { label: "Open settings", description: "Reload" }),
      action("fuzzy", { label: "Read local dashboard" }),
      action("prefix", { label: "Reload server", group: "Project commands" }),
      action("exact", { label: "Reload", group: "Component" }),
    ];
    expect(rankActions(actions, "reload").map(({ id }) => id)).toEqual([
      "exact", "prefix", "incidental", "fuzzy",
    ]);
  });

  test("matches reordered partial words and terms across fields, requiring every term", () => {
    const actions = [
      action("server", { label: "Start development server", source: "backend-api" }),
      action("stop", { label: "Stop development server", source: "backend-api" }),
      action("other", { label: "Start worker" }),
    ];
    for (const query of ["server sta", "backend start", " START--dev "]) {
      expect(rankActions(actions, query).map(({ id }) => id)).toEqual(["server"]);
    }
    expect(rankActions(actions, "start nonexistent")).toEqual([]);
  });

  test("retains fuzzy abbreviations below direct matches", () => {
    const actions = [
      action("fuzzy", { label: "Reload dashboard" }),
      action("direct", { label: "Rld status", group: "Component" }),
    ];
    expect(rankActions(actions, "rld").map(({ id }) => id)).toEqual(["direct", "fuzzy"]);
  });

  test("promotes favorites only after search has selected matching actions", () => {
    const actions = [
      action("reload", { label: "Reload app" }),
      action("settings", { label: "Open settings" }),
      action("server", { label: "Reload development server", group: "Project commands" }),
    ];
    const favorites = new Set(["server", "settings"]);

    expect(rankActions(actions, "", favorites).map((item) => item.id)).toEqual([
      "settings",
      "server",
      "reload",
    ]);
    expect(rankActions(actions, "reload", favorites).map((item) => item.id)).toEqual([
      "server",
      "reload",
    ]);
  });

  test("re-resolves actions, prevents duplicate runs, and reports failures", async () => {
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const actions = new Map<string, PaletteAction>([
      ["slow", action("slow", { run: () => pending })],
      ["disabled", action("disabled", { enabled: false, disabledReason: "Blocked" })],
      ["failure", action("failure", { run: () => Promise.reject(new Error("Boom")) })],
    ]);
    const store = new ActionStore();
    store.replaceProviders([{ id: "test", actions: [...actions.values()] }]);

    const first = store.run("slow");
    expect(store.getSnapshot().runningActionIds.has("slow")).toBeTrue();
    expect(await store.run("slow")).toEqual({ status: "running" });
    release?.();
    expect(await first).toEqual({ status: "completed" });
    expect(store.getSnapshot().runningActionIds.has("slow")).toBeFalse();

    expect(await store.run("disabled")).toEqual({
      status: "unavailable",
      reason: "Blocked",
    });
    actions.delete("slow");
    store.replaceProviders([{ id: "test", actions: [...actions.values()] }]);
    expect(await store.run("slow")).toEqual({
      status: "unavailable",
      reason: "This action is no longer available.",
    });
    const failed = await store.run("failure");
    expect(failed.status).toBe("failed");
    if (failed.status === "failed") expect(String(failed.error)).toContain("Boom");
  });

  test("canonicalizes aliases before suppressing duplicate runs", async () => {
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const slow = action("runtime:slow", { reference: "component:node:slow", run: () => pending });
    const store = new ActionStore();
    store.replaceProviders([{ id: "test", actions: [slow] }]);
    const first = store.run(slow.reference!);
    expect(store.getSnapshot().runningActionIds).toEqual(new Set([slow.id]));
    expect(await store.run(slow.id)).toEqual({ status: "running" });
    release?.();
    expect(await first).toEqual({ status: "completed" });
  });

  test("records outcomes for the invoking control without copying them to another control", async () => {
    const run = action("process:qa", { invocationOutcome: "started", run: () => undefined });
    const store = new ActionStore();
    store.replaceProviders([{ id: "test", actions: [run] }]);
    expect(await store.run(run.id, {}, {}, "button", "button:run-qa")).toEqual({ status: "completed" });
    expect(store.getInvocationState("button:run-qa")).toMatchObject({
      status: "completed",
      outcome: "started",
    });
    expect(store.getInvocationState("list:item-2:run-qa")).toBeUndefined();
  });

  test("passes completed choice selections to the action", async () => {
    let received: unknown;
    const actions = new Map<string, PaletteAction>([
      ["choose", action("choose", {
        choices: [{ id: "mode", label: "Mode", options: [{ value: "safe", label: "Safe" }] }],
        run: (selections, args, callerNodeId) => { received = { selections, args, callerNodeId }; },
      })],
    ]);
    const store = new ActionStore();
    store.replaceProviders([{ id: "test", actions: [...actions.values()] }]);
    const result = await store.run("choose", { mode: "safe" }, { prompt: "Review" }, "button-node");
    expect(result).toEqual({ status: "completed" });
    expect(received).toEqual({ selections: { mode: "safe" }, args: { prompt: "Review" }, callerNodeId: "button-node" });
  });

  test("matches configured arguments to compatible choice steps", () => {
    const choices = [
      { id: "mode", label: "Mode", options: [{ value: "safe", label: "Safe" }] },
      { id: "region", label: "Region", options: (selections: Readonly<Record<string, string>>) => selections.mode === "safe"
        ? [{ value: "local", label: "Local" }]
        : [{ value: "remote", label: "Remote" }] },
    ];
    expect(matchActionChoiceSelections(choices, { mode: "safe", region: "local", ignored: "x" })).toEqual({ mode: "safe", region: "local" });
    expect(matchActionChoiceSelections(choices, { mode: "unsafe", region: "local" })).toEqual({});
  });
});

describe("application action providers", () => {
  test("lists declared actions while their component is unmounted", () => {
    const project = snapshot({ trusted: true });
    const rootChildren = project.tree?.children;
    const target = rootChildren && !Array.isArray(rootChildren) && "node" in rootChildren
      ? rootChildren.node
      : null;
    expect(target).not.toBeNull();
    target!.manifest = {
      ...target!.manifest!,
      actions: [{ id: "run", label: "Run check" }],
    };

    const declared = buildDeclaredComponentActions(project, []);
    expect(declared).toHaveLength(1);
    expect(declared[0]).toMatchObject({
      id: "component:server:run",
      enabled: false,
      disabledReason: "Component is not mounted",
    });
    expect(buildDeclaredComponentActions(project, [action("mounted", {
      reference: "component:server:run",
    })])).toEqual([]);
  });

  const callbacks = {
    reloadApp: () => undefined,
    showDashboard: () => undefined,
    showSettings: () => undefined,
    toggleSidebar: () => undefined,
    addDashboard: () => undefined,
    openProject: () => undefined,
    editDashboard: () => undefined,
    saveDashboard: () => undefined,
    cancelDashboard: () => undefined,
    reloadProject: () => undefined,
    trustProject: () => undefined,
    revokeTrust: () => undefined,
    runProcessQuickAction: () => undefined,
    stopProcess: () => undefined,
  };

  test("routes agent:prompt typed arguments with the invoking node context", () => {
    let received: unknown;
    const actions = buildApplicationActions({
      snapshot: snapshot({ trusted: true }),
      projects: [],
      activeView: "dashboard",
      sidebarExpanded: false,
      pendingAction: null,
      editing: false,
      draftDirty: false,
      draftValid: false,
      savingDraft: false,
      callbacks: { ...callbacks, requestAgentPrompt: (args, callerNodeId) => { received = { args, callerNodeId }; } },
    });
    const action = actions.find((item) => item.id === "agent:prompt");
    expect(action?.enabled).toBeTrue();
    action?.run({}, { prompt: "Review this" }, "review-button");
    expect(received).toEqual({ args: { prompt: "Review this" }, callerNodeId: "review-button" });
  });

  test("exposes an always-available app reload action", () => {
    let reloaded = false;
    const actions = buildApplicationActions({
      snapshot: null,
      projects: [],
      activeView: "dashboard",
      sidebarExpanded: false,
      pendingAction: "some-action",
      editing: false,
      draftDirty: false,
      draftValid: false,
      savingDraft: false,
      callbacks: { ...callbacks, reloadApp: () => { reloaded = true; } },
    });
    const reload = actions.find((item) => item.id === "app:reload");

    expect(reload).toMatchObject({
      label: "Reload app",
      description: "Reload the app window and renderer.",
      group: "Application",
      enabled: true,
    });
    reload?.run();
    expect(reloaded).toBeTrue();
  });

  test("offers app and dashboard theme actions as two-choice flows", async () => {
    const changes: Array<[string | undefined, string | undefined]> = [];
    const actions = buildApplicationActions({
      snapshot: snapshot({ configPath: "/workspace/example/.dash-bored/dash-bored.yaml" }),
      projects: [], activeView: "dashboard", sidebarExpanded: false, pendingAction: null,
      editing: false, draftDirty: false, draftValid: false, savingDraft: false,
      appSettings: { theme: "global:ocean", themeMode: "dark" },
      themeCatalog: [
        { reference: "builtin:default", name: "Default", manifest: { schemaVersion: 1, id: "default", name: "Default", light: {}, dark: {} } },
        { reference: "global:ocean", name: "Ocean", manifest: { schemaVersion: 1, id: "ocean", name: "Ocean", light: {}, dark: {} } },
        { reference: "./themes/plum", name: "Plum", manifest: { schemaVersion: 1, id: "plum", name: "Plum", light: {}, dark: {} } },
        { reference: projectThemeReference("/workspace/example/.dash-bored/dash-bored.yaml", "./themes/plum"), name: "Plum", manifest: { schemaVersion: 1, id: "plum", name: "Plum", light: {}, dark: {} } },
      ],
      callbacks: {
        ...callbacks,
        setDefaultAppearance: (theme, appearance) => { changes.push([theme, appearance]); },
        setDashboardAppearance: (theme, appearance) => { changes.push([theme, appearance]); },
      },
    });
    const dashboard = actions.find((action) => action.id === "theme:set-dashboard");
    const defaultTheme = actions.find((action) => action.id === "theme:set-default");
    expect(dashboard?.choices?.map((choice) => choice.id)).toEqual(["theme", "appearance"]);
    expect(defaultTheme?.choices?.[0]?.options).toHaveLength(3);
    await dashboard?.run({ theme: "./themes/plum", appearance: "system" });
    await defaultTheme?.run({ theme: "global:ocean", appearance: "light" });
    expect(changes).toEqual([["./themes/plum", "system"], ["global:ocean", "light"]]);
  });

  test("derives shell, dashboard, trust, and disabled process actions", () => {
    const actions = buildApplicationActions({
      snapshot: snapshot(),
      projects: [
        { projectRoot: "/workspace/example", configPath: "/workspace/example/.dash-bored/dash-bored.yaml", dashboardName: "Example" },
        { projectRoot: "/workspace/other", configPath: "/workspace/other/.dash-bored/dash-bored.yaml", dashboardName: "Other" },
      ],
      activeView: "settings",
      sidebarExpanded: false,
      pendingAction: null,
      editing: false,
      draftDirty: false,
      draftValid: false,
      savingDraft: false,
      callbacks,
    });

    expect(actions.find((item) => item.id === "app:show-dashboard")?.enabled).toBeTrue();
    expect(actions.find((item) => item.label === "Open Other")?.enabled).toBeTrue();
    expect(actions.find((item) => item.id === "project:trust")?.confirmation?.message).toContain(
      "run project commands",
    );
    expect(actions.find((item) => item.id.startsWith("process:"))).toMatchObject({
      label: "Run Development server",
      enabled: false,
      disabledReason: "Trust this project before running configured commands.",
    });
  });

  test("switches process actions between quick actions, terminal close, and stopping states", () => {
    const runningSnapshot = snapshot({
      trusted: true,
      processes: [
        {
          id: "server",
          phase: "running",
          pid: 42,
          exitCode: null,
          signal: null,
          logs: [],
        },
      ],
    });
    const calls: string[] = [];
    const callbacks = {
      runQuickAction: (nodeId: string) => { calls.push(`run:${nodeId}`); },
      stop: (nodeId: string) => { calls.push(`stop:${nodeId}`); },
    };
    const running = buildProcessActions(runningSnapshot, null, callbacks);
    expect(running.map((item) => item.label)).toEqual(["Run Development server", "Stop Development server"]);
    expect(running[0]).toMatchObject({ enabled: false, disabledReason: "This command is already running." });
    expect(running[1]).toMatchObject({ id: "process-close:server", enabled: true });

    // An open interactive terminal whose run finished runs again; closing stays separate.
    const resting = buildProcessActions({
      ...runningSnapshot,
      processes: [{
        ...runningSnapshot.processes[0]!,
        interactive: true,
        run: { phase: "exited", exitCode: 1, signal: null, startedAt: "2026-09-24T10:00:00.000Z", durationMs: 4 },
      }],
    }, null, callbacks);
    expect(resting.map((item) => item.label)).toEqual(["Run Development server", "Close terminal Development server"]);
    expect(resting[0]).toMatchObject({ id: "process:server", enabled: true, invocationOutcome: "started" });
    void resting[0]!.run();
    void resting[1]!.run();
    expect(calls).toEqual(["run:server", "stop:server"]);

    const idle = buildProcessActions(
      { ...runningSnapshot, processes: [{ ...runningSnapshot.processes[0]!, phase: "exited", pid: null, exitCode: 0 }] },
      null,
      callbacks,
    );
    expect(idle.map((item) => item.label)).toEqual(["Run Development server"]);

    const stopping = buildProcessActions(
      {
        ...runningSnapshot,
        processes: [{ ...runningSnapshot.processes[0]!, phase: "stopping" }],
      },
      null,
      callbacks,
    );
    expect(stopping.map((item) => item.label)).toEqual(["Run Development server", "Stop Development server"]);
    expect(stopping.every((item) => !item.enabled && item.disabledReason === "This process is stopping.")).toBeTrue();
  });

  test("switches dashboards through one chooser while retaining direct stable actions", async () => {
    const projects = [
      { projectRoot: "/workspace/example", configPath: "/workspace/example/.dash-bored/dash-bored.yaml", dashboardName: "Example" },
      { projectRoot: "/workspace/example", configPath: "/workspace/example/.dash-bored/other/dash-bored.yaml", dashboardName: "Other" },
    ];
    const opened: string[] = [];
    const context = {
      snapshot: snapshot({ configPath: projects[0]!.configPath }), projects,
      activeView: "dashboard" as const, sidebarExpanded: false, pendingAction: null,
      editing: false, draftDirty: false, draftValid: false, savingDraft: false,
      callbacks: { ...callbacks, openProject: async (project: typeof projects[number]) => { opened.push(project.configPath); } },
    };
    const actions = buildApplicationActions(context);
    const chooser = actions.find(({ id }) => id === "app:switch-dashboard")!;
    expect(chooser.enabled).toBeTrue();
    expect(chooser.choices?.[0]?.options).toEqual([{
      value: projects[1]!.configPath, label: "Other", description: projects[1]!.configPath,
    }]);
    const matches = rankActions(actions, "Other");
    expect(matches[0]?.id).toBe("app:switch-dashboard");
    expect(matches.some(({ id }) => id.startsWith("dashboard:"))).toBeFalse();
    expect(rankActions(actions, "", new Set([`dashboard:${encodeURIComponent(projects[1]!.configPath)}`]))
      .some(({ id }) => id.startsWith("dashboard:"))).toBeFalse();
    expect(rankActions(actions, "reload app").some(({ id }) => id === "app:reload")).toBeTrue();
    await chooser.run({ dashboard: projects[1]!.configPath });
    await actions.find(({ id }) => id === `dashboard:${encodeURIComponent(projects[1]!.configPath)}`)!.run();
    expect(opened).toEqual([projects[1]!.configPath, projects[1]!.configPath]);
    expect(() => chooser.run({ dashboard: "/stale/dashboard" })).toThrow("Choose an available dashboard");
    const single = buildApplicationActions({ ...context, projects: [projects[0]!] });
    expect(single.find(({ id }) => id === "app:switch-dashboard")?.enabled).toBeFalse();
    const pending = buildApplicationActions({ ...context, pendingAction: "open" });
    expect(pending.find(({ id }) => id === "app:switch-dashboard")?.disabledReason).toBe("Another application action is in progress.");
    const settings = buildApplicationActions({ ...context, activeView: "settings" });
    expect(settings.find(({ id }) => id === "app:switch-dashboard")?.choices?.[0]?.options).toHaveLength(2);
  });

  test("derives focus actions for every node in the active dashboard", () => {
    let focusedNode: string | undefined;
    const actions = buildNodeFocusActions(
      snapshot({ trusted: true }),
      "server",
      false,
      (nodeId) => {
        focusedNode = nodeId;
      },
    );

    expect(actions.map((item) => item.id)).toEqual([
      "project:focus",
      "focus:root",
      "focus:server",
    ]);
    expect(actions[1]).toMatchObject({
      label: "Focus Dashboard",
      description: "Show Dashboard in the active dashboard.",
      group: "Dashboard nodes",
      enabled: true,
    });
    expect(actions[2]).toMatchObject({
      label: "Focus Development server",
      enabled: false,
      disabledReason: "This node is already focused.",
    });

    expect(rankActions(actions, "focus").map((action) => action.id)).toEqual(["project:focus"]);
    expect(rankActions(actions, "", new Set(["focus:root"])).map((action) => action.id)).toEqual(["project:focus"]);
    expect(rankActions(actions, "focus", new Set(), true).map((action) => action.id)).toContain("focus:root");
    expect(actions[0]?.choices?.[0]?.options).toEqual([{
      value: "root", label: "Dashboard", description: "Show Dashboard in the active dashboard.",
    }]);
    actions[0]?.run({ node: "root" });
    expect(focusedNode).toBe("root");
    actions[1]?.run();
    expect(focusedNode).toBe("root");
  });

  test("keeps the focus chooser and direct targets unavailable while editing", () => {
    const actions = buildNodeFocusActions(snapshot(), null, true, () => undefined);
    expect(actions).toHaveLength(3);
    expect(actions.every((item) => item.enabled)).toBeFalse();
    expect(actions[0]?.disabledReason).toBe(
      "Finish dashboard editing before focusing a node.",
    );
  });

  test("exposes dashboard editing and draft save actions from the current editor state", () => {
    const base = {
      snapshot: snapshot({ trusted: true }),
      projects: [],
      activeView: "dashboard" as const,
      sidebarExpanded: false,
      pendingAction: null,
      callbacks,
    };
    const idle = buildApplicationActions({
      ...base,
      editing: false,
      draftDirty: false,
      draftValid: false,
      savingDraft: false,
    });
    expect(idle.find((item) => item.id === "project:edit")).toMatchObject({
      enabled: true,
      label: "Open component library",
    });
    expect(idle.find((item) => item.id === "project:save-draft")).toMatchObject({
      enabled: false,
      disabledReason: "Make a dashboard change first.",
    });

    const editing = buildApplicationActions({
      ...base,
      editing: true,
      draftDirty: true,
      draftValid: true,
      savingDraft: false,
    });
    expect(editing.find((item) => item.id === "project:edit")).toMatchObject({
      enabled: true,
      label: "Open component library",
    });
    expect(editing.find((item) => item.id === "project:save-draft")).toMatchObject({
      enabled: true,
      label: "Save dashboard changes",
    });
    expect(editing.find((item) => item.id === "project:cancel-edit")).toMatchObject({
      enabled: true,
      label: "Cancel dashboard editing",
    });
  });
});
