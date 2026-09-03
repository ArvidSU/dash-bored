import type {
  ComponentChildEdge,
  ComponentChildLayout,
  ComponentChildren,
  ComponentChildLocator,
  ComponentNode,
  ComponentCatalogItem,
  ComponentManifest,
  DashboardConfig,
  ResolvedComponentNode,
} from "../../shared/contracts";
import {
  childEdges,
  edgeAtLocator,
  type LayoutBranch,
} from "../lib/component-children";

function sourceForReference(
  reference: string,
  item: ComponentCatalogItem | undefined,
  fallback: ResolvedComponentNode["source"] | undefined,
): ResolvedComponentNode["source"] {
  if (item?.source === "builtin" || reference.startsWith("@dash-bored/")) return "builtin";
  if (item?.source === "local" || reference.startsWith("./components/")) return "local";
  if (item?.source === "config") return "config";
  return fallback ?? "config";
}

function collectResolvedNodes(
  node: ResolvedComponentNode,
  result: Map<string, ResolvedComponentNode>,
): void {
  result.set(node.id, node);
  for (const edge of childEdges(node.children)) collectResolvedNodes(edge.node, result);
}

function resolvedIdMatchesRawId(resolvedId: string, rawId: string): boolean {
  return resolvedId === rawId || resolvedId.endsWith(`::${rawId}`);
}

function templateForChild(
  edge: ComponentChildEdge,
  template: ResolvedComponentNode | undefined,
  locator: ComponentChildLocator,
  index: number,
  resolvedById: ReadonlyMap<string, ResolvedComponentNode>,
): ResolvedComponentNode | undefined {
  if (edge.node.id) {
    const byId = resolvedById.get(edge.node.id);
    if (byId?.component === edge.node.component) return byId;
    for (const candidate of resolvedById.values()) {
      if (
        candidate.component === edge.node.component
        && resolvedIdMatchesRawId(candidate.id, edge.node.id)
      ) return candidate;
    }
  }
  const templateChildren = template?.children;
  if (templateChildren) {
    try {
      const candidate = edgeAtLocator(templateChildren, locator).node;
      if (candidate.component === edge.node.component) return candidate;
    } catch {
      // A topology edit may have removed or re-presented this child.
    }
  }
  const fallback = childEdges(templateChildren)[index]?.node;
  return fallback?.component === edge.node.component ? fallback : undefined;
}

function mapLayout(
  layout: ComponentChildLayout,
  templateChildren: ComponentChildren<ResolvedComponentNode> | undefined,
  template: ResolvedComponentNode | undefined,
  resolvedById: ReadonlyMap<string, ResolvedComponentNode>,
  resolveNode: (
    node: ComponentNode,
    templateNode: ResolvedComponentNode | undefined,
    path: string,
  ) => ResolvedComponentNode,
  path: string,
  leafIndex: { value: number },
  layoutPath: readonly LayoutBranch[] = [],
): ComponentChildLayout<ResolvedComponentNode> {
  if (layout.type === "child") {
    const locator: ComponentChildLocator = { type: "tiled", path: [...layoutPath] };
    const index = leafIndex.value++;
    const templateChild = templateForChild(
      layout.child,
      template,
      locator,
      index,
      resolvedById,
    );
    return {
      type: "child",
      child: {
        node: resolveNode(layout.child.node, templateChild, `${path}.child.node`),
        ...(layout.child.metadata === undefined ? {} : { metadata: structuredClone(layout.child.metadata) }),
      },
    };
  }
  return {
    type: "split",
    axis: layout.axis,
    ratio: layout.ratio,
    first: mapLayout(
      layout.first,
      templateChildren,
      template,
      resolvedById,
      resolveNode,
      `${path}.first`,
      leafIndex,
      [...layoutPath, "first"],
    ),
    second: mapLayout(
      layout.second,
      templateChildren,
      template,
      resolvedById,
      resolveNode,
      `${path}.second`,
      leafIndex,
      [...layoutPath, "second"],
    ),
  };
}

