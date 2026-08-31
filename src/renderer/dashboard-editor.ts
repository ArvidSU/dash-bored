import type {
  ComponentCatalogItem,
  ComponentChildEdge,
  ComponentChildLayout,
  ComponentChildLocator,
  ComponentChildPlacement,
  ComponentChildrenDefinition,
  ComponentManifest,
  ComponentNode,
  DashboardConfig,
  DashboardInsertionTarget,
} from "../shared/contracts";
import {
  childEdges,
  childLocators,
  componentPathKey,
  edgeAtLayoutPath,
  edgeAtLocator,
  layoutEdges,
  type LayoutBranch,
} from "./component-children";
import { normalizeSplitRatio } from "./split-layout";

export type NodePath = ComponentChildLocator[];
export type InsertionTarget = DashboardInsertionTarget;
export type ChildPlacement = ComponentChildPlacement;

function sameLocator(left: ComponentChildLocator, right: ComponentChildLocator): boolean {
  if (left.type !== right.type) return false;
  if (left.type === "managed" && right.type === "managed") return left.index === right.index;
  if (left.type === "tiled" && right.type === "tiled") {
    return left.path.length === right.path.length
      && left.path.every((segment, index) => segment === right.path[index]);
  }
  return false;
}

export function pathEquals(left: NodePath, right: NodePath): boolean {
  return left.length === right.length
    && left.every((segment, index) => sameLocator(segment, right[index]!));
}

export function pathStartsWith(path: NodePath, prefix: NodePath): boolean {
  return prefix.length <= path.length
    && prefix.every((segment, index) => sameLocator(segment, path[index]!));
}

export function pathKey(path: NodePath): string {
  return componentPathKey(path);
}

/**
 * Convert the resolver's YAML-style source locator back into a structural
 * path. Resolved linked nodes may have namespaced IDs, and nodes without an
 * explicit YAML id use generated resolver IDs, so sourcePath is the stable
 * locator for composition actions.
 */
export function nodePathFromSourcePath(sourcePath: string): NodePath | null {
  if (sourcePath === "root") return [];
  if (!sourcePath.startsWith("root")) return null;

  const path: NodePath = [];
  let offset = "root".length;
  while (offset < sourcePath.length) {
    const managed = sourcePath.slice(offset).match(/^\.children\.items\[(\d+)\]\.node/);
    if (managed) {
      path.push({ type: "managed", index: Number(managed[1]) });
      offset += managed[0].length;
      continue;
    }

    if (!sourcePath.startsWith(".children.layout", offset)) return null;
    offset += ".children.layout".length;
    const branches: LayoutBranch[] = [];
    while (true) {
      const branch = sourcePath.slice(offset).match(/^\.(first|second)/);
      if (!branch) break;
      branches.push(branch[1] as LayoutBranch);
      offset += branch[0].length;
    }
    if (!sourcePath.startsWith(".child.node", offset)) return null;
    offset += ".child.node".length;
    path.push({ type: "tiled", path: branches });
  }
  return path;
}

export function catalogManifest(
  catalog: readonly ComponentCatalogItem[],
  reference: string,
): ComponentManifest | null {
  return catalog.find((item) => item.reference === reference)?.manifest ?? null;
}

export function childrenDefinition(
  catalog: readonly ComponentCatalogItem[],
  node: ComponentNode,
): ComponentChildrenDefinition | undefined {
  return catalogManifest(catalog, node.component)?.children;
}

export function nodeAtPath(root: ComponentNode, path: NodePath): ComponentNode {
  let node = root;
  for (const locator of path) node = edgeAtLocator(node.children, locator).node;
  return node;
}

export function nodePathById(
  root: ComponentNode,
  id: string,
  path: NodePath = [],
): NodePath | null {
  if (root.id === id) return path;
  for (const locator of childLocators(root.children)) {
    const child = edgeAtLocator(root.children, locator).node;
    const match = nodePathById(child, id, [...path, locator]);
    if (match) return match;
  }
  return null;
}

export function collapsibleNodePaths(
  root: ComponentNode,
  path: NodePath = [],
): NodePath[] {
  const paths = childEdges(root.children).length > 0 ? [path] : [];
  for (const locator of childLocators(root.children)) {
    const child = edgeAtLocator(root.children, locator).node;
    paths.push(...collapsibleNodePaths(child, [...path, locator]));
  }
  return paths;
}

