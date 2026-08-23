import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { readdir, realpath, stat } from "node:fs/promises";
import type {
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

function pathForChild(parent: string, slot: string, index: number): string {
  return `${parent}.${slot}.${index}`;
}

function propsDiagnosticPath(nodePath: string, instancePath: string): string {
  return `${nodePath}.props${instancePath.replaceAll("/", ".")}`;
}

function isLocalReference(reference: string): boolean {
  return reference.startsWith(LOCAL_REFERENCE_PREFIX) && reference.length > LOCAL_REFERENCE_PREFIX.length;
}

function isConfigReference(reference: string): boolean {
  return !reference.startsWith("@dash-bored/") && !isLocalReference(reference);
}

async function configPathFromReference(
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
    for (const children of Object.values(node.slots)) for (const child of children) collect(child);
  };
  collect(tree);

  const copy = (node: ResolvedComponentNode): ResolvedComponentNode => {
    const manifest = node.manifest === undefined
      ? undefined
      : { ...node.manifest, id: `${prefix}::${node.manifest.id}` };
    const props = { ...node.props };
    if (node.component === "@dash-bored/terminal" && typeof props.processId === "string") {
      props.processId = ids.get(props.processId) ?? props.processId;
    }
    return {
      ...node,
      id: ids.get(node.id)!,
      props,
      slots: Object.fromEntries(
        Object.entries(node.slots).map(([slot, children]) => [slot, children.map(copy)]),
      ),
      ...(manifest === undefined ? {} : { manifest }),
    };
  };
  return { tree: copy(tree), ids };
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

      let configPath: string | undefined;
      let configName: string | undefined;
      let configError: string | undefined;
      let linkedTree: ResolvedComponentNode | null = null;
      try {
        configPath = await configPathFromReference(location, node.component);
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
        slots: linkedTree ? { content: [linkedTree] } : {},
        source: "config",
        sourceConfigPath: location.configPath,
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
    if (node.component === "@dash-bored/command" && node.id === undefined) {
      diagnostics.push(
        diagnostic({
          code: "NODE_ID_REQUIRED",
          message: "Command components require an explicit id so their process remains stable across reloads.",
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

    const nodePermissions = new Set(manifest.permissions ?? []);
    permissionsByNode.set(id, nodePermissions);
    projectRootsByNode.set(id, location.projectRoot);
    for (const permission of nodePermissions) requestedPermissions.add(permission);

    const declaredSlots = manifest.slots ?? {};
    const configuredSlots = node.slots ?? {};
    for (const slotName of Object.keys(configuredSlots)) {
      if (!Object.hasOwn(declaredSlots, slotName)) {
        diagnostics.push(
          diagnostic({
            code: "COMPONENT_SLOT_UNKNOWN",
            message: `${manifest.name} does not declare a ${slotName} slot.`,
            path: `${nodePath}.slots.${slotName}`,
          }),
        );
      }
    }

    const resolvedSlots: Record<string, ResolvedComponentNode[]> = {};
    for (const [slotName, definition] of Object.entries(declaredSlots)) {
      const configured = Object.hasOwn(configuredSlots, slotName)
        ? configuredSlots[slotName]
        : undefined;
      const children = configured === undefined ? [] : Array.isArray(configured) ? configured : [configured];
      if (definition.required === true && children.length === 0) {
        diagnostics.push(
          diagnostic({
            code: "COMPONENT_SLOT_REQUIRED",
            message: `${manifest.name} requires its ${slotName} slot.`,
            path: `${nodePath}.slots.${slotName}`,
          }),
        );
      }
      if (definition.multiple !== true && children.length > 1) {
        diagnostics.push(
          diagnostic({
            code: "COMPONENT_SLOT_CARDINALITY",
            message: `${manifest.name}'s ${slotName} slot accepts only one child.`,
            path: `${nodePath}.slots.${slotName}`,
          }),
        );
      }
      const resolvedChildren = await Promise.all(
        children.map((child, index) => visit(child, pathForChild(nodePath, slotName, index), depth + 1)),
      );
      resolvedSlots[slotName] = resolvedChildren.filter(
        (child): child is ResolvedComponentNode => child !== null,
      );
    }

    // Visit unknown-slot children too, so users receive useful nested diagnostics.
    for (const [slotName, configured] of Object.entries(configuredSlots)) {
      if (Object.hasOwn(declaredSlots, slotName)) continue;
      const children = Array.isArray(configured) ? configured : [configured];
      await Promise.all(
        children.map((child, index) => visit(child, pathForChild(nodePath, slotName, index), depth + 1)),
      );
    }

    visiting.delete(node);
    return {
      id,
      component: node.component,
      props,
      slots: resolvedSlots,
      source: node.component.startsWith(LOCAL_REFERENCE_PREFIX) ? "local" : "builtin",
      sourceConfigPath: location.configPath,
      ...(node.component.startsWith(LOCAL_REFERENCE_PREFIX) ? { manifest } : {}),
    };
  };

  const tree = await visit(config.root, "root", 0);
  if (tree !== null) {
    const commandIds = new Set<string>();
    const terminalNodes: ResolvedComponentNode[] = [];
    const allNodes: ResolvedComponentNode[] = [];
    const collect = (node: ResolvedComponentNode): void => {
      allNodes.push(node);
      if (node.component === "@dash-bored/command") commandIds.add(node.id);
      if (node.component === "@dash-bored/terminal") terminalNodes.push(node);
      for (const children of Object.values(node.slots)) {
        for (const child of children) collect(child);
      }
    };
    collect(tree);

    for (const node of terminalNodes) {
      const processId = String(node.props.processId);
      if (!commandIds.has(processId)) {
        diagnostics.push(
          diagnostic({
            code: "TERMINAL_PROCESS_UNKNOWN",
            message: `Terminal references unknown command node: ${processId}`,
            path: `${node.id}.props.processId`,
          }),
        );
      }
    }
    for (const node of allNodes) {
      if (node.component === "@dash-bored/command" && typeof node.props.cwd === "string") {
        try {
          await resolveContainedPath(location.projectRoot, node.props.cwd, { kind: "directory" });
        } catch (error) {
          diagnostics.push(
            diagnostic({
              code: "COMMAND_CWD_INVALID",
              message: errorMessage(error),
              path: `${node.id}.props.cwd`,
            }),
          );
        }
      }
      if (node.component === "@dash-bored/tabs") {
        const children = node.slots.children ?? [];
        const labels = node.props.labels;
        if (Array.isArray(labels) && labels.length !== children.length) {
          diagnostics.push(
            diagnostic({
              code: "TABS_LABEL_COUNT_INVALID",
              message: "Tabs labels must contain one label for each child.",
              path: `${node.id}.props.labels`,
            }),
          );
        }
        const defaultTab = node.props.defaultTab;
        if (typeof defaultTab === "number" && defaultTab >= children.length) {
          diagnostics.push(
            diagnostic({
              code: "TABS_DEFAULT_INVALID",
              message: "Tabs defaultTab must refer to an existing child.",
              path: `${node.id}.props.defaultTab`,
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
