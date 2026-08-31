import { describe, expect, test } from "bun:test";
import { createUiHarnessHost } from "../../src/renderer/ui-harness-host";
import { childNodes } from "../../src/renderer/component-children";

describe("ui harness host", () => {
  test("supplies the real renderer with a deterministic dashboard fixture", async () => {
    const host = createUiHarnessHost();
    const snapshot = await host.getSnapshot();

    expect(snapshot.projectRoot).toBe("/ui-harness/dash-bored");
    expect(snapshot.trusted).toBeTrue();
    expect(snapshot.tree).toMatchObject({
      id: "harness-root",
      component: "@dash-bored/tabs",
      children: { type: "managed" },
    });
    const nodeIds: string[] = [];
    const collectIds = (node: NonNullable<typeof snapshot.tree>): void => {
      nodeIds.push(node.id);
      for (const child of childNodes(node)) collectIds(child);
    };
    collectIds(snapshot.tree!);
    expect(new Set(nodeIds).size).toBe(nodeIds.length);
    expect(snapshot.componentCatalog.find((entry) => entry.reference === "@dash-bored/group")?.manifest?.children)
      .toEqual({ min: 0, presentation: { type: "tiled", axes: "both" } });
    expect(snapshot.componentCatalog.find((entry) => entry.reference === "@dash-bored/group")?.manifest?.renderMode)
      .toBe("layout");
    expect(snapshot.componentCatalog.find((entry) => entry.reference === "@dash-bored/tabs")?.manifest?.children?.presentation)
      .toEqual({ type: "managed" });
    expect(snapshot.componentCatalog.find((entry) => entry.reference === "@dash-bored/tabs")?.manifest?.renderMode)
      .toBe("layout");
    expect(await host.listProjects()).toEqual([{
      projectRoot: "/ui-harness/dash-bored",
      configPath: "/ui-harness/dash-bored/dash-bored.yaml",
      dashboardName: "Visual verification fixture",
    }]);
  });

  test("validates, persists, publishes revisions, and rejects stale drafts", async () => {
    const host = createUiHarnessHost();
    const source = await host.getDashboardConfigSource();
    const invalid = structuredClone(source.config);
    invalid.root.children = { type: "managed", items: [] };

    const validation = await host.validateDashboardDraft(invalid);
    expect(validation.ok).toBeFalse();
    expect(validation.diagnostics.map((item) => item.code)).toContain("COMPONENT_CHILD_CARDINALITY");

    const saved = structuredClone(source.config);
    saved.name = "Saved fixture";
    const snapshots: number[] = [];
    const unsubscribe = host.subscribe((event) => {
      if (event.type === "snapshot") snapshots.push(event.snapshot.revision);
    });
    const afterSave = await host.saveDashboardConfig(saved, source.configRevision);
    unsubscribe();

    expect(afterSave.dashboardName).toBe("Saved fixture");
    expect(afterSave.configRevision).toBe("ui-harness-2");
    expect(host.getPersistedConfig().name).toBe("Saved fixture");
    expect(snapshots).toEqual([2]);
    await expect(host.saveDashboardConfig(saved, source.configRevision)).rejects.toThrow("DASHBOARD_CONFIG_CONFLICT");
  });
});