function parentOf(root: ComponentNode, path: NodePath): {
  parent: ComponentNode;
  locator: ComponentChildLocator;
} {
  const locator = path.at(-1);
  if (!locator) throw new Error("The dashboard root cannot be moved or removed.");
  return { parent: nodeAtPath(root, path.slice(0, -1)), locator };
}

function removeLayoutEdge(
  layout: ComponentChildLayout,
  path: readonly LayoutBranch[],
): { layout?: ComponentChildLayout; removed: ComponentChildEdge } {
  if (path.length === 0) {
    if (layout.type !== "child") throw new Error("The selected tile is no longer a component.");
    return { removed: layout.child };
  }
  if (layout.type !== "split") throw new Error("The selected tile no longer exists.");
  const [branch, ...rest] = path;
  const result = removeLayoutEdge(layout[branch!], rest);
  if (!result.layout) {
    return {
      layout: layout[branch === "first" ? "second" : "first"],
      removed: result.removed,
    };
  }
  return {
    layout: { ...layout, [branch!]: result.layout },
    removed: result.removed,
  };
}

function removeFromConfig(config: DashboardConfig, path: NodePath): ComponentChildEdge {
  const { parent, locator } = parentOf(config.root, path);
  if (!parent.children || parent.children.type !== locator.type) {
    throw new Error("The component's child presentation changed while editing.");
  }
  if (locator.type === "managed") {
    if (parent.children.type !== "managed") throw new Error("The child presentation changed.");
    const [removed] = parent.children.items.splice(locator.index, 1);
    if (!removed) throw new Error("The component no longer exists.");
    if (parent.children.items.length === 0) delete parent.children;
    return removed;
  }
  if (parent.children.type !== "tiled") throw new Error("The child presentation changed.");
  const result = removeLayoutEdge(parent.children.layout, locator.path);
  if (result.layout) parent.children.layout = result.layout;
  else delete parent.children;
  return result.removed;
}

function assertCardinality(
  definition: ComponentChildrenDefinition | undefined,
  count: number,
): ComponentChildrenDefinition {
  if (!definition) throw new Error("This component does not accept children.");
  if (definition.max !== undefined && count >= definition.max) {
    throw new Error(`This component accepts at most ${definition.max} children.`);
  }
  return definition;
}

function axisAllowed(
  definition: ComponentChildrenDefinition,
  axis: "horizontal" | "vertical",
): boolean {
  return definition.presentation.type === "tiled"
    && (definition.presentation.axes === "both" || definition.presentation.axes === axis);
}

function replaceLayoutLeaf(
  layout: ComponentChildLayout,
  path: readonly LayoutBranch[],
  replacement: ComponentChildLayout,
): ComponentChildLayout {
  if (path.length === 0) {
    if (layout.type !== "child") throw new Error("Select a component tile as the drop target.");
    return replacement;
  }
  if (layout.type !== "split") throw new Error("The selected tile no longer exists.");
  const [branch, ...rest] = path;
  return { ...layout, [branch!]: replaceLayoutLeaf(layout[branch!], rest, replacement) };
}

function tiledLayoutUsesAllowedAxes(
  layout: ComponentChildLayout,
  axes: "horizontal" | "vertical" | "both",
): boolean {
  if (layout.type === "child") return true;
  return (axes === "both" || layout.axis === axes)
    && tiledLayoutUsesAllowedAxes(layout.first, axes)
    && tiledLayoutUsesAllowedAxes(layout.second, axes);
}

function canPreserveRootChildren(
  children: ComponentNode["children"],
  definition: ComponentManifest["children"] | undefined,
): boolean {
  if (!children || !definition || children.type !== definition.presentation.type) return false;
  if (definition.max !== undefined && childEdges(children).length > definition.max) return false;
  return children.type !== "tiled"
    || definition.presentation.type !== "tiled"
    || tiledLayoutUsesAllowedAxes(children.layout, definition.presentation.axes);
}

