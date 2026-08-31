import { describe, expect, test } from "bun:test";
import type { ResolvedComponentNode } from "../../src/shared/contracts";
import {
  collapsedComponentsStorageKey,
  collectComponentNodeIds,
  countComponentDescendants,
  parseCollapsedComponentIds,
  serializeCollapsedComponentIds,
} from "../../src/renderer/component-view-state";

const leaf: ResolvedComponentNode = {
  id: "chart",
  component: "@dash-bored/chart",
  props: {},
  source: "builtin",
};

const tree: ResolvedComponentNode = {
  id: "dashboard",
  component: "@dash-bored/group",
  props: {},
  children: {
    type: "tiled",
    layout: { type: "child", child: { node: {
      id: "operations",
      component: "@dash-bored/card",
      props: {},
      children: { type: "tiled", layout: { type: "child", child: { node: leaf } } },
      source: "builtin",
    } } },
  },
  source: "builtin",
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
