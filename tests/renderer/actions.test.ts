import { describe, expect, test } from "bun:test";
import {
  ActionExecutor,
  ActionRegistry,
  rankActions,
} from "../../src/renderer/actions";
import type {
  ComponentActionOwner,
  PaletteAction,
} from "../../src/renderer/actions";
import {
  buildApplicationActions,
  buildProcessActions,
} from "../../src/renderer/action-providers";
import type {
  ProjectSnapshot,
  ResolvedComponentNode,
} from "../../src/shared/contracts";

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
    component: "@dash-bored/stack",
    props: {},
    slots: {
      children: [
        {
          id: "server",
          component: "@dash-bored/command",
          props: { label: "Development server", command: "bun run dev" },
          slots: {},
          source: "builtin",
        },
      ],
    },
    source: "builtin",
  };
}

function snapshot(overrides: Partial<ProjectSnapshot> = {}): ProjectSnapshot {
  return {
    projectRoot: "/workspace/example",
    dashboardName: "Example",
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

describe("ActionRegistry", () => {
  test("namespaces registrations and disposes them by token, owner, and scope", () => {
    const registry = new ActionRegistry();
    const disposeFirst = registry.register(owner, {
      id: "refresh",
      label: "Refresh service health",
      keywords: ["status"],
      run: () => undefined,
    });
    expect(registry.getSnapshot()).toHaveLength(1);
    expect(registry.getSnapshot()[0]).toMatchObject({
      label: "Refresh service health",
      group: "Component · Service health",
      source: "health",
    });

    expect(() =>
      registry.register(owner, {
        id: "refresh",
        label: "Duplicate",
        run: () => undefined,
      }),
    ).toThrow("duplicate action id");

    registry.clearOwner(owner);
    const disposeReplacement = registry.register(owner, {
      id: "refresh",
      label: "Replacement",
      run: () => undefined,
    });
    disposeFirst();
    expect(registry.getSnapshot().map((item) => item.label)).toEqual([
      "Replacement",
    ]);

    registry.register(
      { ...owner, nodeId: "secondary" },
      { id: "refresh", label: "Other instance", run: () => undefined },
    );
    expect(registry.getSnapshot()).toHaveLength(2);
    registry.clearScope(owner.scope);
    expect(registry.getSnapshot()).toEqual([]);
    disposeReplacement();
  });

  test("validates component-owned action metadata", () => {
    const registry = new ActionRegistry();
    expect(() =>
      registry.register(owner, { id: "1bad", label: "Bad", run: () => undefined }),
    ).toThrow("must start with an ASCII letter");
    expect(() =>
      registry.register(owner, { id: "bad", label: " ", run: () => undefined }),
    ).toThrow("labels must be non-empty");
    expect(() =>
      registry.register(owner, {
        id: "bad",
        label: "Bad",
        keywords: [""],
        run: () => undefined,
      }),
    ).toThrow("keywords must be non-empty");
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
    const executor = new ActionExecutor((id) => actions.get(id));

    const first = executor.run("slow");
    expect(executor.getSnapshot().has("slow")).toBeTrue();
    expect(await executor.run("slow")).toEqual({ status: "running" });
    release?.();
    expect(await first).toEqual({ status: "completed" });
    expect(executor.getSnapshot().has("slow")).toBeFalse();

    expect(await executor.run("disabled")).toEqual({
      status: "unavailable",
      reason: "Blocked",
    });
    actions.delete("slow");
    expect(await executor.run("slow")).toEqual({
      status: "unavailable",
      reason: "This action is no longer available.",
    });
    const failed = await executor.run("failure");
    expect(failed.status).toBe("failed");
    if (failed.status === "failed") expect(String(failed.error)).toContain("Boom");
  });
});

describe("application action providers", () => {
  const callbacks = {
    showDashboard: () => undefined,
    showSettings: () => undefined,
    toggleSidebar: () => undefined,
    addDashboard: () => undefined,
    openProject: () => undefined,
    reloadProject: () => undefined,
    trustProject: () => undefined,
    revokeTrust: () => undefined,
    startProcess: () => undefined,
    stopProcess: () => undefined,
  };

  test("derives shell, dashboard, trust, and disabled process actions", () => {
    const actions = buildApplicationActions({
      snapshot: snapshot(),
      projects: [
        { projectRoot: "/workspace/example", dashboardName: "Example" },
        { projectRoot: "/workspace/other", dashboardName: "Other" },
      ],
      activeView: "settings",
      sidebarExpanded: false,
      pendingAction: null,
      callbacks,
    });

    expect(actions.find((item) => item.id === "app:show-dashboard")?.enabled).toBeTrue();
    expect(actions.find((item) => item.label === "Open Other")?.enabled).toBeTrue();
    expect(actions.find((item) => item.id === "project:trust")?.confirmation?.message).toContain(
      "run project commands",
    );
    expect(actions.find((item) => item.id.startsWith("process:"))).toMatchObject({
      label: "Start Development server",
      enabled: false,
      disabledReason: "Trust this project before running configured commands.",
    });
  });

  test("switches process actions between start, stop, and stopping states", () => {
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
    const running = buildProcessActions(runningSnapshot, null, {
      start: () => undefined,
      stop: () => undefined,
    });
    expect(running[0]).toMatchObject({
      label: "Stop Development server",
      enabled: true,
    });

    const stopping = buildProcessActions(
      {
        ...runningSnapshot,
        processes: [{ ...runningSnapshot.processes[0]!, phase: "stopping" }],
      },
      null,
      { start: () => undefined, stop: () => undefined },
    );
    expect(stopping[0]).toMatchObject({
      label: "Stop Development server",
      enabled: false,
      disabledReason: "This process is stopping.",
    });
  });
});
