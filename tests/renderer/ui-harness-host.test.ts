import { describe, expect, test } from "bun:test";
import { createUiHarnessHost } from "../../src/renderer/lib/ui-harness-host";
import { DEFAULT_DASH_BORED_AGENT } from "../../src/shared/app-settings";
import { childNodes } from "../../src/renderer/lib/component-children";

describe("ui harness host", () => {
  test("supplies the real renderer with a deterministic dashboard fixture", async () => {
    const host = createUiHarnessHost();
    const snapshot = await host.getSnapshot();

    expect((await host.getAppSettings()).dashBoredAgent).toBe(DEFAULT_DASH_BORED_AGENT);

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
});
