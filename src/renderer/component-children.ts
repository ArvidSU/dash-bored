import type {
  ComponentChildEdge,
  ComponentChildLayout,
  ComponentChildren,
  ComponentNode,
  ResolvedComponentNode,
} from "../shared/contracts";

export type LayoutBranch = "first" | "second";

export interface ManagedChildLocator {
  type: "managed";
  index: number;
}

export interface TiledChildLocator {
  type: "tiled";
  path: LayoutBranch[];
}

export type ChildLocator = ManagedChildLocator | TiledChildLocator;
export type ComponentPath = ChildLocator[];

export function layoutEdges<Node>(
  layout: ComponentChildLayout<Node>,
): ComponentChildEdge<Node>[] {
  if (layout.type === "child") return [layout.child];
  return [...layoutEdges(layout.first), ...layoutEdges(layout.second)];
}

export function childEdges<Node>(
  children: ComponentChildren<Node> | undefined,
): ComponentChildEdge<Node>[] {
  if (!children) return [];
  return children.type === "managed"
    ? children.items
    : layoutEdges(children.layout);
}

export function childNodes<Node extends ComponentNode | ResolvedComponentNode>(
  node: Node,
): Node[] {
  return childEdges(node.children as ComponentChildren<Node> | undefined).map((edge) => edge.node);
}

export function visitChildLayout<Node>(
  layout: ComponentChildLayout<Node>,
  visit: (edge: ComponentChildEdge<Node>, path: readonly LayoutBranch[]) => void,
  path: readonly LayoutBranch[] = [],
): void {
  if (layout.type === "child") {
    visit(layout.child, path);
    return;
  }
  visitChildLayout(layout.first, visit, [...path, "first"]);
  visitChildLayout(layout.second, visit, [...path, "second"]);
}

export function edgeAtLayoutPath<Node>(
  layout: ComponentChildLayout<Node>,
  path: readonly LayoutBranch[],
): ComponentChildEdge<Node> {
  let branch = layout;
  for (const segment of path) {
    if (branch.type !== "split") {
      throw new Error("The dashboard changed while an edit action was in progress.");
    }
    branch = branch[segment];
  }
  if (branch.type !== "child") {
    throw new Error("The selected tile is no longer a component.");
  }
  return branch.child;
}

export function edgeAtLocator<Node>(
  children: ComponentChildren<Node> | undefined,
  locator: ChildLocator,
): ComponentChildEdge<Node> {
  if (!children || children.type !== locator.type) {
    throw new Error("The component's child presentation changed while editing.");
  }
  if (locator.type === "managed") {
    if (children.type !== "managed") throw new Error("The child presentation changed.");
    const edge = children.items[locator.index];
    if (!edge) throw new Error("The child no longer exists.");
    return edge;
  }
  if (children.type !== "tiled") throw new Error("The child presentation changed.");
  return edgeAtLayoutPath(children.layout, locator.path);
}

export function childLocators<Node>(
  children: ComponentChildren<Node> | undefined,
): ChildLocator[] {
  if (!children) return [];
  if (children.type === "managed") {
    return children.items.map((_, index) => ({ type: "managed", index }));
  }
  const paths: TiledChildLocator[] = [];
  visitChildLayout(children.layout, (_edge, path) => {
    paths.push({ type: "tiled", path: [...path] });
  });
  return paths;
}

export function locatorKey(locator: ChildLocator): string {
  return locator.type === "managed"
    ? `managed:${locator.index}`
    : `tiled:${locator.path.join(".") || "child"}`;
}

export function componentPathKey(path: ComponentPath): string {
  return path.length === 0 ? "root" : path.map(locatorKey).join("/");
}

export function layoutBranchKey(
  nodeId: string,
  path: readonly LayoutBranch[],
): string {
  return `${nodeId}:${path.join(".") || "root"}`;
}

function nodeStructureKey<Node extends { id?: string }>(node: Node): string {
  const candidate = node as Node & {
    component?: string;
    children?: ComponentChildren<Node>;
  };
  const children = candidate.children;
  if (!children) return `node:${candidate.id ?? "anonymous"}:${candidate.component ?? ""}`;
  if (children.type === "managed") {
    return `node:${candidate.id ?? "anonymous"}:${candidate.component ?? ""}:managed:${children.items
      .map((edge) => `${edge.node.id ?? "anonymous"}:${nodeStructureKey(edge.node)}`)
      .join(",")}`;
  }
  return `node:${candidate.id ?? "anonymous"}:${candidate.component ?? ""}:tiled:${layoutStructureKey(children.layout)}`;
}

/**
 * Identifies the topology below a split without including its mutable ratio.
 * A composition edit that changes which component branch a SplitLayout owns
 * must remount that stateful layout so a pinned vertical height cannot migrate
 * to a different branch or survive with stale content geometry.
 */
export function layoutStructureKey<Node extends { id?: string }>(
  layout: ComponentChildLayout<Node>,
): string {
  if (layout.type === "child") return `child:${nodeStructureKey(layout.child.node)}`;
  return `split:${layout.axis}:${layoutStructureKey(layout.first)}:${layoutStructureKey(layout.second)}`;
}
