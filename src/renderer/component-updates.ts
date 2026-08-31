import type { ResolvedComponentNode } from "../shared/contracts";
import { childLocators, edgeAtLocator, locatorKey } from "./component-children";

interface IndexedNode {
  node: ResolvedComponentNode;
  ownSignature: string;
  parentId: string | null;
  position: string;
}

interface TreeIndex {
  nodes: ReadonlyMap<string, IndexedNode>;
  order: readonly string[];
}

const EMPTY_COMPONENT_REVISIONS: ReadonlyMap<string, string> = new Map();

function stableValue(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableValue(record[key])}`)
    .join(",")}}`;
}

function ownSignature(node: ResolvedComponentNode): string {
  return stableValue({
    component: node.component,
    configError: node.configError ?? null,
    configName: node.configName ?? null,
    configPath: node.configPath ?? null,
    props: node.props,
    source: node.source,
  });
}

function indexTree(tree: ResolvedComponentNode): TreeIndex {
  const nodes = new Map<string, IndexedNode>();
  const order: string[] = [];

  const visit = (
    node: ResolvedComponentNode,
    parentId: string | null,
    position: string,
  ): void => {
    nodes.set(node.id, {
      node,
      ownSignature: ownSignature(node),
      parentId,
      position,
    });
    order.push(node.id);
    for (const locator of childLocators(node.children)) {
      visit(edgeAtLocator(node.children, locator).node, node.id, locatorKey(locator));
    }
  };

  visit(tree, null, "root");
  return { nodes, order };
}

/**
 * Return changed nodes in their new visual traversal order. Descendant prop
 * changes do not make layout ancestors flash, while inserted, moved, replaced,
 * directly edited, and successfully reloaded local nodes each receive their
 * own update treatment.
 */
export function changedComponentIds(
  previousTree: ResolvedComponentNode,
  nextTree: ResolvedComponentNode,
  previousLocalComponentRevisions: ReadonlyMap<string, string> = EMPTY_COMPONENT_REVISIONS,
  nextLocalComponentRevisions: ReadonlyMap<string, string> = EMPTY_COMPONENT_REVISIONS,
): string[] {
  const previous = indexTree(previousTree);
  const next = indexTree(nextTree);
  const changed = new Set<string>();

  for (const id of next.order) {
    const current = next.nodes.get(id);
    const before = previous.nodes.get(id);
    if (!current) continue;
    const localComponentId = current.node.source === "local"
      ? current.node.manifest?.id
      : undefined;
    const localComponentReloaded = localComponentId !== undefined
      && previousLocalComponentRevisions.has(localComponentId)
      && nextLocalComponentRevisions.has(localComponentId)
      && previousLocalComponentRevisions.get(localComponentId)
        !== nextLocalComponentRevisions.get(localComponentId);
    if (
      !before ||
      before.ownSignature !== current.ownSignature ||
      before.parentId !== current.parentId ||
      before.position !== current.position ||
      localComponentReloaded
    ) {
      changed.add(id);
    }
  }

  for (const [id, before] of previous.nodes) {
    if (next.nodes.has(id) || before.parentId === null) continue;
    if (next.nodes.has(before.parentId)) changed.add(before.parentId);
  }

  return next.order.filter((id) => changed.has(id));
}

export function updateStaggerMs(index: number, total: number): number {
  const step = total > 16 ? 10 : total > 8 ? 16 : 28;
  return Math.min(index * step, 180);
}
