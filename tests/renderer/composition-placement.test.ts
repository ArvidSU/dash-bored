import { describe, expect, test } from "bun:test";
import type {
  ComponentChildLayout,
  ComponentManifest,
  ComponentNode,
} from "../../src/shared/contracts";
import {
  deriveCompositionPlacementTargets,
  deriveInsertionTargets,
  deriveRootReplacementTarget,
  inferTiledDirection,
  resolvePointerInsertionTarget,
} from "../../src/renderer/composition/composition-placement";

function manifest(
  children?: ComponentManifest["children"],
): ComponentManifest {
  return {
    schemaVersion: 2,
    id: "container",
    name: "Container",
    description: "Generic test container",
    entry: "builtin:container",
    propsSchema: { type: "object" },
    ...(children ? { children } : {}),
  };
}

function leaf(id: string): ComponentNode {
  return { id, component: "leaf" };
}

function tiledLayout(): ComponentChildLayout {
  return {
    type: "split",
    axis: "horizontal",
    ratio: 0.4,
    first: { type: "child", child: { node: leaf("first") } },
    second: {
      type: "split",
      axis: "vertical",
      ratio: 0.6,
      first: { type: "child", child: { node: leaf("top") } },
      second: { type: "child", child: { node: leaf("bottom") } },
    },
  };
}

