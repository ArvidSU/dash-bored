import { describe, expect, test } from "bun:test";
import type {
  ComponentCatalogItem,
  ComponentManifest,
  ComponentNode,
  DashboardConfig,
} from "../../src/shared/contracts";
import { childEdges } from "../../src/renderer/component-children";
import {
  canPlanCompositionOperation,
  planCompositionOperation,
  type CompositionOperationRequest,
} from "../../src/renderer/composition-operation";

function manifest(id: string, children?: ComponentManifest["children"]): ComponentManifest {
  return {
    schemaVersion: 2,
    id,
    name: id,
    description: `${id} fixture`,
    entry: `builtin:${id}`,
    propsSchema: { type: "object", additionalProperties: true },
    ...(children ? { children } : {}),
  };
}

const catalog: ComponentCatalogItem[] = [
  manifest("group", { min: 0, presentation: { type: "tiled", axes: "both" } }),
  manifest("horizontal", { min: 0, presentation: { type: "tiled", axes: "horizontal" } }),
  manifest("limited", { min: 0, max: 1, presentation: { type: "tiled", axes: "both" } }),
  manifest("tabs", { min: 0, presentation: { type: "managed" } }),
  manifest("text"),
].map((entry) => ({
  reference: entry.id,
  source: "builtin" as const,
  available: true,
  manifest: entry,
  diagnostics: [],
}));

function leaf(id: string): ComponentNode {
  return { id, component: "text", props: { label: id } };
}

function tiledConfig(rootComponent = "group"): DashboardConfig {
  return {
    schemaVersion: 2,
    name: "Planner fixture",
    root: {
      id: "root",
      component: rootComponent,
      children: {
        type: "tiled",
        layout: {
          type: "split",
          axis: "horizontal",
          ratio: 0.5,
          first: { type: "child", child: { node: leaf("first") } },
          second: { type: "child", child: { node: leaf("second") } },
        },
      },
    },
  };
}

describe("composition operation planner", () => {
  test("uses the same plan for UI eligibility and the applied component insertion", () => {
    const config = tiledConfig();
    const request: CompositionOperationRequest = {
      config,
      catalog,
      payload: { type: "component" as const, reference: "text", props: { label: "Inserted" } },
      target: {
        parentPath: [],
        placement: { type: "tiled" as const, path: ["second"], axis: "vertical" as const, position: "first" as const },
      },
    };
    const planned = planCompositionOperation(request);
    expect(canPlanCompositionOperation(request)).toBe(planned.status === "planned");
    if (planned.status !== "planned") throw new Error(planned.message);
    expect(planned.kind).toBe("insert");
    expect(childEdges(planned.nextConfig.root.children).map((edge) => edge.node)).toContainEqual({
      id: "text",
      component: "text",
      props: { label: "Inserted" },
    });
    expect(childEdges(config.root.children).map((edge) => edge.node.id)).toEqual(["first", "second"]);
  });

  test("plans root replacement through the same contract and preserves compatible children", () => {
    const request = {
      config: tiledConfig(),
      catalog,
      payload: { type: "component" as const, reference: "group", props: { title: "New root" } },
      target: { type: "root-replacement" as const, path: [] as [] },
    };
    const planned = planCompositionOperation(request);
    expect(canPlanCompositionOperation(request)).toBe(true);
    if (planned.status !== "planned") throw new Error(planned.message);
    expect(planned.kind).toBe("replace-root");
    expect(planned.nextConfig.root).toMatchObject({
      id: "root",
      component: "group",
      props: { title: "New root" },
    });
    expect(childEdges(planned.nextConfig.root.children).map((edge) => edge.node.id)).toEqual(["first", "second"]);
  });

  test("moves existing edges without losing IDs, props, or managed metadata", () => {
    const config: DashboardConfig = {
      schemaVersion: 2,
      name: "Managed",
      root: {
        id: "tabs",
        component: "tabs",
        children: {
          type: "managed",
          items: [
            { node: { id: "one", component: "text", props: { value: 1 } }, metadata: { label: "One" } },
            { node: { id: "two", component: "text", props: { value: 2 } }, metadata: { label: "Two" } },
          ],
        },
      },
    };
    const planned = planCompositionOperation({
      config,
      catalog,
      payload: { type: "node", path: [{ type: "managed", index: 1 }] },
      target: { parentPath: [], placement: { type: "managed", index: 0 } },
    });
    if (planned.status !== "planned") throw new Error(planned.message);
    expect(planned.kind).toBe("move");
    expect(childEdges(planned.nextConfig.root.children).map((edge) => ({
      id: edge.node.id,
      props: edge.node.props,
      metadata: edge.metadata,
    }))).toEqual([
      { id: "two", props: { value: 2 }, metadata: { label: "Two" } },
      { id: "one", props: { value: 1 }, metadata: { label: "One" } },
    ]);
  });

  test("fails closed for stale paths, root moves, descendants, and invalid child contracts", () => {
    const stale = planCompositionOperation({
      config: tiledConfig(),
      catalog,
      payload: { type: "component", reference: "text" },
      target: { parentPath: [{ type: "managed", index: 4 }], placement: { type: "managed", index: 0 } },
    });
    expect(stale).toMatchObject({ status: "rejected", reason: "constraint" });

    const rootMove = planCompositionOperation({
      config: tiledConfig(), catalog,
      payload: { type: "node", path: [] },
      target: { parentPath: [], placement: { type: "tiled", path: ["first"], axis: "horizontal", position: "first" } },
    });
    expect(rootMove).toMatchObject({ status: "rejected", reason: "root-move" });

    const descendantMove = planCompositionOperation({
      config: {
        ...tiledConfig(),
        root: {
          id: "root",
          component: "group",
          children: { type: "tiled", layout: { type: "child", child: { node: {
            id: "parent", component: "group",
            children: { type: "tiled", layout: { type: "child", child: { node: leaf("child") } } },
          } } } },
        },
      },
      catalog,
      payload: { type: "node", path: [{ type: "tiled", path: [] }] },
      target: {
        parentPath: [{ type: "tiled", path: [] }],
        placement: { type: "tiled", path: [], axis: "horizontal", position: "first" },
      },
    });
    expect(descendantMove).toMatchObject({ status: "rejected", reason: "own-descendant" });

    const invalidAxis = planCompositionOperation({
      config: tiledConfig("horizontal"), catalog,
      payload: { type: "component", reference: "text" },
      target: { parentPath: [], placement: { type: "tiled", path: ["first"], axis: "vertical", position: "first" } },
    });
    expect(invalidAxis).toMatchObject({ status: "rejected", reason: "constraint" });

    const invalidCardinality = planCompositionOperation({
      config: tiledConfig("limited"), catalog,
      payload: { type: "component", reference: "text" },
      target: { parentPath: [], placement: { type: "tiled", path: ["first"], axis: "horizontal", position: "first" } },
    });
    expect(invalidCardinality).toMatchObject({ status: "rejected", reason: "constraint" });

    const invalidPresentation = planCompositionOperation({
      config: tiledConfig("tabs"), catalog,
      payload: { type: "component", reference: "text" },
      target: { parentPath: [], placement: { type: "tiled", path: ["first"], axis: "horizontal", position: "first" } },
    });
    expect(invalidPresentation).toMatchObject({ status: "rejected", reason: "constraint" });
  });
});
