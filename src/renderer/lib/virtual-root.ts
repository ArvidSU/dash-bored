import type { ResolvedComponentNode } from "../../shared/contracts";
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
): { node: ResolvedComponentNode; crumbs: VirtualRootCrumb[] } {
  const requested = requestedNodeId
    ? findVirtualRootPath(root, requestedNodeId)
    : null;
  const crumbs = requested ?? findVirtualRootPath(root, root.id)!;
  return { node: crumbs.at(-1)!.node, crumbs };
}

export function virtualRootStorageKey(projectRoot: string): string {
  return `dash-bored:virtual-root:${projectRoot}`;
}
