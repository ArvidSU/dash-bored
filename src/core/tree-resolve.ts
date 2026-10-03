import type {
  ComponentChildEdge,
  ComponentChildLayout,
  ComponentChildren,
  ComponentManifest,
  ComponentNode,
  DashboardConfig,
  Diagnostic,
  NodePath,
  Permission,
  ResolvedComponentNode,
} from "../shared/contracts";
import { permissionsForComponent } from "../shared/component-permissions";
import { migrateLegacyActionReferences } from "../migrations/action-references";
import { getBuiltinManifest } from "./builtins";
import { childEdges } from "../shared/child-edges";
import { diagnostic } from "./diagnostics";
import type { ProjectLocation } from "./paths";
import { loadPromptTemplates } from "./prompt-templates";
import {
  LOCAL_REFERENCE_PREFIX,
  loadLocalDefinition,
  validateLocalDefinitionContainment,
  type LocalComponentDefinition,
} from "./tree-catalog";
import {
  configLinkManifest,
  isConfigReference,
  resolveLinkedDashboard,
} from "./tree-links";
import {
  childPath,
  referenceIndex,
  validateDeclaredComponentActionReferences,
  validateNode,
  validateNodeReferences,
  validateProcessWorkingDirectories,
} from "./tree-validate";

const MAX_TREE_DEPTH = 64;
const MAX_TREE_NODES = 2_000;

export interface ResolvedTreeResult {
  tree: ResolvedComponentNode | null;
  components: ComponentManifest[];
  localComponents: LocalComponentDefinition[];
  permissions: Permission[];
  permissionsByNode: Map<string, ReadonlySet<Permission>>;
  projectRootsByNode: Map<string, string>;
  diagnostics: Diagnostic[];
}

/**
 * Resolve a bundle's YAML tree into manifests, permissions, and linked
 * dashboards, then validate it. Resolution owns traversal limits, node IDs,
 * and the permission union; checks live in tree-validate and config links in
 * tree-links.
 */
