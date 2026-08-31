import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { readdir, realpath, stat } from "node:fs/promises";
import type {
  ComponentChildEdge,
  ComponentChildLayout,
  ComponentChildren,
  ComponentCatalogItem,
  ComponentManifest,
  ComponentNode,
  DashboardConfig,
  Diagnostic,
  Permission,
  ResolvedComponentNode,
} from "../shared/contracts";
import { CONFIG_FILE } from "../shared/contracts";
import { getBuiltinManifest, listBuiltinManifests } from "./builtins";
import { diagnostic, errorMessage } from "./diagnostics";
import {
  isPathContained,
  resolveProjectLocation,
  resolveContainedPath,
  type ProjectLocation,
} from "./paths";
import {
  parseComponentManifest,
  parseDashboardConfig,
  parseDashboardLock,
  validatePropsSchema,
} from "./yaml";

const MAX_TREE_DEPTH = 64;
const MAX_TREE_NODES = 2_000;
const MAX_CATALOG_DIRECTORIES = 1_000;
const MAX_CATALOG_DEPTH = 16;
const LOCAL_REFERENCE_PREFIX = "./components/";
const MAX_CONFIG_LINK_DEPTH = 16;

export interface LocalComponentDefinition {
  reference: string;
  directory: string;
  manifestPath: string;
  entryPath: string;
  manifest: ComponentManifest;
}

export interface ResolvedTreeResult {
  tree: ResolvedComponentNode | null;
  components: ComponentManifest[];
  localComponents: LocalComponentDefinition[];
  permissions: Permission[];
  permissionsByNode: Map<string, ReadonlySet<Permission>>;
  projectRootsByNode: Map<string, string>;
  diagnostics: Diagnostic[];
}

function pathForChild(parent: string, index: number): string {
  return `${parent}.children.${index}`;
}

function childEdges<Node>(children: ComponentChildren<Node> | undefined): ComponentChildEdge<Node>[] {
  if (children === undefined) return [];
  if (children.type === "managed") return children.items;
  const edges: ComponentChildEdge<Node>[] = [];
  const collect = (layout: ComponentChildLayout<Node>): void => {
    if (layout.type === "child") edges.push(layout.child);
    else {
      collect(layout.first);
      collect(layout.second);
    }
  };
  collect(children.layout);
  return edges;
}

function propsDiagnosticPath(nodePath: string, instancePath: string): string {
  return `${nodePath}.props${instancePath.replaceAll("/", ".")}`;
}

function isLocalReference(reference: string): boolean {
  return reference.startsWith(LOCAL_REFERENCE_PREFIX) && reference.length > LOCAL_REFERENCE_PREFIX.length;
}

export function isConfigReference(reference: string): boolean {
  return !reference.startsWith("@dash-bored/") && !isLocalReference(reference);
}

export async function resolveConfigReferencePath(
  location: ProjectLocation,
  reference: string,
): Promise<string> {
  const requested = isAbsolute(reference)
    ? resolve(reference)
    : resolve(location.configDirectory, reference);
  const info = await stat(requested);
  const configPath = info.isDirectory() ? join(requested, CONFIG_FILE) : requested;
  if (basename(configPath) !== CONFIG_FILE) {
    throw new Error(`Config links must target a directory containing ${CONFIG_FILE} or the file itself.`);
  }
  return realpath(configPath);
}

function namespaceLinkedTree(
  tree: ResolvedComponentNode,
  prefix: string,
): { tree: ResolvedComponentNode; ids: Map<string, string> } {
  const ids = new Map<string, string>();
  const collect = (node: ResolvedComponentNode): void => {
    ids.set(node.id, `${prefix}::${node.id}`);
    for (const edge of childEdges(node.children)) collect(edge.node);
  };
  collect(tree);

  const copy = (node: ResolvedComponentNode): ResolvedComponentNode => {
    const manifest = node.manifest === undefined
      ? undefined
      : { ...node.manifest, id: `${prefix}::${node.manifest.id}` };
    const props = { ...node.props };
    for (const propName of Object.keys(node.manifest?.references ?? {})) {
      if (typeof props[propName] === "string") {
        props[propName] = ids.get(props[propName]) ?? props[propName];
      }
    }
    return {
      ...node,
      id: ids.get(node.id)!,
      props,
      ...(node.children === undefined
        ? {}
        : { children: mapChildren(node.children, copy) }),
      ...(manifest === undefined ? {} : { manifest }),
    };
  };
  return { tree: copy(tree), ids };
}

