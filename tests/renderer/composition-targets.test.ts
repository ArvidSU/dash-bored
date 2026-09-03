import { describe, expect, test } from "bun:test";
import type {
  ComponentCatalogItem,
  ComponentChildren,
  ComponentManifest,
  ComponentNode,
  DashboardConfig,
  ResolvedComponentNode,
} from "../../src/shared/contracts";
import type { NodePath } from "../../src/renderer/composition/dashboard-editor";
import { createCompositionTargets } from "../../src/renderer/composition/composition-targets";
import type { CompositionDragPayload } from "../../src/renderer/composition/composition-context";

const GROUP = "@dash-bored/group";
const TABS = "@dash-bored/tabs";
const LEAF = "@dash-bored/leaf";
const CONDITIONAL = "@dash-bored/conditional";

function manifest(
  id: string,
  name: string,
  children?: ComponentManifest["children"],
): ComponentManifest {
  return {
    schemaVersion: 2,
    id,
    name,
    description: `${name} test manifest`,
    entry: `builtin:${name.toLowerCase()}`,
    propsSchema: { type: "object" },
    ...(children ? { children } : {}),
  };
}

const groupManifest = manifest(GROUP, "Group", {
  min: 0,
  presentation: { type: "tiled", axes: "both" },
});
const tabsManifest = manifest(TABS, "Tabs", {
  min: 1,
  presentation: { type: "managed" },
  metadataSchema: {
    type: "object",
    properties: { label: { type: "string", minLength: 1 } },
    required: ["label"],
  },
});
const leafManifest = manifest(LEAF, "Status");
const conditionalManifest = manifest(CONDITIONAL, "Conditional", {
  min: 1,
  max: 1,
  presentation: { type: "tiled", axes: "both" },
});

function catalogItem(reference: string, itemManifest: ComponentManifest): ComponentCatalogItem {
  return { reference, source: "builtin", available: true, manifest: itemManifest, diagnostics: [] };
}

const catalog = [
  catalogItem(GROUP, groupManifest),
  catalogItem(TABS, tabsManifest),
  catalogItem(LEAF, leafManifest),
  catalogItem(CONDITIONAL, conditionalManifest),
];

function resolved(
  id: string,
  component: string,
  children?: ComponentChildren<ResolvedComponentNode>,
): ResolvedComponentNode {
  return { id, component, props: {}, source: "builtin", ...(children ? { children } : {}) };
}

function configWithRoot(root: ComponentNode): DashboardConfig {
  return { schemaVersion: 2, name: "test", root };
}

const leafPayload: CompositionDragPayload = { type: "component", reference: LEAF };

// Root group with an empty Tabs beside a leaf: the Tabs frame is the
// drop-into-container case that previously offered only sibling edges.
const tabsPath: NodePath = [{ type: "tiled", path: ["first"] }];
const configA = configWithRoot({
  id: "root",
  component: GROUP,
  children: {
    type: "tiled",
    layout: {
      type: "split",
      axis: "horizontal",
      ratio: 0.5,
      first: { type: "child", child: { node: { id: "tabs", component: TABS } } },
      second: { type: "child", child: { node: { id: "leaf", component: LEAF } } },
    },
  },
});
const tabsResolved = resolved("tabs", TABS);
const leafResolved = resolved("leaf", LEAF);
const rootResolvedA = resolved("root", GROUP, {
  type: "tiled",
  layout: {
    type: "split",
    axis: "horizontal",
    ratio: 0.5,
    first: { type: "child", child: { node: tabsResolved } },
    second: { type: "child", child: { node: leafResolved } },
  },
});

function targetsFor(config: DashboardConfig, previewTree: ResolvedComponentNode) {
  return createCompositionTargets({
    config,
    catalog,
    previewTree,
    owningConfigPath: null,
    dragging: null,
  });
}

