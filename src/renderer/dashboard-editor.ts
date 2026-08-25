import type {
  ComponentCatalogItem,
  ComponentManifest,
  ComponentNode,
  DashboardConfig,
} from "../shared/contracts";

export interface NodePathSegment {
  slot: string;
  index: number;
}

export type NodePath = NodePathSegment[];

export interface SlotTarget {
  parentPath: NodePath;
  slot: string;
  index: number;
}

function sameSegment(left: NodePathSegment, right: NodePathSegment): boolean {
  return left.slot === right.slot && left.index === right.index;
}

export function pathEquals(left: NodePath, right: NodePath): boolean {
  return left.length === right.length && left.every((segment, index) => sameSegment(segment, right[index]!));
}

export function pathStartsWith(path: NodePath, prefix: NodePath): boolean {
  return prefix.length <= path.length && prefix.every((segment, index) => sameSegment(segment, path[index]!));
}

export function catalogManifest(
  catalog: readonly ComponentCatalogItem[],
  reference: string,
): ComponentManifest | null {
  return catalog.find((item) => item.reference === reference)?.manifest ?? null;
}

export function slotAcceptsMultiple(
  catalog: readonly ComponentCatalogItem[],
  node: ComponentNode,
  slot: string,
): boolean {
  return catalogManifest(catalog, node.component)?.slots?.[slot]?.multiple === true;
}

export function slotNames(
  catalog: readonly ComponentCatalogItem[],
  node: ComponentNode,
): string[] {
  return [...new Set([
    ...Object.keys(catalogManifest(catalog, node.component)?.slots ?? {}),
    ...Object.keys(node.slots ?? {}),
  ])];
}

export function slotChildren(node: ComponentNode, slot: string): ComponentNode[] {
  const configured = node.slots?.[slot];
  if (configured === undefined) return [];
  return Array.isArray(configured) ? configured : [configured];
}

export function defaultTabLabel(index: number): string {
  return `Tab ${index + 1}`;
}

export function tabLabels(node: ComponentNode): string[] {
  const configured = Array.isArray(node.props?.labels) ? node.props.labels : [];
  return slotChildren(node, "children").map((_, index) => {
    const label = configured[index];
    return typeof label === "string" && label.trim().length > 0
      ? label
      : defaultTabLabel(index);
  });
}

function isTabChildrenSlot(node: ComponentNode, slot: string): boolean {
  return node.component === "@dash-bored/tabs" && slot === "children";
}

function setTabLabels(node: ComponentNode, labels: string[]): void {
  const props = { ...(node.props ?? {}) };
  if (labels.length === 0) delete props.labels;
  else props.labels = labels;
  node.props = Object.keys(props).length === 0 ? undefined : props;
}

export function nodeAtPath(root: ComponentNode, path: NodePath): ComponentNode {
  let node = root;
  for (const segment of path) {
    const child = slotChildren(node, segment.slot)[segment.index];
    if (!child) throw new Error("The dashboard changed while an edit action was in progress.");
    node = child;
  }
  return node;
}

export function nodePathById(
  root: ComponentNode,
  id: string,
  path: NodePath = [],
): NodePath | null {
  if (root.id === id) return path;
  for (const [slot, value] of Object.entries(root.slots ?? {})) {
    const children = Array.isArray(value) ? value : [value];
    for (const [index, child] of children.entries()) {
      const match = nodePathById(child, id, [...path, { slot, index }]);
      if (match) return match;
    }
  }
  return null;
}

export function collapsibleNodePaths(
  root: ComponentNode,
  path: NodePath = [],
): NodePath[] {
  const paths: NodePath[] = [];
  const entries = Object.entries(root.slots ?? {});
  if (entries.some(([, value]) => (Array.isArray(value) ? value.length : 1) > 0)) {
    paths.push(path);
  }
  for (const [slot, value] of entries) {
    const children = Array.isArray(value) ? value : [value];
    children.forEach((child, index) => {
      paths.push(...collapsibleNodePaths(child, [...path, { slot, index }]));
    });
  }
  return paths;
}

function setSlotChildren(
  node: ComponentNode,
  slot: string,
  children: ComponentNode[],
  multiple: boolean,
): void {
  const slots = { ...(node.slots ?? {}) };
  if (children.length === 0) delete slots[slot];
  else slots[slot] = multiple ? children : children[0]!;
  node.slots = Object.keys(slots).length === 0 ? undefined : slots;
}

function parentOf(root: ComponentNode, path: NodePath): {
  parent: ComponentNode;
  segment: NodePathSegment;
} {
  const segment = path.at(-1);
  if (!segment) throw new Error("The dashboard root cannot be moved or removed.");
  return { parent: nodeAtPath(root, path.slice(0, -1)), segment };
}

