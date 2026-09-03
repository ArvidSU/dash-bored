import { describe, expect, test } from "bun:test";
import type {
  ComponentCatalogItem,
  ComponentManifest,
  ComponentNode,
  DashboardConfig,
} from "../../src/shared/contracts";
import { childEdges } from "../../src/renderer/lib/component-children";
import { siblingMoveTarget } from "../../src/renderer/composition/composition-movement";
import { insertNode, moveNode } from "../../src/renderer/composition/dashboard-editor";

function leaf(id: string): ComponentNode {
  return { id, component: "leaf" };
}

function config(children: DashboardConfig["root"]["children"]): DashboardConfig {
  return {
    schemaVersion: 2,
    name: "Movement",
    root: { id: "root", component: "container", children },
  };
}

const containerManifest: ComponentManifest = {
  schemaVersion: 2,
  id: "container",
  name: "Container",
  description: "Managed test container",
  entry: "builtin:container",
  propsSchema: { type: "object" },
  children: {
    min: 0,
    presentation: {
      type: "managed",
    },
    metadataSchema: {
      type: "object",
      properties: { label: { type: "string" } },
    },
  },
};

const catalog: ComponentCatalogItem[] = [
  { reference: "container", source: "builtin", available: true, manifest: containerManifest, diagnostics: [] },
  { reference: "leaf", source: "builtin", available: true, manifest: {
    schemaVersion: 2,
    id: "leaf",
    name: "Leaf",
    description: "Leaf",
    entry: "builtin:leaf",
    propsSchema: { type: "object" },
  }, diagnostics: [] },
];

describe("generic composition movement", () => {
  test("derives adjacent managed targets without encoding a component identity", () => {
    const root = config({
      type: "managed",
      items: [{ node: leaf("one") }, { node: leaf("two") }, { node: leaf("three") }],
    }).root;
    expect(siblingMoveTarget(root, [{ type: "managed", index: 1 }], "previous")).toEqual({
      parentPath: [],
      placement: { type: "managed", index: 0 },
    });
    expect(siblingMoveTarget(root, [{ type: "managed", index: 1 }], "next")).toEqual({
      parentPath: [],
      placement: { type: "managed", index: 3 },
    });
    expect(siblingMoveTarget(root, [{ type: "managed", index: 0 }], "previous")).toBeNull();
    expect(childEdges(root.children).map((edge) => edge.node.id)).toEqual(["one", "two", "three"]);
  });

  test("derives tiled sibling moves on the target leaf axis", () => {
    const root = config({
      type: "tiled",
      layout: {
        type: "split",
        axis: "horizontal",
        ratio: 0.5,
        first: { type: "child", child: { node: leaf("one") } },
        second: {
          type: "split",
          axis: "vertical",
          ratio: 0.5,
          first: { type: "child", child: { node: leaf("two") } },
          second: { type: "child", child: { node: leaf("three") } },
        },
      },
    }).root;
    expect(siblingMoveTarget(root, [{ type: "tiled", path: ["second", "first"] }], "next")).toEqual({
      parentPath: [],
      placement: {
        type: "tiled",
        path: ["second", "second"],
        axis: "vertical",
        position: "second",
      },
    });
  });

  test("moves and inserts edges without losing IDs, props, or managed metadata", () => {
    const original = config({
      type: "managed",
      items: [
        { node: { id: "one", component: "leaf", props: { value: 1 } }, metadata: { label: "One" } },
        { node: { id: "two", component: "leaf", props: { value: 2 } }, metadata: { label: "Two" } },
      ],
    });
    const moved = moveNode(original, [{ type: "managed", index: 1 }], {
      parentPath: [],
      placement: { type: "managed", index: 0, metadata: { label: "Do not replace" } },
    }, catalog);
    expect(childEdges(moved.root.children).map((edge) => ({
      id: edge.node.id,
      props: edge.node.props,
      metadata: edge.metadata,
    }))).toEqual([
      { id: "two", props: { value: 2 }, metadata: { label: "Two" } },
      { id: "one", props: { value: 1 }, metadata: { label: "One" } },
    ]);

    const inserted = insertNode(moved, {
      parentPath: [],
      placement: { type: "managed", index: 1, metadata: { label: "Inserted" } },
    }, { id: "new", component: "leaf", props: { value: 3 } }, catalog);
    expect(childEdges(inserted.root.children).map((edge) => edge.metadata?.label))
      .toEqual(["Two", "Inserted", "One"]);
    expect(childEdges(inserted.root.children)[1]?.node).toEqual({
      id: "new",
      component: "leaf",
      props: { value: 3 },
    });
  });
});