function insertEdge(
  parent: ComponentNode,
  placement: ComponentChildPlacement,
  edge: ComponentChildEdge,
  catalog: readonly ComponentCatalogItem[],
): void {
  const definition = assertCardinality(
    childrenDefinition(catalog, parent),
    childEdges(parent.children).length,
  );
  const inserted: ComponentChildEdge = {
    node: structuredClone(edge.node),
    ...(placement.metadata ?? edge.metadata
      ? { metadata: structuredClone(placement.metadata ?? edge.metadata ?? {}) }
      : {}),
  };
  if (placement.type === "managed") {
    if (definition.presentation.type !== "managed") {
      throw new Error("This component uses tiled child presentation.");
    }
    if (!parent.children) parent.children = { type: "managed", items: [] };
    if (parent.children.type !== "managed") throw new Error("The child presentation is invalid.");
    const index = Math.max(0, Math.min(placement.index, parent.children.items.length));
    parent.children.items.splice(index, 0, inserted);
    return;
  }

  if (!axisAllowed(definition, placement.axis)) {
    throw new Error(`This component does not allow ${placement.axis} tiling.`);
  }
  const newLeaf: ComponentChildLayout = { type: "child", child: inserted };
  if (!parent.children) {
    parent.children = { type: "tiled", layout: newLeaf };
    return;
  }
  if (parent.children.type !== "tiled") throw new Error("The child presentation is invalid.");
  const target = edgeAtLayoutPath(parent.children.layout, placement.path);
  const oldLeaf: ComponentChildLayout = { type: "child", child: target };
  const split: ComponentChildLayout = {
    type: "split",
    axis: placement.axis,
    ratio: normalizeSplitRatio(placement.ratio),
    first: placement.position === "first" ? newLeaf : oldLeaf,
    second: placement.position === "second" ? newLeaf : oldLeaf,
  };
  parent.children.layout = replaceLayoutLeaf(parent.children.layout, placement.path, split);
}

export function removeNode(
  config: DashboardConfig,
  path: NodePath,
  _catalog?: readonly ComponentCatalogItem[],
): DashboardConfig {
  const next = structuredClone(config);
  removeFromConfig(next, path);
  return next;
}

export function replaceRoot(
  config: DashboardConfig,
  item: ComponentCatalogItem,
  props: Record<string, unknown>,
): DashboardConfig {
  const next = structuredClone(config);
  const replacement = createNode(next, item, props);
  if (config.root.id) replacement.id = config.root.id;
  const oldChildren = config.root.children;
  const definition = item.manifest?.children;
  if (canPreserveRootChildren(oldChildren, definition)) replacement.children = structuredClone(oldChildren);
  next.root = replacement;
  return next;
}

export function countDiscardedRootNodes(
  config: DashboardConfig,
  item: ComponentCatalogItem,
): number {
  const definition = item.manifest?.children;
  const edges = childEdges(config.root.children);
  if (!canPreserveRootChildren(config.root.children, definition)) {
    return edges.reduce((sum, edge) => sum + countNodes(edge.node), 0);
  }
  return 0;
}

export function insertNode(
  config: DashboardConfig,
  target: InsertionTarget,
  node: ComponentNode,
  catalog: readonly ComponentCatalogItem[],
): DashboardConfig {
  const next = structuredClone(config);
  insertEdge(nodeAtPath(next.root, target.parentPath), target.placement, { node }, catalog);
  return next;
}

function directLocatorById(parent: ComponentNode, id: string): ComponentChildLocator | null {
  return childLocators(parent.children).find((locator) =>
    edgeAtLocator(parent.children, locator).node.id === id) ?? null;
}

export function moveNode(
  config: DashboardConfig,
  source: NodePath,
  target: InsertionTarget,
  catalog: readonly ComponentCatalogItem[],
): DashboardConfig {
  if (source.length === 0) throw new Error("The dashboard root cannot be moved.");
  if (pathStartsWith(target.parentPath, source)) {
    throw new Error("A component cannot be moved into itself or one of its descendants.");
  }

  const originalParent = nodeAtPath(config.root, target.parentPath);
  const targetParentId = originalParent.id;
  const targetTileId = target.placement.type === "tiled" && originalParent.children?.type === "tiled"
    ? edgeAtLayoutPath(originalParent.children.layout, target.placement.path).node.id
    : undefined;
  const sourceParentPath = source.slice(0, -1);
  const sourceLocator = source.at(-1)!;
  const sameManagedParent = pathEquals(sourceParentPath, target.parentPath)
    && sourceLocator.type === "managed"
    && target.placement.type === "managed";

  const next = structuredClone(config);
  const edge = removeFromConfig(next, source);
  let parentPath = target.parentPath;
  if (targetParentId) parentPath = nodePathById(next.root, targetParentId) ?? parentPath;
  const parent = nodeAtPath(next.root, parentPath);
  const placement = structuredClone(target.placement);
  // A move carries the existing parent-child edge, including its metadata.
  // Metadata changes have their own explicit operation.
  delete placement.metadata;
  if (placement.type === "managed" && sameManagedParent && sourceLocator.type === "managed") {
    if (sourceLocator.index < placement.index) placement.index -= 1;
  } else if (placement.type === "tiled" && targetTileId) {
    const locator = directLocatorById(parent, targetTileId);
    if (!locator || locator.type !== "tiled") {
      throw new Error("The target tile was removed with the moved component.");
    }
    placement.path = locator.path;
  }
  insertEdge(parent, placement, edge, catalog);
  return next;
}

