import { describe, expect, test } from "bun:test";
import type {
  ComponentCatalogItem,
  ComponentManifest,
  ComponentNode,
  DashboardConfig,
} from "../../src/shared/contracts";
import {
  collapsibleNodePaths,
  countDiscardedRootNodes,
  countNodes,
  createNode,
  insertNode,
  managedChildEdges,
  moveNode,
  nodePathFromSourcePath,
  nodePathById,
  pathKey,
  removeNode,
  replaceRoot,
  tiledChildEdges,
  updateChildMetadata,
  updateDashboardMetadata,
  updateNodeProps,
  updateTiledSplitRatio,
} from "../../src/renderer/dashboard-editor";

function manifest(
  id: string,
  children?: ComponentManifest["children"],
): ComponentManifest {
  return {
    schemaVersion: 2,
    id,
    name: id,
    description: `${id} component`,
    entry: `builtin:${id}`,
    propsSchema: { type: "object", additionalProperties: true },
    ...(children ? { children } : {}),
  };
}

const catalog: ComponentCatalogItem[] = [
  manifest("group", { min: 0, presentation: { type: "tiled", axes: "both" } }),
  manifest("horizontal", { min: 0, presentation: { type: "tiled", axes: "horizontal" } }),
  manifest("tabs", {
    min: 1,
    presentation: { type: "managed" },
    metadataSchema: {
      type: "object",
      properties: { label: { type: "string" } },
      required: ["label"],
    },
  }),
  manifest("text"),
].map((value) => ({
  reference: value.id,
  source: "builtin",
  available: true,
  manifest: value,
  diagnostics: [],
}));

function leaf(id: string): ComponentNode {
  return { id, component: "text", props: { content: id } };
}

function config(): DashboardConfig {
  return {
    schemaVersion: 2,
    name: "Editor",
    root: {
      id: "root",
      component: "group",
      children: {
        type: "tiled",
        layout: {
          type: "split",
          axis: "horizontal",
          ratio: 0.4,
          first: {
            type: "child",
            child: {
              node: {
                id: "nested-group",
                component: "group",
                children: { type: "tiled", layout: { type: "child", child: { node: leaf("nested") } } },
              },
            },
          },
          second: { type: "child", child: { node: leaf("second") } },
        },
      },
    },
  };
}