function mapLayout<Node, Mapped>(
  layout: ComponentChildLayout<Node>,
  mapNode: (node: Node) => Mapped,
): ComponentChildLayout<Mapped> {
  if (layout.type === "child") {
    return {
      type: "child",
      child: {
        node: mapNode(layout.child.node),
        ...(layout.child.metadata === undefined ? {} : { metadata: { ...layout.child.metadata } }),
      },
    };
  }
  return {
    ...layout,
    first: mapLayout(layout.first, mapNode),
    second: mapLayout(layout.second, mapNode),
  };
}

function mapChildren<Node, Mapped>(
  children: ComponentChildren<Node>,
  mapNode: (node: Node) => Mapped,
): ComponentChildren<Mapped> {
  if (children.type === "tiled") {
    return { type: "tiled", layout: mapLayout(children.layout, mapNode) };
  }
  return {
    type: "managed",
    items: children.items.map((edge) => ({
      node: mapNode(edge.node),
      ...(edge.metadata === undefined ? {} : { metadata: { ...edge.metadata } }),
    })),
  };
}

export async function discoverComponentCatalog(
  location: ProjectLocation,
): Promise<ComponentCatalogItem[]> {
  const catalog: ComponentCatalogItem[] = listBuiltinManifests().map((manifest) => ({
    reference: manifest.id,
    source: "builtin",
    available: true,
    manifest,
    diagnostics: [],
  }));
  let visited = 0;

  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > MAX_CATALOG_DEPTH || visited >= MAX_CATALOG_DIRECTORIES) return;
    visited += 1;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (directory === location.componentsDirectory) {
        catalog.push({
          reference: "./components",
          source: "local",
          available: false,
          manifest: null,
          diagnostics: [
            diagnostic({
              code: "COMPONENT_CATALOG_READ_FAILED",
              message: errorMessage(error),
              path: directory,
            }),
          ],
        });
      }
      return;
    }

    const manifestEntry = entries.find((entry) => entry.isFile() && entry.name === "component.yaml");
    if (manifestEntry) {
      const reference = localReferenceFromDirectory(location.componentsDirectory, directory);
      const loaded = await loadLocalDefinition(location, reference);
      const containmentDiagnostics = loaded.definition
        ? validateLocalDefinitionContainment(loaded.definition)
        : [];
      const diagnostics = [...loaded.diagnostics, ...containmentDiagnostics];
      catalog.push({
        reference,
        source: "local",
        available: loaded.definition !== null && diagnostics.length === 0,
        manifest: loaded.definition?.manifest ?? null,
        diagnostics,
      });
      return;
    }

    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
        .map((entry) => visit(resolve(directory, entry.name), depth + 1)),
    );
  };

  await visit(location.componentsDirectory, 0);

  const localById = new Map<string, ComponentCatalogItem[]>();
  for (const item of catalog) {
    if (item.source !== "local" || item.manifest === null) continue;
    const matches = localById.get(item.manifest.id) ?? [];
    matches.push(item);
    localById.set(item.manifest.id, matches);
  }
  for (const [id, matches] of localById) {
    if (matches.length < 2) continue;
    for (const item of matches) {
      item.available = false;
      item.diagnostics.push(
        diagnostic({
          code: "COMPONENT_ID_DUPLICATE",
          message: `Component id ${id} is declared by more than one local component.`,
          path: item.reference,
        }),
      );
    }
  }

  return catalog.sort((left, right) => {
    if (left.source !== right.source) return left.source === "builtin" ? -1 : 1;
    return left.reference.localeCompare(right.reference);
  });
}

