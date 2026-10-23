import { describe, expect, test } from "bun:test";
import { createUiHarnessHost } from "../helpers/ui-harness-host";
import { childNodes } from "../../src/renderer/lib/component-children";

describe("ui harness host", () => {
  test("supplies the real renderer with a deterministic dashboard fixture", async () => {
    const host = createUiHarnessHost();
    const snapshot = await host.getSnapshot();

    expect((await host.getAppSettings()).dashBoredAgent).toBeNull();

    expect(snapshot.projectRoot).toBe("/ui-harness/.dash-bored");
    expect(snapshot.trusted).toBeTrue();
    expect(snapshot.tree).toMatchObject({
      id: "harness-root",
      component: "./components/external/core/tabs",
    });
    expect(Array.isArray(snapshot.tree?.children)).toBeTrue();
    const [wideTab] = childNodes(snapshot.tree!);
    const [wideGroup] = childNodes(wideTab!);
    const [wideFirst] = childNodes(wideGroup!);
    expect(wideTab?.sourceNodePath).toEqual([{ type: "managed", index: 0 }]);
    expect(wideFirst?.sourceNodePath).toEqual([
      { type: "managed", index: 0 },
      { type: "tiled", path: ["first"] },
      { type: "tiled", path: ["first"] },
    ]);
    const nodeIds: string[] = [];
    const collectIds = (node: NonNullable<typeof snapshot.tree>): void => {
      nodeIds.push(node.id);
      for (const child of childNodes(node)) collectIds(child);
    };
    collectIds(snapshot.tree!);
    expect(new Set(nodeIds).size).toBe(nodeIds.length);
    expect(snapshot.componentCatalog.find((entry) => entry.reference === "./components/external/core/group")?.manifest?.children)
      .toEqual({ min: 0, presentation: { type: "tiled", axes: "both" } });
    expect(snapshot.componentCatalog.find((entry) => entry.reference === "./components/external/core/group")?.manifest?.renderMode)
      .toBe("layout");
    expect(snapshot.componentCatalog.find((entry) => entry.reference === "./components/external/core/tabs")?.manifest?.children?.presentation)
      .toEqual({ type: "managed" });
    expect(snapshot.componentCatalog.find((entry) => entry.reference === "./components/external/core/tabs")?.manifest?.renderMode)
      .toBe("layout");
    expect(await host.listProjects()).toEqual([{
      projectRoot: "/ui-harness/.dash-bored",
      configPath: "/ui-harness/.dash-bored/dash-bored.yaml",
      dashboardName: "Visual verification fixture",
    }]);
  });

  test("validates, persists, publishes revisions, and rejects stale drafts", async () => {
    const host = createUiHarnessHost();
    const source = await host.getDashboardConfigSource();
    const valid = await host.validateDashboardDraft(source.config);
    expect(valid).toMatchObject({ ok: true, tree: { id: "harness-root" } });
    expect(valid.components.map((component) => component.componentId)).toContain("host-stability");
    expect(valid.components.map((component) => component.componentId)).toContain("core/tabs");
    const invalid = structuredClone(source.config);
    invalid.root.children = [];

    const validation = await host.validateDashboardDraft(invalid);
    expect(validation.ok).toBeFalse();
    expect(validation.tree).toBeNull();
    expect(validation.components).toEqual([]);
    expect(validation.diagnostics.map((item) => item.code)).toContain("COMPONENT_CHILD_CARDINALITY");

    const saved = structuredClone(source.config);
    saved.name = "Saved fixture";
    const snapshots: number[] = [];
    const unsubscribe = host.subscribe((event) => {
      if (event.type === "snapshot") snapshots.push(event.snapshot.revision);
    });
    await host.saveDashboardConfig(saved, source.configRevision);
    unsubscribe();

    const afterSave = await host.getSnapshot();
    expect(afterSave.dashboardName).toBe("Saved fixture");
    expect(afterSave.configRevision).toBe("ui-harness-2");
    expect(host.getPersistedConfig().name).toBe("Saved fixture");
    expect(snapshots).toEqual([2]);
    await expect(host.saveDashboardConfig(saved, source.configRevision)).rejects.toThrow("DASHBOARD_CONFIG_CONFLICT");
  });

  test("coalesces notifications by key like the host and pushes every change", async () => {
    const host = createUiHarnessHost();
    const pushes: number[] = [];
    const unsubscribe = host.subscribe((event) => {
      if (event.type === "notifications") pushes.push(event.state.entries.length);
    });
    expect(await host.getNotifications()).toEqual({ entries: [], history: [] });

    const first = host.raiseNotification({ key: "run:qa", title: "QA failed", message: "Exited with code 1.", target: { kind: "node", nodeId: "status" } });
    const other = host.raiseNotification({ key: "updates", level: "inform", configPath: null, title: "Updates", message: "2 packages", target: { kind: "updates" } });
    const again = host.raiseNotification({ key: "run:qa", title: "QA failed", message: "Exited with code 2.", target: { kind: "node", nodeId: "status" } });
    expect(first).toMatchObject({ level: "interrupt", count: 1, presentation: 1, configPath: "/ui-harness/.dash-bored/dash-bored.yaml", dashboardName: "Visual verification fixture" });
    expect(other).toMatchObject({ level: "inform", presentation: 0, configPath: null, dashboardName: null });
    expect(again).toMatchObject({ id: first.id, count: 2, presentation: 2, message: "Exited with code 2." });
    expect((await host.getNotifications()).entries.map(({ key }) => key)).toEqual(["run:qa", "updates"]);

    // A coalesced inform never downgrades an open interrupt; a quiet raise keeps its presentation.
    expect(host.raiseNotification({ key: "run:qa", level: "inform", quiet: true, title: "QA failed", message: "Still failing." }))
      .toMatchObject({ level: "interrupt", count: 3, presentation: 2 });

    await host.notificationCommand({ type: "notify", nodeId: "status", message: "Fixture is ready", itemId: "row-1" });
    const notified = (await host.getNotifications()).entries[0]!;
    expect(notified).toMatchObject({ kind: "notify", title: "Renderer fixture", message: "Fixture is ready", target: { kind: "node", nodeId: "status", itemId: "row-1" } });
    await expect(host.notificationCommand({ type: "notify", nodeId: "missing", message: "x" })).rejects.toThrow("No component with id missing");

    await host.notificationCommand({ type: "read", ids: [first.id] });
    expect((await host.getNotifications()).entries.find(({ id }) => id === first.id)).toMatchObject({ read: true });
    await host.notificationCommand({ type: "dismiss", ids: [first.id] });
    await host.notificationCommand({ type: "dismiss-all", configPath: null });
    expect((await host.getNotifications()).entries.map(({ kind }) => kind)).toEqual(["notify"]);
    host.resolveNotification(notified.key);
    const closed = await host.getNotifications();
    expect(closed.entries).toEqual([]);
    expect(closed.history.map(({ key, closedBy }) => [key, closedBy])).toEqual([
      [notified.key, "cleared"], ["updates", "dismissed"], ["run:qa", "dismissed"],
    ]);
    await host.notificationCommand({ type: "clear-history" });
    expect((await host.getNotifications()).history).toEqual([]);
    expect(host.getNotificationCommands().map(({ type }) => type))
      .toEqual(["notify", "notify", "read", "dismiss", "dismiss-all", "clear-history"]);
    unsubscribe();
    expect(pushes).toEqual([1, 2, 2, 2, 3, 3, 2, 1, 0, 0]);
  });
});
