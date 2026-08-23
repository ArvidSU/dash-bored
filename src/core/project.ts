import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  ComponentCatalogItem,
  CompiledLocalComponent,
  DashboardConfig,
  DashboardLock,
  Diagnostic,
  InspectResult,
  Permission,
  ResolvedComponentNode,
} from "../shared/contracts";
import { compileLocalComponents } from "./compiler";
import { diagnostic, errorMessage, hasErrors } from "./diagnostics";
import {
  assertProjectLocationContained,
  resolveProjectLocation,
  type ProjectLocation,
} from "./paths";
import {
  discoverComponentCatalog,
  resolveComponentTree,
  type LocalComponentDefinition,
} from "./tree";
import {
  parseDashboardConfig,
  parseDashboardLock,
  validateDashboardConfigValue,
} from "./yaml";

export interface ProjectDefinition {
  ok: boolean;
  location: ProjectLocation;
  config: DashboardConfig | null;
  configRevision: string | null;
  componentCatalog: ComponentCatalogItem[];
  lock: DashboardLock | null;
  tree: ResolvedComponentNode | null;
  manifests: InspectResult["components"];
  localComponents: LocalComponentDefinition[];
  compiledComponents: CompiledLocalComponent[];
  permissions: Permission[];
  permissionsByNode: Map<string, ReadonlySet<Permission>>;
  projectRootsByNode: Map<string, string>;
  diagnostics: Diagnostic[];
}

export interface InspectProjectOptions {
  compile?: boolean;
}

export async function readConfigRevision(configPath: string): Promise<string> {
  return createHash("sha256").update(await readFile(configPath)).digest("hex");
}

async function buildProjectDefinition(
  location: ProjectLocation,
  config: DashboardConfig | null,
  lock: DashboardLock | null,
  diagnostics: Diagnostic[],
  configRevision: string | null,
  componentCatalog: ComponentCatalogItem[],
  options: InspectProjectOptions,
): Promise<ProjectDefinition> {
  let tree: ResolvedComponentNode | null = null;
  let manifests: InspectResult["components"] = [];
  let localComponents: LocalComponentDefinition[] = [];
  let compiledComponents: CompiledLocalComponent[] = [];
  let permissions: Permission[] = [];
  let permissionsByNode = new Map<string, ReadonlySet<Permission>>();
  let projectRootsByNode = new Map<string, string>();

  if (config !== null && lock !== null) {
    const resolvedTree = await resolveComponentTree(location, config);
    diagnostics.push(...resolvedTree.diagnostics);
    manifests = resolvedTree.components;
    localComponents = resolvedTree.localComponents;
    permissions = resolvedTree.permissions;
    permissionsByNode = resolvedTree.permissionsByNode;
    projectRootsByNode = resolvedTree.projectRootsByNode;
    if (!hasErrors(diagnostics)) tree = resolvedTree.tree;

    if (resolvedTree.tree !== null) {
      const known = new Set(componentCatalog.map((item) => item.reference));
      const visitConfigLinks = (node: ResolvedComponentNode): void => {
        if (node.source === "config" && !known.has(node.component)) {
          known.add(node.component);
          componentCatalog.push({
            reference: node.component,
            source: "config",
            available: node.configError === undefined,
            manifest: {
              schemaVersion: 1,
              id: `config:${node.component}`,
              name: node.configName ?? node.component,
              description: "Renders another standalone dashboard configuration.",
              entry: "config:link",
              propsSchema: { type: "object", additionalProperties: false },
            },
            diagnostics: node.configError === undefined
              ? []
              : [diagnostic({ code: "CONFIG_LINK_UNAVAILABLE", message: node.configError, path: node.component })],
          });
        }
        for (const children of Object.values(node.slots)) for (const child of children) visitConfigLinks(child);
      };
      visitConfigLinks(resolvedTree.tree);
    }

    if (options.compile === true && tree !== null) {
      const compiled = await compileLocalComponents(localComponents);
      diagnostics.push(...compiled.diagnostics);
      if (!hasErrors(compiled.diagnostics)) compiledComponents = compiled.components;
    }
  }

  const ok = !hasErrors(diagnostics) && tree !== null;
  if (!ok) tree = null;
  return {
    ok,
    location,
    config,
    configRevision,
    componentCatalog,
    lock,
    tree,
    manifests,
    localComponents,
    compiledComponents,
    permissions,
    permissionsByNode,
    projectRootsByNode,
    diagnostics,
  };
}

export async function loadProjectDefinition(
  input: string | ProjectLocation,
  options: InspectProjectOptions = {},
): Promise<ProjectDefinition> {
  const location = typeof input === "string" ? await resolveProjectLocation(input) : input;
  try {
    await assertProjectLocationContained(location);
  } catch (error) {
    return {
      ok: false,
      location,
      config: null,
      configRevision: null,
      componentCatalog: [],
      lock: null,
      tree: null,
      manifests: [],
      localComponents: [],
      compiledComponents: [],
      permissions: [],
      permissionsByNode: new Map(),
      projectRootsByNode: new Map(),
      diagnostics: [
        diagnostic({
          code: error instanceof Error && "code" in error ? String(error.code) : "PROJECT_PATH_UNSAFE",
          message: errorMessage(error),
        }),
      ],
    };
  }
  const [configResult, lockResult, configRevision, componentCatalog] = await Promise.all([
    parseDashboardConfig(location.configPath),
    parseDashboardLock(location.lockPath),
    readConfigRevision(location.configPath).catch(() => null),
    discoverComponentCatalog(location),
  ]);
  const diagnostics = [...configResult.diagnostics, ...lockResult.diagnostics];
  return buildProjectDefinition(
    location,
    configResult.value,
    lockResult.value,
    diagnostics,
    configRevision,
    componentCatalog,
    options,
  );
}

export async function validateProjectConfigDraft(
  location: ProjectLocation,
  config: DashboardConfig,
  options: InspectProjectOptions = {},
): Promise<ProjectDefinition> {
  await assertProjectLocationContained(location);
  const [lockResult, configRevision, componentCatalog] = await Promise.all([
    parseDashboardLock(location.lockPath),
    readConfigRevision(location.configPath).catch(() => null),
    discoverComponentCatalog(location),
  ]);
  const diagnostics = [
    ...validateDashboardConfigValue(config, location.configPath),
    ...lockResult.diagnostics,
  ];
  return buildProjectDefinition(
    location,
    diagnostics.length === 0 ? config : null,
    lockResult.value,
    diagnostics,
    configRevision,
    componentCatalog,
    options,
  );
}

export async function inspectProject(
  input: string,
  options: InspectProjectOptions = {},
): Promise<InspectResult> {
  try {
    const definition = await loadProjectDefinition(input, options);
    return {
      ok: definition.ok,
      projectRoot: definition.location.projectRoot,
      config: definition.config,
      lock: definition.lock,
      tree: definition.tree,
      components: definition.manifests,
      permissions: definition.permissions,
      diagnostics: definition.diagnostics,
    };
  } catch (error) {
    return {
      ok: false,
      projectRoot: resolve(input),
      config: null,
      lock: null,
      tree: null,
      components: [],
      permissions: [],
      diagnostics: [
        diagnostic({
          code: error instanceof Error && "code" in error ? String(error.code) : "PROJECT_LOAD_FAILED",
          message: errorMessage(error),
        }),
      ],
    };
  }
}

export async function validateProject(input: string): Promise<InspectResult> {
  return inspectProject(input, { compile: true });
}