export async function resolveComponentTree(
  location: ProjectLocation,
  config: DashboardConfig,
  configStack: readonly string[] = [location.configPath],
): Promise<ResolvedTreeResult> {
  const diagnostics: Diagnostic[] = [];
  const definitions = new Map<string, LocalComponentDefinition>();
  const failedReferences = new Set<string>();
  const usedManifests = new Map<string, ComponentManifest>();
  const manifestReferenceById = new Map<string, string>();
  const ids = new Set<string>();
  const explicitNodeIds = new Set<string>();
  const requestedPermissions = new Set<Permission>();
  const permissionsByNode = new Map<string, ReadonlySet<Permission>>();
  const projectRootsByNode = new Map<string, string>();
  const visiting = new WeakSet<object>();
  let nodeCount = 0;

  const manifestForReference = async (reference: string): Promise<ComponentManifest | null> => {
    const builtin = getBuiltinManifest(reference);
    if (builtin !== undefined) return builtin;
    const cached = definitions.get(reference);
    if (cached !== undefined) return cached.manifest;
    if (failedReferences.has(reference)) return null;

    const loaded = await loadLocalDefinition(location, reference);
    diagnostics.push(...loaded.diagnostics);
    if (loaded.definition === null) {
      failedReferences.add(reference);
      return null;
    }
    diagnostics.push(...validateLocalDefinitionContainment(loaded.definition));
    definitions.set(reference, loaded.definition);
    return loaded.definition.manifest;
  };

  const claimNodeId = (node: ComponentNode, nodePath: string): string => {
    const id = node.id ?? nodePath;
    if (node.id !== undefined) explicitNodeIds.add(id);
    if (ids.has(id)) {
      diagnostics.push(
        diagnostic({ code: "NODE_ID_DUPLICATE", message: `Duplicate node id: ${id}`, path: nodePath }),
      );
    } else {
      ids.add(id);
    }
    return id;
  };

  const visitConfigLink = async (
    node: ComponentNode,
    nodePath: string,
    sourcePath: string,
    sourceNodePath: NodePath,
  ): Promise<ResolvedComponentNode> => {
    const id = claimNodeId(node, nodePath);
    permissionsByNode.set(id, new Set());
    projectRootsByNode.set(id, location.projectRoot);
    if (node.children !== undefined) {
      diagnostics.push(diagnostic({
        code: "CONFIG_LINK_CHILDREN_UNSUPPORTED",
        message: "Config links expose their linked dashboard and cannot declare additional children.",
        path: `${nodePath}.children`,
      }));
    }

    const { configPath, configName, configError, linked } = await resolveLinkedDashboard(
      location,
      node.component,
      id,
      configStack,
      resolveComponentTree,
    );
    if (linked) {
      for (const manifest of linked.result.components) {
        const scoped = { ...manifest, id: `${id}::${manifest.id}` };
        usedManifests.set(scoped.id, scoped);
      }
      for (const definition of linked.result.localComponents) {
        const scoped = {
          ...definition,
          reference: `${id}::${definition.reference}`,
          manifest: { ...definition.manifest, id: `${id}::${definition.manifest.id}` },
        };
        definitions.set(scoped.reference, scoped);
      }
      for (const permission of linked.result.permissions) requestedPermissions.add(permission);
      for (const [linkedId, permissions] of linked.result.permissionsByNode) {
        const scopedId = linked.ids.get(linkedId);
        if (scopedId) permissionsByNode.set(scopedId, permissions);
      }
      for (const [linkedId, projectRoot] of linked.result.projectRootsByNode) {
        const scopedId = linked.ids.get(linkedId);
        if (scopedId) projectRootsByNode.set(scopedId, projectRoot);
      }
    }
    return {
      id,
      component: node.component,
      props: node.props ?? {},
      ...(node.persistOnFocus === undefined ? {} : { persistOnFocus: node.persistOnFocus }),
      ...(linked ? { children: [{ node: linked.tree }] } : {}),
      source: "config",
      sourceConfigPath: location.configPath,
      sourcePath,
      sourceNodePath,
      manifest: configLinkManifest(node.component, configName),
      ...(configPath === undefined ? {} : { configPath }),
      ...(configName === undefined ? {} : { configName }),
      ...(configError === undefined ? {} : { configError }),
    };
  };

  const visit = async (
    node: ComponentNode,
    nodePath: string,
    sourcePath: string,
    sourceNodePath: NodePath,
    depth: number,
  ): Promise<ResolvedComponentNode | null> => {
    nodeCount += 1;
    if (nodeCount > MAX_TREE_NODES) {
      diagnostics.push(
        diagnostic({
          code: "TREE_TOO_LARGE",
          message: `Dashboard trees may contain at most ${MAX_TREE_NODES} nodes.`,
          path: nodePath,
        }),
      );
      return null;
    }
    if (depth > MAX_TREE_DEPTH) {
      diagnostics.push(
        diagnostic({
          code: "TREE_TOO_DEEP",
          message: `Dashboard trees may be at most ${MAX_TREE_DEPTH} levels deep.`,
          path: nodePath,
        }),
      );
      return null;
    }
    if (visiting.has(node)) {
      diagnostics.push(
        diagnostic({ code: "TREE_CYCLE", message: "Dashboard nodes may not be cyclic.", path: nodePath }),
      );
      return null;
    }
    visiting.add(node);

    if (isConfigReference(node.component)) {
      const resolved = await visitConfigLink(node, nodePath, sourcePath, sourceNodePath);
      visiting.delete(node);
      return resolved;
    }

    const manifest = await manifestForReference(node.component);
    if (manifest === null) {
      visiting.delete(node);
      return null;
    }
    const previousManifestReference = manifestReferenceById.get(manifest.id);
    if (previousManifestReference !== undefined && previousManifestReference !== node.component) {
      diagnostics.push(
        diagnostic({
          code: "COMPONENT_ID_DUPLICATE",
          message: `Component id ${manifest.id} is declared by both ${previousManifestReference} and ${node.component}.`,
          path: nodePath,
        }),
      );
    } else {
      manifestReferenceById.set(manifest.id, node.component);
    }
    usedManifests.set(manifest.id, manifest);

    const id = claimNodeId(node, nodePath);
    const props = node.props ?? {};
    const configuredChildren = node.children;
    const configuredEdges = childEdges(configuredChildren);
    diagnostics.push(...validateNode(manifest, node, props, configuredEdges, nodePath));

    const nodePermissions = new Set(permissionsForComponent(manifest, props));
    permissionsByNode.set(id, nodePermissions);
    projectRootsByNode.set(id, location.projectRoot);
    for (const permission of nodePermissions) requestedPermissions.add(permission);

    let nextChildIndex = 0;
    const resolveEdge = async (
      edge: ComponentChildEdge,
      edgeSourcePath: string,
      edgeNodePath: NodePath,
    ): Promise<ComponentChildEdge<ResolvedComponentNode> | null> => {
      const index = nextChildIndex++;
      const resolved = await visit(
        edge.node,
        childPath(nodePath, index),
        `${edgeSourcePath}.node`,
        edgeNodePath,
        depth + 1,
      );
      if (resolved === null) return null;
      return {
        node: resolved,
        ...(edge.metadata === undefined ? {} : { metadata: { ...edge.metadata } }),
      };
    };
    const resolveLayout = async (
      layout: ComponentChildLayout,
      layoutSourcePath: string,
      layoutBranches: Array<"first" | "second">,
    ): Promise<ComponentChildLayout<ResolvedComponentNode> | null> => {
      if ("node" in layout) {
        return resolveEdge(layout, layoutSourcePath, [
          ...sourceNodePath,
          { type: "tiled", path: [...layoutBranches] },
        ]);
      }
      const [first, second] = await Promise.all([
        resolveLayout(layout.first, `${layoutSourcePath}.first`, [...layoutBranches, "first"]),
        resolveLayout(layout.second, `${layoutSourcePath}.second`, [...layoutBranches, "second"]),
      ]);
      if (first === null || second === null) return null;
      return {
        ...layout,
        first,
        second,
      };
    };

    let resolvedChildren: ComponentChildren<ResolvedComponentNode> | undefined;
    if (Array.isArray(configuredChildren)) {
      const items = await Promise.all(
        configuredChildren.map((edge, index) =>
          resolveEdge(edge, `${sourcePath}.children[${index}]`, [
            ...sourceNodePath,
            { type: "managed", index },
          ])),
      );
      resolvedChildren = items.filter(
        (edge): edge is ComponentChildEdge<ResolvedComponentNode> => edge !== null,
      );
    } else if (configuredChildren !== undefined) {
      const layout = await resolveLayout(
        configuredChildren,
        `${sourcePath}.children`,
        [],
      );
      if (layout !== null) resolvedChildren = layout;
    }

    visiting.delete(node);
    return {
      id,
      component: node.component,
      props,
      ...(resolvedChildren === undefined ? {} : { children: resolvedChildren }),
      ...(node.persistOnFocus === undefined ? {} : { persistOnFocus: node.persistOnFocus }),
      source: node.component.startsWith(LOCAL_REFERENCE_PREFIX) ? "local" : "builtin",
      sourceConfigPath: location.configPath,
      sourcePath,
      sourceNodePath,
      manifest: { ...manifest, permissions: [...nodePermissions] },
    };
  };

  const tree = await visit(config.root, "root", "root", [], 0);
  if (tree !== null) {
    const allNodes: ResolvedComponentNode[] = [];
    const collect = (node: ResolvedComponentNode): void => {
      allNodes.push(node);
      for (const edge of childEdges(node.children)) collect(edge.node);
    };
    collect(tree);
    // Linked dashboards resolve and validate their own references before
    // namespacing. Their IDs are intentionally private to that bundle.
    const bundleNodes = allNodes.filter((node) => node.sourceConfigPath === location.configPath);

    const cwdDiagnostics = await validateProcessWorkingDirectories(location.projectRoot, bundleNodes);
    // Each bundle owns its prompt templates; linked bundles load their own.
    const promptTemplates = await loadPromptTemplates(location.configDirectory);
    diagnostics.push(...promptTemplates.diagnostics);
    const index = referenceIndex(allNodes, explicitNodeIds, promptTemplates.templates);
    for (const node of bundleNodes) {
      diagnostics.push(...validateNodeReferences(index, node), ...(cwdDiagnostics.get(node) ?? []));
    }
    diagnostics.push(...migrateLegacyActionReferences(bundleNodes));
    diagnostics.push(...validateDeclaredComponentActionReferences(allNodes));
  }
  return {
    tree,
    components: [...usedManifests.values()],
    localComponents: [...definitions.values()],
    permissions: [...requestedPermissions].sort(),
    permissionsByNode,
    projectRootsByNode,
    diagnostics,
  };
}