describe("generic composition placement", () => {
  test("offers one deterministic empty tiled boundary and rejects full parents", () => {
    const target = { id: "empty", component: "container" };
    const both = manifest({ min: 1, max: 2, presentation: { type: "tiled", axes: "both" } });
    expect(deriveInsertionTargets({
      target,
      manifest: both,
      parentPath: [{ type: "managed", index: 2 }],
      currentChildCount: 0,
    })).toEqual([{
      parentPath: [{ type: "managed", index: 2 }],
      placement: { type: "tiled", path: [], axis: "horizontal", position: "first" },
    }]);

    const full: ComponentNode = {
      ...target,
      children: { type: "tiled", layout: { type: "child", child: { node: leaf("only") } } },
    };
    expect(deriveInsertionTargets({
      target: full,
      manifest: manifest({ min: 0, max: 1, presentation: { type: "tiled", axes: "both" } }),
      currentChildCount: 1,
    })).toEqual([]);
  });

  test("derives horizontal and vertical placements around an exact tiled child", () => {
    const target: ComponentNode = {
      id: "tiles",
      component: "container",
      children: { type: "tiled", layout: tiledLayout() },
    };
    const targets = deriveInsertionTargets({
      target,
      manifest: manifest({ min: 0, presentation: { type: "tiled", axes: "both" } }),
      currentChildCount: 3,
      targetChildPath: ["second", "first"],
    });
    expect(targets.map(({ placement }) => placement)).toEqual([
      { type: "tiled", path: ["second", "first"], axis: "horizontal", position: "first" },
      { type: "tiled", path: ["second", "first"], axis: "horizontal", position: "second" },
      { type: "tiled", path: ["second", "first"], axis: "vertical", position: "first" },
      { type: "tiled", path: ["second", "first"], axis: "vertical", position: "second" },
    ]);
  });

  test("limits tiled targets to the declared axis", () => {
    const target: ComponentNode = {
      id: "tiles",
      component: "container",
      children: { type: "tiled", layout: tiledLayout() },
    };
    const horizontal = deriveInsertionTargets({
      target,
      manifest: manifest({ min: 0, presentation: { type: "tiled", axes: "horizontal" } }),
      currentChildCount: 3,
      targetChildPath: { type: "tiled", path: ["first"] },
    });
    expect(horizontal.map(({ placement }) => placement.type === "tiled" && placement.axis))
      .toEqual(["horizontal", "horizontal"]);
  });

  test("derives every managed boundary or the two positions around one child", () => {
    const target: ComponentNode = {
      id: "managed",
      component: "container",
      children: {
        type: "managed",
        items: [{ node: leaf("one") }, { node: leaf("two"), metadata: { label: "Two" } }],
      },
    };
    const managed = manifest({ min: 1, max: 4, presentation: { type: "managed" } });
    expect(deriveInsertionTargets({ target, manifest: managed, currentChildCount: 2 })
      .map(({ placement }) => placement)).toEqual([
      { type: "managed", index: 0 },
      { type: "managed", index: 1 },
      { type: "managed", index: 2 },
    ]);
    expect(deriveInsertionTargets({
      target,
      manifest: managed,
      currentChildCount: 2,
      targetChildPath: { type: "managed", index: 1 },
    }).map(({ placement }) => placement)).toEqual([
      { type: "managed", index: 1 },
      { type: "managed", index: 2 },
    ]);
  });

  test("exposes root replacement separately from child insertion", () => {
    expect(deriveRootReplacementTarget([])).toEqual({ type: "root-replacement", path: [] });
    expect(deriveRootReplacementTarget([{ type: "managed", index: 0 }])).toBeNull();
    expect(deriveCompositionPlacementTargets({
      target: { id: "root", component: "leaf" },
      manifest: manifest(),
      parentPath: [],
      currentChildCount: 0,
    })).toEqual([{ type: "root-replacement", path: [] }]);
  });

  test("infers pointer direction and resolves it to an explicit compatible target", () => {
    expect(inferTiledDirection(0.9, 0.45, "both"))
      .toEqual({ axis: "horizontal", position: "second" });
    expect(inferTiledDirection(0.45, 0.05, "vertical"))
      .toEqual({ axis: "vertical", position: "first" });
    expect(inferTiledDirection(-0.1, 0.5, "both")).toBeNull();

    const target: ComponentNode = {
      id: "tiles",
      component: "container",
      children: { type: "tiled", layout: tiledLayout() },
    };
    expect(resolvePointerInsertionTarget({
      target,
      manifest: manifest({ min: 0, presentation: { type: "tiled", axes: "both" } }),
      currentChildCount: 3,
      targetChildPath: ["first"],
    }, 0.45, 0.95)).toEqual({
      parentPath: [],
      placement: { type: "tiled", path: ["first"], axis: "vertical", position: "second" },
    });
  });

  test("resolves managed pointer drops to generic before and after boundaries", () => {
    const target: ComponentNode = {
      id: "managed",
      component: "container",
      children: { type: "managed", items: [{ node: leaf("one") }, { node: leaf("two") }] },
    };
    const children = manifest({ min: 0, presentation: { type: "managed" } });
    expect(resolvePointerInsertionTarget({
      target,
      manifest: children,
      currentChildCount: 2,
      targetChildPath: { type: "managed", index: 1 },
    }, 0.2, 0.5)).toEqual({
      parentPath: [],
      placement: { type: "managed", index: 1 },
    });
    expect(resolvePointerInsertionTarget({
      target,
      manifest: children,
      currentChildCount: 2,
      targetChildPath: { type: "managed", index: 1 },
    }, 0.8, 0.5)).toEqual({
      parentPath: [],
      placement: { type: "managed", index: 2 },
    });
    expect(resolvePointerInsertionTarget({
      target,
      manifest: children,
      currentChildCount: 2,
      targetChildPath: { type: "managed", index: 1 },
    }, Number.NaN, 0.5)).toBeNull();
  });

  test("fails closed for stale counts, invalid paths, presentation mismatches, and childless manifests", () => {
    const tiled: ComponentNode = {
      id: "tiles",
      component: "container",
      children: { type: "tiled", layout: tiledLayout() },
    };
    const both = manifest({ min: 0, presentation: { type: "tiled", axes: "both" } });
    expect(deriveInsertionTargets({ target: tiled, manifest: both, currentChildCount: 2 })).toEqual([]);
    expect(deriveInsertionTargets({
      target: tiled,
      manifest: both,
      currentChildCount: 3,
      targetChildPath: ["first", "second"],
    })).toEqual([]);
    expect(deriveInsertionTargets({
      target: tiled,
      manifest: manifest({ min: 0, presentation: { type: "managed" } }),
      currentChildCount: 3,
    })).toEqual([]);
    expect(deriveInsertionTargets({ target: tiled, manifest: manifest(), currentChildCount: 3 }))
      .toEqual([]);
    expect(deriveInsertionTargets({ target: tiled, manifest: null, currentChildCount: 3 }))
      .toEqual([]);
  });
});
