import type {
  ComponentChildLayout,
  ComponentChildren,
  ResolvedComponentNode,
} from "../../shared/contracts";
import { childNodes } from "./component-children";

export interface VirtualRootCrumb {
  id: string;
  label: string;
  node: ResolvedComponentNode;
}

export function nodeLabel(node: ResolvedComponentNode, root: boolean): string {
  if (root) return "Dashboard";
  const title = node.props.title ?? node.props.label ?? node.props.name;
  if (typeof title === "string" && title.trim()) return title.trim();
  return node.manifest?.name ?? node.component.replace(/^@dash-bored\//, "");
}

export function findVirtualRootPath(
  root: ResolvedComponentNode,
  nodeId: string,
): VirtualRootCrumb[] | null {
  function visit(
    node: ResolvedComponentNode,
    path: VirtualRootCrumb[],
    isRoot: boolean,
  ): VirtualRootCrumb[] | null {
    const next = [...path, { id: node.id, label: nodeLabel(node, isRoot), node }];
    if (node.id === nodeId) return next;
    for (const child of childNodes(node)) {
      const found = visit(child, next, false);
      if (found) return found;
    }
    return null;
  }

  return visit(root, [], true);
}

export function resolveVirtualRoot(
  root: ResolvedComponentNode,
  requestedNodeId: string | null,
): {
  node: ResolvedComponentNode;
  target: ResolvedComponentNode;
  crumbs: VirtualRootCrumb[];
  retainedAncestorIds: readonly string[];
} {
  const requested = requestedNodeId
    ? findVirtualRootPath(root, requestedNodeId)
    : null;
  const crumbs = requested ?? findVirtualRootPath(root, root.id)!;
  const target = crumbs.at(-1)!.node;
  if (target.id === root.id) {
    return { node: root, target, crumbs, retainedAncestorIds: [] };
  }

  const retainedIndexes = crumbs
    .slice(0, -1)
    .map((crumb, index) => crumb.node.persistOnFocus ? index : -1)
    .filter((index) => index !== -1);
  let projection = target;
  for (const index of [...retainedIndexes].reverse()) {
    const ancestor = crumbs[index]!.node;
    const directBranch = crumbs[index + 1]!.node;
    projection = {
      ...ancestor,
      ...(ancestor.children === undefined
        ? {}
        : { children: projectChildren(ancestor.children, directBranch.id, projection) }),
    };
  }
  return {
    node: projection,
    target,
    crumbs,
    retainedAncestorIds: retainedIndexes.map((index) => crumbs[index]!.id),
  };
}

function projectChildren(
  children: ComponentChildren<ResolvedComponentNode>,
  branchNodeId: string,
  projection: ResolvedComponentNode,
): ComponentChildren<ResolvedComponentNode> {
  if (Array.isArray(children)) {
    return children.flatMap((edge) => {
      if (edge.node.id === branchNodeId) return [{ ...edge, node: projection }];
      return edge.node.persistOnFocus ? [edge] : [];
    });
  }
  return projectLayout(children, branchNodeId, projection)!;
}

function projectLayout(
  layout: ComponentChildLayout<ResolvedComponentNode>,
  branchNodeId: string,
  projection: ResolvedComponentNode,
): ComponentChildLayout<ResolvedComponentNode> | null {
  if ("node" in layout) {
    if (layout.node.id === branchNodeId) return { ...layout, node: projection };
    return layout.node.persistOnFocus ? layout : null;
  }
  const first = projectLayout(layout.first, branchNodeId, projection);
  const second = projectLayout(layout.second, branchNodeId, projection);
  if (!first) return second;
  if (!second) return first;
  return { ...layout, first, second };
}

export function virtualRootStorageKey(projectRoot: string): string {
  return `dash-bored:virtual-root:${projectRoot}`;
}
