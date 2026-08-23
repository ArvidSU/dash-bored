import { describe, expect, test } from "bun:test";
import type { ResolvedComponentNode } from "../../src/shared/contracts";
import {
  findVirtualRootPath,
  resolveVirtualRoot,
  virtualRootStorageKey,
} from "../../src/renderer/virtual-root";

const leaf: ResolvedComponentNode = {
  id: "only-button",
  component: "@dash-bored/command",
  props: { label: "Deploy" },
  slots: {},
  source: "builtin",
};

const tree: ResolvedComponentNode = {
  id: "root",
  component: "@dash-bored/stack",
  props: {},
  slots: {
    children: [{
      id: "card",
      component: "@dash-bored/card",
      props: { title: "Operations" },
      slots: { children: [leaf] },
      source: "builtin",
    }],
  },
  source: "builtin",
};

describe("virtual dashboard roots", () => {
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