describe("dashboard editor tree operations", () => {
  test("inserts tiled children in all axes and preserves nested split ratios", () => {
    const added = insertNode(config(), {
      parentPath: [],
      placement: {
        type: "tiled",
        path: ["second"],
        axis: "vertical",
        position: "first",
        ratio: 0.3,
      },
    }, leaf("above-second"), catalog);
    expect(added.root.children?.type).toBe("tiled");
    if (added.root.children?.type !== "tiled") throw new Error("expected tiled");
    expect(added.root.children.layout).toMatchObject({
      type: "split",
      ratio: 0.4,
      second: { type: "split", axis: "vertical", ratio: 0.3 },
    });
    expect(tiledChildEdges(added.root).map((edge) => edge.node.id)).toEqual([
      "nested-group",
      "above-second",
      "second",
    ]);

    expect(() => insertNode({
      ...config(),
      root: { id: "horizontal", component: "horizontal" },
    }, {
      parentPath: [],
      placement: { type: "tiled", path: [], axis: "vertical", position: "first" },
    }, leaf("bad"), catalog)).toThrow("does not allow vertical");
  });

  test("collapses tiled branches after removal and supports cross-parent moves", () => {
    const removed = removeNode(config(), [{ type: "tiled", path: ["second"] }]);
    expect(tiledChildEdges(removed.root).map((edge) => edge.node.id)).toEqual(["nested-group"]);

    const moved = moveNode(
      config(),
      [{ type: "tiled", path: ["second"] }],
      {
        parentPath: [{ type: "tiled", path: ["first"] }],
        placement: { type: "tiled", path: [], axis: "vertical", position: "second" },
      },
      catalog,
    );
    const nested = nodePathById(moved.root, "nested-group")!;
    expect(tiledChildEdges(moved.root).map((edge) => edge.node.id)).toEqual(["nested-group"]);
    expect(tiledChildEdges(tiledChildEdges(moved.root)[0]!.node).map((edge) => edge.node.id)).toEqual([
      "nested", "second",
    ]);
    expect(nested).toEqual([{ type: "tiled", path: [] }]);
  });

  test("manages edge metadata without component-specific label synchronization", () => {
    const tabs: DashboardConfig = {
      schemaVersion: 2,
      name: "Tabs",
      root: {
        id: "tabs",
        component: "tabs",
        children: {
          type: "managed",
          items: [
            { node: leaf("overview"), metadata: { label: "Overview" } },
            { node: leaf("logs"), metadata: { label: "Logs" } },
          ],
        },
      },
    };
    const inserted = insertNode(tabs, {
      parentPath: [],
      placement: { type: "managed", index: 1, metadata: { label: "Settings" } },
    }, leaf("settings"), catalog);
    expect(managedChildEdges(inserted.root).map((edge) => edge.metadata?.label)).toEqual([
      "Overview", "Settings", "Logs",
    ]);

    const renamed = updateChildMetadata(inserted, [{ type: "managed", index: 1 }], { label: "Preferences" });
    const moved = moveNode(renamed, [{ type: "managed", index: 0 }], {
      parentPath: [],
      placement: { type: "managed", index: 3 },
    }, catalog);
    expect(managedChildEdges(moved.root).map((edge) => [edge.node.id, edge.metadata?.label])).toEqual([
      ["settings", "Preferences"],
      ["logs", "Logs"],
      ["overview", "Overview"],
    ]);
  });

  test("updates layout ratios, props, metadata, and dashboard identity immutably", () => {
    const resized = updateTiledSplitRatio(config(), [], [], 0.63);
    if (resized.root.children?.type !== "tiled" || resized.root.children.layout.type !== "split") {
      throw new Error("expected split");
    }
    expect(resized.root.children.layout.ratio).toBe(0.63);
    expect((config().root.children as { layout: { ratio: number } }).layout.ratio).toBe(0.4);

    const updated = updateNodeProps(config(), [{ type: "tiled", path: ["second"] }], { content: "Updated" });
    expect(nodePathById(updated.root, "second")).toEqual([{ type: "tiled", path: ["second"] }]);

    const renamed = updateDashboardMetadata(config(), "name", "New dashboard");
    const icon = updateDashboardMetadata(renamed, "icon", " ./icon.svg ");
    expect(icon).toMatchObject({ name: "New dashboard", icon: "./icon.svg" });
    expect(config().name).toBe("Editor");
  });

  test("replaces roots only when child presentation is compatible", () => {
    const textItem = catalog.find((item) => item.reference === "text")!;
    expect(countDiscardedRootNodes(config(), textItem)).toBe(3);
    const textRoot = replaceRoot(config(), textItem, { content: "Only" });
    expect(textRoot.root.children).toBeUndefined();

    const groupItem = catalog.find((item) => item.reference === "group")!;
    const groupRoot = replaceRoot(config(), groupItem, {});
    expect(tiledChildEdges(groupRoot.root).map((edge) => edge.node.id)).toEqual([
      "nested-group", "second",
    ]);
    expect(countDiscardedRootNodes(config(), groupItem)).toBe(0);

    const limitedManifest = manifest("limited", {
      min: 0,
      max: 1,
      presentation: { type: "tiled", axes: "both" },
    });
    const limitedItem: ComponentCatalogItem = {
      reference: limitedManifest.id,
      source: "builtin",
      available: true,
      manifest: limitedManifest,
      diagnostics: [],
    };
    expect(countDiscardedRootNodes(config(), limitedItem)).toBe(3);
    expect(replaceRoot(config(), limitedItem, {}).root.children).toBeUndefined();
  });

  test("generates unique IDs and exposes stable generic paths", () => {
    const textItem = catalog.find((item) => item.reference === "text")!;
    expect(createNode(config(), textItem, {}).id).toBe("text");
    expect(countNodes(config().root)).toBe(4);
    expect(nodePathById(config().root, "nested")).toEqual([
      { type: "tiled", path: ["first"] },
      { type: "tiled", path: [] },
    ]);
    expect(collapsibleNodePaths(config().root).map(pathKey)).toEqual([
      "root",
      "tiled:first",
    ]);
  });

  test("maps resolver source locators back to managed and tiled node paths", () => {
    expect(nodePathFromSourcePath("root")).toEqual([]);
    expect(nodePathFromSourcePath("root.children.layout.first.child.node")).toEqual([
      { type: "tiled", path: ["first"] },
    ]);
    expect(nodePathFromSourcePath(
      "root.children.layout.second.child.node.children.items[2].node.children.layout.first.second.child.node",
    )).toEqual([
      { type: "tiled", path: ["second"] },
      { type: "managed", index: 2 },
      { type: "tiled", path: ["first", "second"] },
    ]);
    expect(nodePathFromSourcePath("root.children.items[0].node.nope")).toBeNull();
  });
});