async function loadLocalDefinition(
  location: ProjectLocation,
  reference: string,
): Promise<{ definition: LocalComponentDefinition | null; diagnostics: Diagnostic[] }> {
  if (!isLocalReference(reference)) {
    return {
      definition: null,
      diagnostics: [
        diagnostic({
          code: reference.startsWith("@dash-bored/")
            ? "BUILTIN_COMPONENT_UNKNOWN"
            : "COMPONENT_SOURCE_UNSUPPORTED",
          message: reference.startsWith("@dash-bored/")
            ? `Unknown built-in component: ${reference}`
            : `Only @dash-bored/* built-ins and ${LOCAL_REFERENCE_PREFIX} local components are supported.`,
          path: reference,
        }),
      ],
    };
  }

  const relativeDirectory = reference.slice(LOCAL_REFERENCE_PREFIX.length);
  try {
    const directory = await resolveContainedPath(
      location.componentsDirectory,
      relativeDirectory,
      { kind: "directory" },
    );
    const manifestPath = await resolveContainedPath(directory, "component.yaml", { kind: "file" });
    const parsed = await parseComponentManifest(manifestPath);
    if (parsed.value === null) return { definition: null, diagnostics: parsed.diagnostics };
    if (parsed.value.id.startsWith("@dash-bored/")) {
      return {
        definition: null,
        diagnostics: [
          diagnostic({
            code: "COMPONENT_ID_RESERVED",
            message: "The @dash-bored/* component id namespace is reserved for built-ins.",
            file: manifestPath,
            path: "/id",
          }),
        ],
      };
    }

    const entryPath = await resolveContainedPath(directory, parsed.value.entry, { kind: "file" });
    const extension = entryPath.slice(entryPath.lastIndexOf(".")).toLowerCase();
    if (extension !== ".ts" && extension !== ".tsx") {
      return {
        definition: null,
        diagnostics: [
          diagnostic({
            code: "COMPONENT_ENTRY_UNSUPPORTED",
            message: "Local component entrypoints must be .ts or .tsx files.",
            file: manifestPath,
            path: "/entry",
          }),
        ],
      };
    }

    return {
      definition: {
        reference,
        directory,
        manifestPath,
        entryPath,
        manifest: parsed.value,
      },
      diagnostics: [],
    };
  } catch (error) {
    return {
      definition: null,
      diagnostics: [
        diagnostic({
          code: error instanceof Error && "code" in error ? String(error.code) : "COMPONENT_RESOLVE_FAILED",
          message: errorMessage(error),
          path: reference,
        }),
      ],
    };
  }
}

