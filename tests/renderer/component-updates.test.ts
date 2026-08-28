import { describe, expect, test } from "bun:test";
import type { ResolvedComponentNode } from "../../src/shared/contracts";
import {
  changedComponentIds,
  updateStaggerMs,
} from "../../src/renderer/component-updates";

function node(
  id: string,
  component: string,
  props: Record<string, unknown> = {},
  children: ResolvedComponentNode[] = [],
): ResolvedComponentNode {
  return {
    id,
    component,
    props,
    slots: children.length > 0 ? { children } : {},
    source: "builtin",
  };
}

function localNode(id: string, componentId: string): ResolvedComponentNode {
  return {
    ...node(id, `./components/${componentId}`),
    source: "local",
    manifest: {
      schemaVersion: 1,
      id: componentId,
      name: componentId,
      description: `${componentId} test component`,
      entry: "./index.tsx",
      propsSchema: { type: "object" },
    },
  };
}

describe("component update detection", () => {
  test("marks only the component whose own props changed", () => {
    const before = node("root", "@dash-bored/stack", {}, [
      node("card", "@dash-bored/card", { title: "Before" }, [
        node("text", "@dash-bored/text", { content: "Unchanged" }),
      ]),
    ]);
    const after = structuredClone(before);
    after.slots.children![0]!.props.title = "After";

    expect(changedComponentIds(before, after)).toEqual(["card"]);
  });

  test("marks inserted and repositioned components in visual order", () => {
    const before = node("root", "@dash-bored/stack", {}, [
      node("first", "@dash-bored/card"),
      node("second", "@dash-bored/card"),
    ]);
    const after = node("root", "@dash-bored/stack", {}, [
      node("new", "@dash-bored/card"),
      node("first", "@dash-bored/card"),
      node("second", "@dash-bored/card"),
    ]);

    expect(changedComponentIds(before, after)).toEqual(["new", "first", "second"]);
  });

  test("marks the surviving parent when a component is removed", () => {
    const before = node("root", "@dash-bored/stack", {}, [
      node("only", "@dash-bored/card"),
    ]);
    const after = node("root", "@dash-bored/stack");

    expect(changedComponentIds(before, after)).toEqual(["root"]);
  });

  test("treats reordered object keys as semantically unchanged", () => {
    const before = node("card", "@dash-bored/card", {
      title: "Stable",
      detail: { first: true, second: 2 },
    });
    const after = node("card", "@dash-bored/card", {
      detail: { second: 2, first: true },
      title: "Stable",
    });

    expect(changedComponentIds(before, after)).toEqual([]);
  });

  test("marks a stable id when its component is replaced", () => {
    const before = node("main", "@dash-bored/card");
    const after = node("main", "@dash-bored/markdown", { content: "Replacement" });

    expect(changedComponentIds(before, after)).toEqual(["main"]);
  });

  test("marks every mounted instance after its local component successfully reloads", () => {
    const tree = node("root", "@dash-bored/stack", {}, [
      localNode("first-pulse", "project-pulse"),
      localNode("package-scripts", "package-scripts"),
      localNode("second-pulse", "project-pulse"),
    ]);

    expect(changedComponentIds(
      tree,
      structuredClone(tree),
      new Map([
        ["project-pulse", "revision-1"],
        ["package-scripts", "stable"],
      ]),
      new Map([
        ["project-pulse", "revision-2"],
        ["package-scripts", "stable"],
      ]),
    )).toEqual(["first-pulse", "second-pulse"]);
  });

  test("does not mark the initial load of local component code", () => {
    const tree = localNode("project-pulse", "project-pulse");

    expect(changedComponentIds(
      tree,
      structuredClone(tree),
      new Map(),
      new Map([["project-pulse", "revision-1"]]),
    )).toEqual([]);
  });

  test("keeps large update waves bounded", () => {
    expect(updateStaggerMs(0, 30)).toBe(0);
    expect(updateStaggerMs(30, 30)).toBe(180);
  });
});
