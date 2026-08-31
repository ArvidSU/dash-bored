import { describe, expect, test } from "bun:test";
import type { ResolvedComponentNode } from "../../src/shared/contracts";
import {
  findVirtualRootPath,
  nodeLabel,
  resolveVirtualRoot,
  virtualRootStorageKey,
} from "../../src/renderer/virtual-root";

const leaf: ResolvedComponentNode = {
  id: "only-button",
  component: "@dash-bored/command",
  props: { label: "Deploy" },
  source: "builtin",
};

const tree: ResolvedComponentNode = {
  id: "root",
  component: "@dash-bored/group",
  props: {},
  children: {
    type: "tiled",
    layout: { type: "child", child: { node: {
      id: "card",
      component: "@dash-bored/card",
      props: { title: "Operations" },
      children: { type: "tiled", layout: { type: "child", child: { node: leaf } } },
      source: "builtin",
    } } },
  },
  source: "builtin",
};

describe("virtual dashboard roots", () => {
  test("uses readable component props for sidebar and breadcrumb labels", () => {
    expect(nodeLabel(tree, true)).toBe("Dashboard");
    expect(nodeLabel({ ...leaf, props: { label: "Deploy API" } }, false)).toBe("Deploy API");
    expect(nodeLabel({ ...leaf, props: {} }, false)).toBe("command");
  });

  test("finds any nested component and builds human-readable breadcrumbs", () => {
    const path = findVirtualRootPath(tree, "only-button");
    expect(path?.map(({ id, label }) => ({ id, label }))).toEqual([
      { id: "root", label: "Dashboard" },
      { id: "card", label: "Operations" },
      { id: "only-button", label: "Deploy" },
    ]);
  });

  test("uses a component as the rendered root and falls back after it disappears", () => {
    expect(resolveVirtualRoot(tree, "only-button").node).toBe(leaf);
    const fallback = resolveVirtualRoot(tree, "removed-node");
    expect(fallback.node).toBe(tree);
    expect(fallback.crumbs.map((crumb) => crumb.id)).toEqual(["root"]);
  });

  test("accepts a leaf component as the dashboard's actual root", () => {
    const resolved = resolveVirtualRoot(leaf, null);
    expect(resolved.node).toBe(leaf);
    expect(resolved.crumbs.map(({ id, label }) => ({ id, label }))).toEqual([
      { id: "only-button", label: "Dashboard" },
    ]);
  });

  test("keeps persisted focus isolated per project", () => {
    expect(virtualRootStorageKey("/projects/one")).not.toBe(
      virtualRootStorageKey("/projects/two"),
    );
  });
});