function validateLocalDefinitionContainment(definition: LocalComponentDefinition): Diagnostic[] {
  if (!isPathContained(definition.directory, definition.entryPath)) {
    return [
      diagnostic({
        code: "PATH_OUTSIDE_COMPONENT",
        message: "The component entrypoint resolves outside its component directory.",
        file: definition.manifestPath,
        path: "/entry",
      }),
    ];
  }
  return [];
}

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

  const visit = async (
    node: ComponentNode,
    nodePath: string,
    sourcePath: string,
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
      const id = node.id ?? nodePath;
      if (ids.has(id)) {
        diagnostics.push(
          diagnostic({ code: "NODE_ID_DUPLICATE", message: `Duplicate node id: ${id}`, path: nodePath }),
        );
      } else {
        ids.add(id);
      }
      permissionsByNode.set(id, new Set());
      projectRootsByNode.set(id, location.projectRoot);
      if (node.children !== undefined) {
        diagnostics.push(diagnostic({
          code: "CONFIG_LINK_CHILDREN_UNSUPPORTED",
          message: "Config links expose their linked dashboard and cannot declare additional children.",
          path: `${nodePath}.children`,
        }));
      }

      let configPath: string | undefined;
      let configName: string | undefined;
      let configError: string | undefined;
      let linkedTree: ResolvedComponentNode | null = null;
      try {
        configPath = await resolveConfigReferencePath(location, node.component);
        if (configStack.includes(configPath)) {
          throw new Error(`Config link cycle detected at ${configPath}.`);
        }
        if (configStack.length >= MAX_CONFIG_LINK_DEPTH) {
          throw new Error(`Config links may be nested at most ${MAX_CONFIG_LINK_DEPTH} levels.`);
        }
        const linkedLocation = await resolveProjectLocation(configPath);
        const [linkedConfig, linkedLock] = await Promise.all([
          parseDashboardConfig(linkedLocation.configPath),
          parseDashboardLock(linkedLocation.lockPath),
        ]);
        const linkedErrors = [...linkedConfig.diagnostics, ...linkedLock.diagnostics];
        if (linkedConfig.value === null || linkedLock.value === null || linkedErrors.length > 0) {
          throw new Error(linkedErrors[0]?.message ?? "The linked config is invalid.");
        }
        configName = linkedConfig.value.name;
        const linked = await resolveComponentTree(
          linkedLocation,
          linkedConfig.value,
          [...configStack, configPath],
        );
        if (!linked.tree || linked.diagnostics.some((item) => item.severity === "error")) {
          throw new Error(linked.diagnostics[0]?.message ?? "The linked config could not be resolved.");
        }
        const namespaced = namespaceLinkedTree(linked.tree, id);
        linkedTree = namespaced.tree;
        for (const manifest of linked.components) {
          const scoped = { ...manifest, id: `${id}::${manifest.id}` };
          usedManifests.set(scoped.id, scoped);
        }
        for (const definition of linked.localComponents) {
          const scoped = {
            ...definition,
            reference: `${id}::${definition.reference}`,
            manifest: { ...definition.manifest, id: `${id}::${definition.manifest.id}` },
          };
          definitions.set(scoped.reference, scoped);
        }
        for (const permission of linked.permissions) requestedPermissions.add(permission);
        for (const [linkedId, permissions] of linked.permissionsByNode) {
          const scopedId = namespaced.ids.get(linkedId);
          if (scopedId) permissionsByNode.set(scopedId, permissions);
        }
        for (const [linkedId, projectRoot] of linked.projectRootsByNode) {
          const scopedId = namespaced.ids.get(linkedId);
          if (scopedId) projectRootsByNode.set(scopedId, projectRoot);
        }
      } catch (error) {
        configError = errorMessage(error);
      }
      visiting.delete(node);
      return {
        id,
        component: node.component,
        props: node.props ?? {},
        ...(linkedTree
          ? {
              children: {
                type: "managed" as const,
                items: [{ node: linkedTree }],
              },
            }
          : {}),
        source: "config",
        sourceConfigPath: location.configPath,
        sourcePath,
        manifest: {
          schemaVersion: 2,
          id: `config:${node.component}`,
          name: configName ?? node.component,
          description: "Renders another standalone dashboard configuration.",
          entry: "config:link",
          propsSchema: { type: "object", additionalProperties: false },
          children: {
            min: 0,
            max: 1,
            presentation: { type: "managed" },
          },
        },
        ...(configPath === undefined ? {} : { configPath }),
        ...(configName === undefined ? {} : { configName }),
        ...(configError === undefined ? {} : { configError }),
      };
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

    const id = node.id ?? nodePath;
    if (ids.has(id)) {
      diagnostics.push(
        diagnostic({ code: "NODE_ID_DUPLICATE", message: `Duplicate node id: ${id}`, path: nodePath }),
      );
    } else {
      ids.add(id);
    }
    if (manifest.resources && Object.keys(manifest.resources).length > 0 && node.id === undefined) {
      diagnostics.push(
        diagnostic({
          code: "NODE_ID_REQUIRED",
          message: `${manifest.name} provides app-owned resources and requires an explicit id so they remain stable across reloads.`,
          path: nodePath,
        }),
      );
    }

    const props = node.props ?? {};
    for (const error of validatePropsSchema(manifest.propsSchema, props)) {
      diagnostics.push(
        diagnostic({
          code: "COMPONENT_PROPS_INVALID",
          message: error.message ?? "Invalid component props.",
          path: propsDiagnosticPath(nodePath, error.instancePath),
        }),
      );
    }

    const processResource = manifest.resources?.process;
    if (processResource) {
      const command = props[processResource.commandProp];
      if (typeof command !== "string" || command.trim() === "") {
        diagnostics.push(diagnostic({
          code: "COMPONENT_PROCESS_COMMAND_INVALID",
          message: `${manifest.name}'s ${processResource.commandProp} prop must contain a command.`,
          path: `${nodePath}.props.${processResource.commandProp}`,
        }));
      }
      if (processResource.cwdProp) {
        const cwd = props[processResource.cwdProp];
        if (cwd !== undefined && (typeof cwd !== "string" || cwd.trim() === "")) {
          diagnostics.push(diagnostic({
            code: "COMPONENT_PROCESS_CWD_INVALID",
            message: `${manifest.name}'s ${processResource.cwdProp} prop must be a non-empty directory path.`,
            path: `${nodePath}.props.${processResource.cwdProp}`,
          }));
        }
      }
      if (processResource.envProp) {
        const env = props[processResource.envProp];
        if (
          env !== undefined
          && (
            typeof env !== "object"
            || env === null
            || Array.isArray(env)
            || Object.values(env).some((value) => typeof value !== "string")
          )
        ) {
          diagnostics.push(diagnostic({
            code: "COMPONENT_PROCESS_ENV_INVALID",
            message: `${manifest.name}'s ${processResource.envProp} prop must contain string-valued environment variables.`,
            path: `${nodePath}.props.${processResource.envProp}`,
          }));
        }
      }
    }

    const nodePermissions = new Set(manifest.permissions ?? []);
    permissionsByNode.set(id, nodePermissions);
    projectRootsByNode.set(id, location.projectRoot);
    for (const permission of nodePermissions) requestedPermissions.add(permission);

    const definition = manifest.children;
    const configuredChildren = node.children;
    const configuredEdges = childEdges(configuredChildren);
    if (definition === undefined && configuredChildren !== undefined) {
      diagnostics.push(diagnostic({
        code: "COMPONENT_CHILDREN_UNSUPPORTED",
        message: `${manifest.name} does not accept children.`,
        path: `${nodePath}.children`,
      }));
    }
    if (
      definition !== undefined &&
      configuredChildren !== undefined &&
      definition.presentation.type !== configuredChildren.type
    ) {
      diagnostics.push(diagnostic({
        code: "COMPONENT_CHILD_PRESENTATION_INVALID",
        message: `${manifest.name} requires ${definition.presentation.type} children.`,
        path: `${nodePath}.children.type`,
      }));
    }
    if (definition !== undefined && configuredEdges.length < definition.min) {
      diagnostics.push(diagnostic({
        code: "COMPONENT_CHILD_CARDINALITY",
        message: `${manifest.name} requires at least ${definition.min} child${definition.min === 1 ? "" : "ren"}.`,
        path: `${nodePath}.children`,
      }));
    }
    if (
      definition?.max !== undefined &&
      configuredEdges.length > definition.max
    ) {
      diagnostics.push(diagnostic({
        code: "COMPONENT_CHILD_CARDINALITY",
        message: `${manifest.name} accepts at most ${definition.max} child${definition.max === 1 ? "" : "ren"}.`,
        path: `${nodePath}.children`,
      }));
    }

    if (configuredChildren?.type === "tiled") {
      const validateLayout = (layout: ComponentChildLayout, layoutPath: string): void => {
        if (layout.type === "child") return;
        if (layout.ratio < 0.1 || layout.ratio > 0.9) {
          diagnostics.push(diagnostic({
            code: "COMPONENT_CHILD_RATIO_INVALID",
            message: "Tiled split ratios must be between 0.1 and 0.9.",
            path: `${layoutPath}.ratio`,
          }));
        }
        if (
          definition?.presentation.type === "tiled" &&
          definition.presentation.axes !== "both" &&
          layout.axis !== definition.presentation.axes
        ) {
          diagnostics.push(diagnostic({
            code: "COMPONENT_CHILD_AXIS_INVALID",
            message: `${manifest.name} only allows ${definition.presentation.axes} tiled splits.`,
            path: `${layoutPath}.axis`,
          }));
        }
        validateLayout(layout.first, `${layoutPath}.first`);
        validateLayout(layout.second, `${layoutPath}.second`);
      };
      validateLayout(configuredChildren.layout, `${nodePath}.children.layout`);
    }

    for (const [index, edge] of configuredEdges.entries()) {
      if (definition?.metadataSchema === undefined) {
        if (edge.metadata !== undefined) {
          diagnostics.push(diagnostic({
            code: "COMPONENT_CHILD_METADATA_UNSUPPORTED",
            message: `${manifest.name} does not declare child metadata.`,
            path: `${pathForChild(nodePath, index)}.metadata`,
          }));
        }
        continue;
      }
      for (const error of validatePropsSchema(definition.metadataSchema, edge.metadata ?? {})) {
        diagnostics.push(diagnostic({
          code: "COMPONENT_CHILD_METADATA_INVALID",
          message: error.message ?? "Invalid child metadata.",
          path: `${pathForChild(nodePath, index)}.metadata${error.instancePath.replaceAll("/", ".")}`,
        }));
      }
    }

    let nextChildIndex = 0;
    const resolveEdge = async (
      edge: ComponentChildEdge,
      edgeSourcePath: string,
    ): Promise<ComponentChildEdge<ResolvedComponentNode> | null> => {
      const index = nextChildIndex++;
      const resolved = await visit(
        edge.node,
        pathForChild(nodePath, index),
        `${edgeSourcePath}.node`,
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
    ): Promise<ComponentChildLayout<ResolvedComponentNode> | null> => {
      if (layout.type === "child") {
        const child = await resolveEdge(layout.child, `${layoutSourcePath}.child`);
        return child === null ? null : { type: "child", child };
      }
      const [first, second] = await Promise.all([
        resolveLayout(layout.first, `${layoutSourcePath}.first`),
        resolveLayout(layout.second, `${layoutSourcePath}.second`),
      ]);
      if (first === null || second === null) return null;
      return {
        type: "split",
        axis: layout.axis,
        ratio: layout.ratio,
        first,
        second,
      };
    };

    let resolvedChildren: ComponentChildren<ResolvedComponentNode> | undefined;
    if (configuredChildren?.type === "managed") {
      const items = await Promise.all(
        configuredChildren.items.map((edge, index) =>
          resolveEdge(edge, `${sourcePath}.children.items[${index}]`)),
      );
      resolvedChildren = {
        type: "managed",
        items: items.filter(
          (edge): edge is ComponentChildEdge<ResolvedComponentNode> => edge !== null,
        ),
      };
    } else if (configuredChildren?.type === "tiled") {
      const layout = await resolveLayout(
        configuredChildren.layout,
        `${sourcePath}.children.layout`,
      );
      if (layout !== null) resolvedChildren = { type: "tiled", layout };
    }

    visiting.delete(node);
    return {
      id,
      component: node.component,
      props,
      ...(resolvedChildren === undefined ? {} : { children: resolvedChildren }),
      source: node.component.startsWith(LOCAL_REFERENCE_PREFIX) ? "local" : "builtin",
      sourceConfigPath: location.configPath,
      sourcePath,
      manifest,
    };
  };

  const tree = await visit(config.root, "root", "root", 0);
  if (tree !== null) {
    const allNodes: ResolvedComponentNode[] = [];
    const resourceProviders = new Map<string, Set<string>>();
    const collect = (node: ResolvedComponentNode): void => {
      allNodes.push(node);
      for (const resource of Object.keys(node.manifest?.resources ?? {})) {
        const providers = resourceProviders.get(resource) ?? new Set<string>();
        providers.add(node.id);
        resourceProviders.set(resource, providers);
      }
      for (const edge of childEdges(node.children)) collect(edge.node);
    };
    collect(tree);

    for (const node of allNodes) {
      for (const [propName, reference] of Object.entries(node.manifest?.references ?? {})) {
        const targetId = node.props[propName];
        if (typeof targetId !== "string" || !resourceProviders.get(reference.resource)?.has(targetId)) {
          diagnostics.push(diagnostic({
            code: "COMPONENT_RESOURCE_REFERENCE_UNKNOWN",
            message: `${node.manifest?.name ?? node.component} references unknown ${reference.resource} resource node: ${String(targetId)}`,
            path: `${node.id}.props.${propName}`,
          }));
        }
      }

      const processResource = node.manifest?.resources?.process;
      const cwd = processResource?.cwdProp === undefined
        ? undefined
        : node.props[processResource.cwdProp];
      if (typeof cwd === "string") {
        try {
          await resolveContainedPath(location.projectRoot, cwd, { kind: "directory" });
        } catch (error) {
          diagnostics.push(
            diagnostic({
              code: "COMPONENT_PROCESS_CWD_INVALID",
              message: errorMessage(error),
              path: `${node.id}.props.${processResource!.cwdProp}`,
            }),
          );
        }
      }
    }
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

export function localReferenceFromDirectory(
  componentsDirectory: string,
  componentDirectory: string,
): string {
  const value = relative(componentsDirectory, componentDirectory).split(sep).join("/");
  return `${LOCAL_REFERENCE_PREFIX}${value}`;
}

export function componentDirectoryFromReference(
  componentsDirectory: string,
  reference: string,
): string | null {
  if (!isLocalReference(reference)) return null;
  const value = resolve(componentsDirectory, reference.slice(LOCAL_REFERENCE_PREFIX.length));
  return isPathContained(componentsDirectory, value) ? value : null;
}

export function componentDisplayName(definition: LocalComponentDefinition): string {
  return definition.manifest.name || basename(dirname(definition.manifestPath));
}