function mapChildren(
  children: ComponentChildren,
  template: ResolvedComponentNode | undefined,
  resolvedById: ReadonlyMap<string, ResolvedComponentNode>,
  resolveNode: (
    node: ComponentNode,
    templateNode: ResolvedComponentNode | undefined,
    path: string,
  ) => ResolvedComponentNode,
  path: string,
): ComponentChildren<ResolvedComponentNode> {
  if (children.type === "managed") {
    return {
      type: "managed",
      items: children.items.map((edge, index) => {
        const locator: ComponentChildLocator = { type: "managed", index };
        const templateChild = templateForChild(edge, template, locator, index, resolvedById);
        return {
          node: resolveNode(edge.node, templateChild, `${path}.items[${index}].node`),
          ...(edge.metadata === undefined ? {} : { metadata: structuredClone(edge.metadata) }),
        };
      }),
    };
  }

  const leafIndex = { value: 0 };
  return {
    type: "tiled",
    layout: mapLayout(
      children.layout,
      template?.children,
      template,
      resolvedById,
      resolveNode,
      `${path}.layout`,
      leafIndex,
    ),
  };
}

function pathForNode(path: string): string {
  return path.length > 0 ? path : "root";
}

/**
 * Resolve a draft for renderer preview without asking the host to reload it.
 * The host remains authoritative for validation and saving; this only overlays
 * raw YAML topology/props on the last known-good resolved tree.
 */
export function buildCompositionPreviewTree(
  config: DashboardConfig,
  resolvedTree: ResolvedComponentNode,
  catalog: readonly ComponentCatalogItem[],
  configPath: string,
  componentIdNamespace?: string,
): ResolvedComponentNode {
  const resolvedById = new Map<string, ResolvedComponentNode>();
  collectResolvedNodes(resolvedTree, resolvedById);
  const catalogByReference = new Map(catalog.map((item) => [item.reference, item]));

  function previewManifest(
    item: ComponentCatalogItem | undefined,
    template: ResolvedComponentNode | undefined,
    sameComponent: boolean,
  ): ComponentManifest | undefined {
    // Preserve the last-known-good manifest identity for an existing node.
    // Linked trees namespace local manifest IDs so the compiled component map
    // remains unambiguous; newly inserted local nodes need that same scope.
    if (sameComponent && template?.manifest) return structuredClone(template.manifest);
    if (!item?.manifest) return undefined;
    if (
      item.source === "local"
      && componentIdNamespace
      && !item.manifest.id.startsWith(`${componentIdNamespace}::`)
    ) {
      return { ...structuredClone(item.manifest), id: `${componentIdNamespace}::${item.manifest.id}` };
    }
    return structuredClone(item.manifest);
  }

  const resolveNode = (
    node: ComponentNode,
    template: ResolvedComponentNode | undefined,
    sourcePath: string,
  ): ResolvedComponentNode => {
    const item = catalogByReference.get(node.component);
    const sameComponent = template?.component === node.component;
    const manifest = previewManifest(item, template, sameComponent);
    const source = sourceForReference(node.component, item, sameComponent ? template?.source : undefined);
    const id = sameComponent && template?.id && (
      node.id === undefined || resolvedIdMatchesRawId(template.id, node.id)
    )
      ? template.id
      : node.id === undefined
        ? pathForNode(sourcePath)
        : componentIdNamespace
          ? `${componentIdNamespace}::${node.id}`
          : node.id;
    const resolved: ResolvedComponentNode = {
      id,
      component: node.component,
      props: structuredClone(node.props ?? {}),
      source,
      ...(manifest === undefined ? {} : { manifest: structuredClone(manifest) }),
      sourceConfigPath: sameComponent ? template?.sourceConfigPath ?? configPath : configPath,
      // The draft topology is authoritative for the locator even when the
      // last-known-good template supplied runtime provenance.
      sourcePath,
      ...(sameComponent && template?.configPath !== undefined ? { configPath: template.configPath } : {}),
      ...(sameComponent && template?.configName !== undefined ? { configName: template.configName } : {}),
      ...(sameComponent && template?.configError !== undefined ? { configError: template.configError } : {}),
    };

    if (node.children !== undefined) {
      resolved.children = mapChildren(node.children, sameComponent ? template : undefined, resolvedById, resolveNode, sourcePath);
    } else if (sameComponent && template?.source === "config" && template.children !== undefined) {
      // Config links derive their visible child from the linked YAML rather than
      // from a declared `children` field on the link node.
      resolved.children = structuredClone(template.children);
    }
    return resolved;
  };

  return resolveNode(config.root, resolvedTree, "root");
}