function adjustPathAfterRemoval(path: NodePath, removed: NodePath): NodePath {
  const removedSegment = removed.at(-1);
  if (!removedSegment) return path;
  const removedParent = removed.slice(0, -1);
  const adjusted = path.map((segment) => ({ ...segment }));
  if (!pathStartsWith(adjusted, removedParent) || adjusted.length <= removedParent.length) {
    return adjusted;
  }
  const affected = adjusted[removedParent.length]!;
  if (affected.slot === removedSegment.slot && affected.index > removedSegment.index) {
    affected.index -= 1;
  }
  return adjusted;
}

function removeFromConfig(
  config: DashboardConfig,
  path: NodePath,
  catalog: readonly ComponentCatalogItem[],
): ComponentNode {
  const { parent, segment } = parentOf(config.root, path);
  const children = slotChildren(parent, segment.slot);
  const labels = isTabChildrenSlot(parent, segment.slot) ? tabLabels(parent) : null;
  const [removed] = children.splice(segment.index, 1);
  if (!removed) throw new Error("The component no longer exists.");
  setSlotChildren(parent, segment.slot, children, slotAcceptsMultiple(catalog, parent, segment.slot));
  if (labels) {
    labels.splice(segment.index, 1);
    setTabLabels(parent, labels);
  }
  return removed;
}

export function removeNode(
  config: DashboardConfig,
  path: NodePath,
  catalog: readonly ComponentCatalogItem[],
): DashboardConfig {
  const next = structuredClone(config);
  removeFromConfig(next, path, catalog);
  return next;
}

/**
 * Replace the required dashboard root with a new component. A root cannot be
 * left empty, so replacing it is the root-level equivalent of remove + add.
 * Children whose slot still exists on the replacement are carried across;
 * incompatible children remain absent from the draft rather than producing an
 * invalid tree.
 */
export function replaceRoot(
  config: DashboardConfig,
  item: ComponentCatalogItem,
  props: Record<string, unknown>,
): DashboardConfig {
  const next = structuredClone(config);
  const replacement = createNode(next, item, props);
  if (config.root.id) replacement.id = config.root.id;

  const declaredSlots = item.manifest?.slots ?? {};
  const carriedSlots: Record<string, ComponentNode | ComponentNode[]> = {};
  for (const [slot, value] of Object.entries(config.root.slots ?? {})) {
    const definition = declaredSlots[slot];
    if (!definition) continue;
    const children = slotChildren(config.root, slot);
    if (children.length === 0) continue;
    carriedSlots[slot] = definition.multiple === true
      ? structuredClone(value)
      : structuredClone(children[0]!);
  }
  const slots = { ...(replacement.slots ?? {}), ...carriedSlots };
  replacement.slots = Object.keys(slots).length === 0 ? undefined : slots;
  next.root = replacement;
  return next;
}

export function countDiscardedRootNodes(
  config: DashboardConfig,
  item: ComponentCatalogItem,
): number {
  const declaredSlots = item.manifest?.slots ?? {};
  return Object.entries(config.root.slots ?? {}).reduce((total, [slot, value]) => {
    const children = Array.isArray(value) ? value : [value];
    const definition = declaredSlots[slot];
    if (!definition) return total + children.reduce((sum, child) => sum + countNodes(child), 0);
    const preserved = definition.multiple === true ? children.length : Math.min(children.length, 1);
    return total + children
      .slice(preserved)
      .reduce((sum, child) => sum + countNodes(child), 0);
  }, 0);
}

export function insertNode(
  config: DashboardConfig,
  target: SlotTarget,
  node: ComponentNode,
  catalog: readonly ComponentCatalogItem[],
): DashboardConfig {
  const next = structuredClone(config);
  const parent = nodeAtPath(next.root, target.parentPath);
  const multiple = slotAcceptsMultiple(catalog, parent, target.slot);
  const children = slotChildren(parent, target.slot);
  if (!multiple && children.length > 0) {
    throw new Error("That slot already contains a component. Remove it before adding another.");
  }
  const insertionIndex = Math.max(0, Math.min(target.index, children.length));
  const labels = isTabChildrenSlot(parent, target.slot) ? tabLabels(parent) : null;
  children.splice(insertionIndex, 0, structuredClone(node));
  setSlotChildren(parent, target.slot, children, multiple);
  if (labels) {
    labels.splice(insertionIndex, 0, defaultTabLabel(insertionIndex));
    setTabLabels(parent, labels);
  }
  return next;
}

