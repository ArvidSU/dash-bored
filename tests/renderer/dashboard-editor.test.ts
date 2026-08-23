import { describe, expect, test } from "bun:test";
import type {
  ComponentCatalogItem,
  ComponentManifest,
  DashboardConfig,
} from "../../src/shared/contracts";
import {
  countNodes,
  countDiscardedRootNodes,
  createNode,
  insertNode,
  moveNode,
  removeNode,
  renameTab,
  replaceRoot,
  slotChildren,
  tabLabels,
  updateNodeProps,
} from "../../src/renderer/dashboard-editor";

function manifest(
  id: string,
  slots?: ComponentManifest["slots"],
): ComponentManifest {
  return {
    schemaVersion: 1,
    id,
    name: id,
    description: `${id} component`,
    entry: `builtin:${id}`,
    propsSchema: { type: "object", additionalProperties: true },
    ...(slots ? { slots } : {}),
  };
}

const catalog: ComponentCatalogItem[] = [
  manifest("stack", { children: { multiple: true } }),
  manifest("card", { children: { multiple: true } }),
  manifest("split", {
    first: { required: true },
    second: { required: true },
  }),
  manifest("@dash-bored/tabs", { children: { required: true, multiple: true } }),
  manifest("text"),
].map((value) => ({
  reference: value.id,
  source: "builtin",
  available: true,
  manifest: value,
  diagnostics: [],
}));

function config(): DashboardConfig {
  return {
    schemaVersion: 1,
    name: "Editor",
    root: {
      component: "stack",
      slots: {
        children: [
          {
            id: "card",
            component: "card",
            slots: {
              children: [{ id: "nested", component: "text", props: { content: "Nested" } }],
            },
          },
          { id: "second", component: "text", props: { content: "Second" } },
        ],
      },
    },
  };
}

describe("dashboard editor tree operations", () => {
  test("reorders siblings and moves nodes across nested multi-slots", () => {
    const reordered = moveNode(
      config(),
      [{ slot: "children", index: 0 }],
      { parentPath: [], slot: "children", index: 2 },
      catalog,
    );
    expect(slotChildren(reordered.root, "children").map((node) => node.id)).toEqual([
      "second",
      "card",
    ]);

    const nested = moveNode(
      reordered,
      [{ slot: "children", index: 0 }],
      {
        parentPath: [{ slot: "children", index: 1 }],
        slot: "children",
        index: 1,
      },
      catalog,
    );
    expect(slotChildren(nested.root, "children").map((node) => node.id)).toEqual(["card"]);
    expect(slotChildren(slotChildren(nested.root, "children")[0]!, "children").map((node) => node.id)).toEqual([
      "nested",
      "second",
    ]);
  });

  test("rejects cycles, root moves, and occupied single-child slots", () => {
    expect(() => moveNode(
      config(),
      [{ slot: "children", index: 0 }],
      {
        parentPath: [{ slot: "children", index: 0 }],
        slot: "children",
        index: 1,
      },
      catalog,
    )).toThrow("descendants");
    expect(() => moveNode(config(), [], { parentPath: [], slot: "children", index: 0 }, catalog)).toThrow("root");

    const split: DashboardConfig = {
      schemaVersion: 1,
      name: "Split",
      root: {
        component: "split",
        slots: {
          first: { id: "first", component: "text" },
          second: { id: "second", component: "text" },
        },
      },
    };
    expect(() => moveNode(
      split,
      [{ slot: "first", index: 0 }],
      { parentPath: [], slot: "second", index: 1 },
      catalog,
    )).toThrow("already contains");
  });

  test("adds stable unique ids, updates props, and removes complete subtrees", () => {
    const textItem = catalog.find((item) => item.reference === "text")!;
    const first = createNode(config(), textItem, { content: "Added" });
    expect(first.id).toBe("text");
    const withFirst = insertNode(config(), { parentPath: [], slot: "children", index: 2 }, first, catalog);
    const second = createNode(withFirst, textItem, { content: "Again" });
    expect(second.id).toBe("text-2");

    const updated = updateNodeProps(
      withFirst,
      [{ slot: "children", index: 2 }],
      { content: "Updated" },
    );
    expect(slotChildren(updated.root, "children")[2]?.props).toEqual({ content: "Updated" });
    expect(countNodes(slotChildren(updated.root, "children")[0]!)).toBe(2);

    const removed = removeNode(updated, [{ slot: "children", index: 0 }], catalog);
    expect(slotChildren(removed.root, "children").map((node) => node.id)).toEqual(["second", "text"]);
  });

  test("replaces the root with any available component and carries compatible children", () => {
    const textItem = catalog.find((item) => item.reference === "text")!;
    const textRoot = replaceRoot(config(), textItem, { content: "Dashboard root" });
    expect(textRoot.root.component).toBe("text");
    expect(textRoot.root.props).toEqual({ content: "Dashboard root" });
    expect(textRoot.root.slots).toBeUndefined();
    expect(countDiscardedRootNodes(config(), textItem)).toBe(3);

    const cardItem = catalog.find((item) => item.reference === "card")!;
    const cardRoot = replaceRoot(config(), cardItem, { title: "New root" });
    expect(cardRoot.root.component).toBe("card");
    expect(slotChildren(cardRoot.root, "children").map((node) => node.id)).toEqual(["card", "second"]);
    expect(countDiscardedRootNodes(config(), cardItem)).toBe(0);
  });

  test("keeps tab names aligned while adding, renaming, reordering, and removing tabs", () => {
    const tabs: DashboardConfig = {
      schemaVersion: 1,
      name: "Tabs",
      root: {
        id: "tabs",
        component: "@dash-bored/tabs",
        props: { labels: ["Overview", "Logs"] },
        slots: {
          children: [
            { id: "overview", component: "text" },
            { id: "logs", component: "text" },
          ],
        },
      },
    };
    const added = insertNode(tabs, { parentPath: [], slot: "children", index: 1 }, { id: "settings", component: "text" }, catalog);
    expect(tabLabels(added.root)).toEqual(["Overview", "Tab 2", "Logs"]);

    const renamed = renameTab(added, [], 1, "Settings");
    expect(tabLabels(renamed.root)).toEqual(["Overview", "Settings", "Logs"]);

    const moved = moveNode(renamed, [{ slot: "children", index: 0 }], { parentPath: [], slot: "children", index: 3 }, catalog);
    expect(slotChildren(moved.root, "children").map((node) => node.id)).toEqual(["settings", "logs", "overview"]);
    expect(tabLabels(moved.root)).toEqual(["Settings", "Logs", "Overview"]);

    const removed = removeNode(moved, [{ slot: "children", index: 1 }], catalog);
    expect(slotChildren(removed.root, "children").map((node) => node.id)).toEqual(["settings", "overview"]);
    expect(tabLabels(removed.root)).toEqual(["Settings", "Overview"]);
  });
});