export function updateChildMetadata(
  config: DashboardConfig,
  path: NodePath,
  metadata: Record<string, unknown>,
): DashboardConfig {
  const next = structuredClone(config);
  const { parent, locator } = parentOf(next.root, path);
  edgeAtLocator(parent.children, locator).metadata = structuredClone(metadata);
  return next;
}

export function updateNodeProps(
  config: DashboardConfig,
  path: NodePath,
  props: Record<string, unknown>,
): DashboardConfig {
  const next = structuredClone(config);
  const node = nodeAtPath(next.root, path);
  node.props = Object.keys(props).length === 0 ? undefined : structuredClone(props);
  return next;
}

export function updateTiledSplitRatio(
  config: DashboardConfig,
  parentPath: NodePath,
  splitPath: readonly LayoutBranch[],
  ratio: number,
): DashboardConfig {
  const next = structuredClone(config);
  const parent = nodeAtPath(next.root, parentPath);
  if (parent.children?.type !== "tiled") throw new Error("The tiled layout no longer exists.");
  let layout = parent.children.layout;
  for (const branch of splitPath) {
    if (layout.type !== "split") throw new Error("The split no longer exists.");
    layout = layout[branch];
  }
  if (layout.type !== "split") throw new Error("The split no longer exists.");
  layout.ratio = normalizeSplitRatio(ratio);
  return next;
}

export type DashboardMetadataField = "name" | "icon";

export function updateDashboardMetadata(
  config: DashboardConfig,
  field: DashboardMetadataField,
  value: string,
): DashboardConfig {
  const next = structuredClone(config);
  if (field === "name") next.name = value;
  else if (value.trim().length === 0) delete next.icon;
  else next.icon = value.trim();
  return next;
}

export function countNodes(node: ComponentNode): number {
  return 1 + childEdges(node.children).reduce((sum, edge) => sum + countNodes(edge.node), 0);
}

function collectIds(node: ComponentNode, ids: Set<string>, nodePath = "root"): void {
  ids.add(node.id ?? nodePath);
  childLocators(node.children).forEach((locator) => {
    collectIds(edgeAtLocator(node.children, locator).node, ids, `${nodePath}.${componentPathKey([locator])}`);
  });
}

export function generateNodeId(config: DashboardConfig, manifest: ComponentManifest): string {
  const ids = new Set<string>();
  collectIds(config.root, ids);
  const raw = manifest.id.replace(/^@dash-bored\//, "");
  const normalized = raw.toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .replace(/-+$/g, "") || "component";
  let candidate = normalized;
  let suffix = 2;
  while (ids.has(candidate)) candidate = `${normalized}-${suffix++}`;
  return candidate;
}

export function createNode(
  config: DashboardConfig,
  item: ComponentCatalogItem,
  props: Record<string, unknown>,
): ComponentNode {
  if (!item.available || item.manifest === null) throw new Error("That component is not available.");
  return {
    id: generateNodeId(config, item.manifest),
    component: item.reference,
    ...(Object.keys(props).length > 0 ? { props: structuredClone(props) } : {}),
  };
}

export function defaultChildMetadata(
  manifest: ComponentManifest,
  index: number,
): Record<string, unknown> {
  const schema = manifest.children?.metadataSchema;
  const properties = schema && typeof schema.properties === "object" && schema.properties !== null
    ? schema.properties as Record<string, Record<string, unknown>>
    : {};
  const metadata: Record<string, unknown> = {};
  for (const [name, property] of Object.entries(properties)) {
    if ("default" in property) metadata[name] = structuredClone(property.default);
    else if (name === "label") metadata[name] = `Item ${index + 1}`;
  }
  return metadata;
}

export function managedChildEdges(node: ComponentNode): ComponentChildEdge[] {
  return node.children?.type === "managed" ? node.children.items : [];
}

export function tiledChildEdges(node: ComponentNode): ComponentChildEdge[] {
  return node.children?.type === "tiled" ? layoutEdges(node.children.layout) : [];
}
