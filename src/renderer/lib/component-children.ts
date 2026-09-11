import type {
  ComponentChildEdge,
  ComponentChildLayout,
  ComponentChildren,
  ComponentNode,
  ResolvedComponentNode,
} from "../../shared/contracts";

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
  if ("node" in layout) return [layout];
  return [...layoutEdges(layout.first), ...layoutEdges(layout.second)];
}

export function childEdges<Node>(
  children: ComponentChildren<Node> | undefined,
): ComponentChildEdge<Node>[] {
  if (!children) return [];
  return Array.isArray(children)
    ? children
    : layoutEdges(children);
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
  if ("node" in layout) {
    visit(layout, path);
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
    if (!("axis" in branch)) {
      throw new Error("The dashboard changed while an edit action was in progress.");
    }
    branch = branch[segment];
  }
  if (!("node" in branch)) {
    throw new Error("The selected tile is no longer a component.");
  }
  return branch;
}

export function edgeAtLocator<Node>(
  children: ComponentChildren<Node> | undefined,
  locator: ChildLocator,
): ComponentChildEdge<Node> {
  if (!children || (Array.isArray(children) ? "managed" : "tiled") !== locator.type) {
    throw new Error("The component's child presentation changed while editing.");
  }
  if (locator.type === "managed") {
    if (!Array.isArray(children)) throw new Error("The child presentation changed.");
    const edge = children[locator.index];
    if (!edge) throw new Error("The child no longer exists.");
    return edge;
  }
  if (Array.isArray(children)) throw new Error("The child presentation changed.");
  return edgeAtLayoutPath(children, locator.path);
}

export function childLocators<Node>(
  children: ComponentChildren<Node> | undefined,
): ChildLocator[] {
  if (!children) return [];
  if (Array.isArray(children)) {
    return children.map((_, index) => ({ type: "managed", index }));
  }
  const paths: TiledChildLocator[] = [];
  visitChildLayout(children, (_edge, path) => {
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
  if (Array.isArray(children)) {
    return `node:${candidate.id ?? "anonymous"}:${candidate.component ?? ""}:managed:${children
      .map((edge) => `${edge.node.id ?? "anonymous"}:${nodeStructureKey(edge.node)}`)
      .join(",")}`;
  }
  return `node:${candidate.id ?? "anonymous"}:${candidate.component ?? ""}:tiled:${layoutStructureKey(children)}`;
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
  if ("node" in layout) return `child:${nodeStructureKey(layout.node)}`;
  return `split:${layout.axis}:${layoutStructureKey(layout.first)}:${layoutStructureKey(layout.second)}`;
}