describe("drop-inside container targets", () => {
  test("an empty container offers an inside zone alongside sibling edges", () => {
    const targets = targetsFor(configA, rootResolvedA);
    const zones = targets.dropZonesForNode(tabsResolved, leafPayload);
    expect(zones.map((zone) => zone.side).sort()).toEqual(
      ["bottom", "inside", "left", "right", "top"],
    );
    const inside = zones.filter((zone) => zone.side === "inside");
    expect(inside).toHaveLength(1);
    expect(inside[0]!.target).toMatchObject({
      parentPath: tabsPath,
      placement: { type: "managed", index: 0 },
    });
    expect(inside[0]!.label).toBe("Add inside Tabs");
  });

  test("centered pointer resolves inside while edges tile beside the container", () => {
    const targets = targetsFor(configA, rootResolvedA);
    expect(targets.pointerDropZoneForNode(tabsResolved, 0.5, 0.5, leafPayload)?.side)
      .toBe("inside");
    expect(targets.pointerDropZoneForNode(tabsResolved, 0.05, 0.5, leafPayload)?.side)
      .toBe("left");
    expect(targets.pointerDropZoneForNode(tabsResolved, 0.95, 0.5, leafPayload)?.side)
      .toBe("right");
    expect(targets.pointerDropZoneForNode(tabsResolved, 0.5, 0.02, leafPayload)?.side)
      .toBe("top");
    expect(targets.pointerDropZoneForNode(tabsResolved, 0.5, 0.98, leafPayload)?.side)
      .toBe("bottom");
  });

  test("a leaf offers no inside zone even at its center", () => {
    const targets = targetsFor(configA, rootResolvedA);
    const zones = targets.dropZonesForNode(leafResolved, leafPayload);
    expect(zones.length).toBeGreaterThan(0);
    expect(zones.some((zone) => zone.side === "inside")).toBe(false);
    const center = targets.pointerDropZoneForNode(leafResolved, 0.5, 0.5, leafPayload);
    expect(center).not.toBeNull();
    expect(center!.side).not.toBe("inside");
  });

  test("a full container offers no inside zone", () => {
    const conditionalNode: ComponentNode = {
      id: "conditional",
      component: CONDITIONAL,
      children: { type: "tiled", layout: { type: "child", child: { node: { id: "only", component: LEAF } } } },
    };
    const config = configWithRoot({
      id: "root",
      component: GROUP,
      children: { type: "tiled", layout: { type: "child", child: { node: conditionalNode } } },
    });
    const conditionalResolved = resolved("conditional", CONDITIONAL);
    const targets = targetsFor(config, resolved("root", GROUP));
    const zones = targets.dropZonesForNode(conditionalResolved, leafPayload);
    expect(zones.some((zone) => zone.side === "inside")).toBe(false);
    const center = targets.pointerDropZoneForNode(conditionalResolved, 0.5, 0.5, leafPayload);
    expect(center).not.toBeNull();
    expect(center!.side).not.toBe("inside");
  });

  test("center drops append to a non-empty managed container", () => {
    const tabsWithChild: ComponentNode = {
      id: "tabs",
      component: TABS,
      children: { type: "managed", items: [{ node: { id: "one", component: LEAF } }] },
    };
    const config = configWithRoot({
      id: "root",
      component: GROUP,
      children: {
        type: "tiled",
        layout: {
          type: "split",
          axis: "horizontal",
          ratio: 0.5,
          first: { type: "child", child: { node: tabsWithChild } },
          second: { type: "child", child: { node: { id: "leaf", component: LEAF } } },
        },
      },
    });
    const targets = targetsFor(config, resolved("root", GROUP));
    const zones = targets.dropZonesForNode(resolved("tabs", TABS), leafPayload);
    expect(zones.filter((zone) => zone.side === "inside")).toHaveLength(2);
    const center = targets.pointerDropZoneForNode(resolved("tabs", TABS), 0.5, 0.5, leafPayload);
    expect(center?.side).toBe("inside");
    expect(center?.target).toMatchObject({
      parentPath: tabsPath,
      placement: { type: "managed", index: 1 },
    });
  });

  test("a node cannot be moved inside its own subtree", () => {
    const targets = targetsFor(configA, rootResolvedA);
    const payload: CompositionDragPayload = { type: "node", path: tabsPath };
    const zones = targets.dropZonesForNode(tabsResolved, payload);
    expect(zones.some((zone) => zone.side === "inside")).toBe(false);
  });

  test("an empty root keeps its position-independent inside target", () => {
    const config = configWithRoot({ id: "root", component: GROUP });
    const rootResolved = resolved("root", GROUP);
    const targets = targetsFor(config, rootResolved);
    const zones = targets.dropZonesForNode(rootResolved, leafPayload);
    expect(zones.map((zone) => zone.side)).toEqual(["inside"]);
    expect(targets.pointerDropZoneForNode(rootResolved, 0.02, 0.5, leafPayload)?.side)
      .toBe("inside");
    expect(targets.pointerDropZoneForNode(rootResolved, 0.5, 0.5, leafPayload)?.side)
      .toBe("inside");
  });
});
