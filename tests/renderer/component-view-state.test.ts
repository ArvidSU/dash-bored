import { describe, expect, test } from "bun:test";
import type { ResolvedComponentNode } from "../../src/shared/contracts";
import {
  collapsedComponentsStorageKey,
  childSelectionsStorageKey,
  collectComponentNodeIds,
  countComponentDescendants,
  parseCollapsedComponentIds,
  parseChildSelections,
  pruneChildSelections,
  serializeChildSelections,
  serializeCollapsedComponentIds,
} from "../../src/renderer/lib/component-view-state";

const leaf: ResolvedComponentNode = {
  id: "chart",
  component: "./components/external/core/chart",
  props: {},
  source: "external",
};

const tree: ResolvedComponentNode = {
  id: "dashboard",
  component: "./components/external/core/group",
  props: {},
  children: { node: {
          id: "operations",
          component: "./components/external/core/card",
          props: {},
          children: { node: leaf },
          source: "external"
      } },
  source: "external",
};

describe("component view state", () => {
  test("isolates persisted collapse state by dashboard config", () => {
    expect(collapsedComponentsStorageKey("/projects/one/dash-bored.yaml"))
      .not.toBe(collapsedComponentsStorageKey("/projects/two/dash-bored.yaml"));
  });

  test("round-trips and sorts collapsed node IDs", () => {
    const parsed = parseCollapsedComponentIds(serializeCollapsedComponentIds(new Set(["z", "a"])));
    expect([...parsed]).toEqual(["a", "z"]);
  });

  test("persists only selections whose container and child still exist", () => {
    const selectable = {
      ...tree,
      manifest: { schemaVersion: 3 as const, apiVersion: "1.0.0", id: "x", name: "X", description: "", entry: "./x", propsSchema: {}, children: { min: 0, presentation: { type: "managed" as const }, select: "single" as const } },
      children: [{ node: leaf }, { node: { ...leaf, id: "other" } }],
    };
    expect(childSelectionsStorageKey("a")).not.toBe(childSelectionsStorageKey("b"));
    const decoded = parseChildSelections(serializeChildSelections({ dashboard: "other", unknown: "missing" }));
    expect(pruneChildSelections(decoded, selectable)).toEqual({ dashboard: "other" });
    expect(parseChildSelections("invalid")).toEqual({});
  });

  test("fails closed for malformed persisted values", () => {
    expect(parseCollapsedComponentIds("not json")).toEqual(new Set());
    expect(parseCollapsedComponentIds(JSON.stringify({ ids: ["dashboard"] }))).toEqual(new Set());
    expect(parseCollapsedComponentIds(JSON.stringify(["dashboard", 4, null, ""]))).toEqual(new Set(["dashboard"]));
  });

  test("counts descendants and collects the complete node set", () => {
    expect(countComponentDescendants(tree)).toBe(2);
    expect(collectComponentNodeIds(tree)).toEqual(new Set(["dashboard", "operations", "chart"]));
  });
});
