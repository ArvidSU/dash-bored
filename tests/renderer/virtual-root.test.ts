import { describe, expect, test } from "bun:test";
import type { ResolvedComponentNode } from "../../src/shared/contracts";
import {
  findVirtualRootPath,
  nodeLabel,
  resolveVirtualRoot,
  virtualRootStorageKey,
} from "../../src/renderer/lib/virtual-root";

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
  children: { node: {
          id: "card",
          component: "@dash-bored/card",
          props: { title: "Operations" },
          children: { node: leaf },
          source: "builtin"
      } },
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

  test("retains marked ancestors, marked direct siblings, and original breadcrumbs", () => {
    const navigation: ResolvedComponentNode = {
      id: "navigation",
      component: "@dash-bored/group",
      props: {},
      persistOnFocus: true,
      children: { node: { ...leaf, id: "navigation-child" } },
      source: "builtin",
    };
    const discarded: ResolvedComponentNode = { ...leaf, id: "discarded" };
    const target: ResolvedComponentNode = { ...leaf, id: "target" };
    const skipped: ResolvedComponentNode = {
      id: "skipped",
      component: "@dash-bored/group",
      props: {},
      children: { node: target },
      source: "builtin",
    };
    const persistentRoot: ResolvedComponentNode = {
      ...tree,
      persistOnFocus: true,
      children: [
        { node: navigation, metadata: { tab: "Navigate" } },
        { node: discarded, metadata: { tab: "Discard" } },
        { node: skipped, metadata: { tab: "Target" } },
      ],
    };

    const focused = resolveVirtualRoot(persistentRoot, "target");
    expect(focused.target).toBe(target);
    expect(focused.retainedAncestorIds).toEqual(["root"]);
    expect(focused.crumbs.map((crumb) => crumb.id)).toEqual(["root", "skipped", "target"]);
    expect(focused.node.children).toEqual([
      { node: navigation, metadata: { tab: "Navigate" } },
      { node: target, metadata: { tab: "Target" } },
    ]);
  });

  test("retains nested marked ancestors while skipping unmarked ancestors", () => {
    const inner = {
      ...tree,
      id: "inner",
      persistOnFocus: true,
      children: { node: leaf },
    };
    const middle = { ...tree, id: "middle", children: { node: inner } };
    const root = { ...tree, persistOnFocus: true, children: { node: middle } };
    const focused = resolveVirtualRoot(root, leaf.id);
    expect(focused.retainedAncestorIds).toEqual(["root", "inner"]);
    expect(focused.node.id).toBe("root");
    expect((focused.node.children as { node: ResolvedComponentNode }).node.id).toBe("inner");
  });

  test("prunes tiled siblings, preserves surviving split metadata, and collapses one-sided splits", () => {
    const target = { ...leaf, id: "target" };
    const rail = { ...leaf, id: "rail", persistOnFocus: true };
    const discarded = { ...leaf, id: "discarded" };
    const root: ResolvedComponentNode = {
      ...tree,
      persistOnFocus: true,
      children: {
        axis: "horizontal",
        ratio: 0.3,
        first: { node: rail, metadata: { role: "rail" } },
        second: {
          axis: "vertical",
          first: { node: discarded },
          second: { node: target, metadata: { role: "content" } },
        },
      },
    };
    expect(resolveVirtualRoot(root, "target").node.children).toEqual({
      axis: "horizontal",
      ratio: 0.3,
      first: { node: rail, metadata: { role: "rail" } },
      second: { node: target, metadata: { role: "content" } },
    });
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