export function moveNode(
  config: DashboardConfig,
  source: NodePath,
  target: SlotTarget,
  catalog: readonly ComponentCatalogItem[],
): DashboardConfig {
  if (source.length === 0) throw new Error("The dashboard root cannot be moved.");
  if (pathStartsWith(target.parentPath, source)) {
    throw new Error("A component cannot be moved into itself or one of its descendants.");
  }

  const next = structuredClone(config);
  const sourceSegment = source.at(-1)!;
  const sourceParentPath = source.slice(0, -1);
  const sourceParentNode = nodeAtPath(next.root, sourceParentPath);
  const movedTabLabel = isTabChildrenSlot(sourceParentNode, sourceSegment.slot)
    ? tabLabels(sourceParentNode)[sourceSegment.index]
    : undefined;
  const moved = removeFromConfig(next, source, catalog);
  const adjustedParentPath = adjustPathAfterRemoval(target.parentPath, source);
  const sourceParent = source.slice(0, -1);
  let targetIndex = target.index;
  if (
    pathEquals(sourceParent, target.parentPath) &&
    sourceSegment.slot === target.slot &&
    sourceSegment.index < targetIndex
  ) {
    targetIndex -= 1;
  }
  const parent = nodeAtPath(next.root, adjustedParentPath);
  const multiple = slotAcceptsMultiple(catalog, parent, target.slot);
  const children = slotChildren(parent, target.slot);
  if (!multiple && children.length > 0) {
    throw new Error("That slot already contains a component. Remove it before moving another one there.");
  }
  const insertionIndex = Math.max(0, Math.min(targetIndex, children.length));
  const labels = isTabChildrenSlot(parent, target.slot) ? tabLabels(parent) : null;
  children.splice(insertionIndex, 0, moved);
  setSlotChildren(parent, target.slot, children, multiple);
  if (labels) {
    labels.splice(insertionIndex, 0, movedTabLabel ?? defaultTabLabel(insertionIndex));
    setTabLabels(parent, labels);
  }
  return next;
}

export function renameTab(
  config: DashboardConfig,
  path: NodePath,
  index: number,
  label: string,
): DashboardConfig {
  const next = structuredClone(config);
  const node = nodeAtPath(next.root, path);
  if (node.component !== "@dash-bored/tabs") {
    throw new Error("Only a tabs component can rename its tabs.");
  }
  const children = slotChildren(node, "children");
  if (index < 0 || index >= children.length) {
    throw new Error("The tab no longer exists.");
  }
  const trimmed = label.trim();
  if (!trimmed) throw new Error("Tab names cannot be empty.");
  const labels = tabLabels(node);
  labels[index] = trimmed;
  setTabLabels(node, labels);
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

export type DashboardMetadataField = "name" | "icon";

/** Update dashboard identity without mutating the active draft. */
export function updateDashboardMetadata(
  config: DashboardConfig,
  field: DashboardMetadataField,
  value: string,
): DashboardConfig {
  const next = structuredClone(config);
  if (field === "name") {
    next.name = value;
    return next;
  }

  const icon = value.trim();
  if (icon.length === 0) delete next.icon;
  else next.icon = icon;
  return next;
}

export function countNodes(node: ComponentNode): number {
  return 1 + Object.values(node.slots ?? {}).reduce((total, value) => {
    const children = Array.isArray(value) ? value : [value];
    return total + children.reduce((sum, child) => sum + countNodes(child), 0);
  }, 0);
}

function collectIds(node: ComponentNode, ids: Set<string>, nodePath = "root"): void {
  ids.add(node.id ?? nodePath);
  for (const [slot, value] of Object.entries(node.slots ?? {})) {
    const children = Array.isArray(value) ? value : [value];
    children.forEach((child, index) => collectIds(child, ids, `${nodePath}.${slot}.${index}`));
  }
}

export function generateNodeId(config: DashboardConfig, manifest: ComponentManifest): string {
  const ids = new Set<string>();
  collectIds(config.root, ids);
  const raw = manifest.id.replace(/^@dash-bored\//, "");
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .replace(/-+$/g, "") || "component";
  let candidate = normalized;
  let suffix = 2;
  while (ids.has(candidate)) {
    candidate = `${normalized}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

export function createNode(
  config: DashboardConfig,
  item: ComponentCatalogItem,
  props: Record<string, unknown>,
): ComponentNode {
  if (!item.available || item.manifest === null) {
    throw new Error("That component is not available.");
  }
  return {
    id: generateNodeId(config, item.manifest),
    component: item.reference,
    ...(Object.keys(props).length === 0 ? {} : { props: structuredClone(props) }),
  };
}

export function pathKey(path: NodePath): string {
  return path.length === 0
    ? "root"
    : path.map((segment) => `${segment.slot}:${segment.index}`).join("/");
}
