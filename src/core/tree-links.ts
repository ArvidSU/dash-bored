import { basename, isAbsolute, join, resolve } from "node:path";
import { realpath, stat } from "node:fs/promises";
import type {
  ComponentChildEdge,
  ComponentChildLayout,
  ComponentChildren,
  ComponentManifest,
  DashboardConfig,
  ResolvedComponentNode,
} from "../shared/contracts";
import { CONFIG_FILE } from "../shared/contracts";
import { remapActionReferenceNode } from "../shared/action-reference";
import { actionInvocation } from "../shared/action-invocation";
import { errorMessage } from "./diagnostics";
import { resolveProjectLocation, type ProjectLocation } from "./paths";
import { parseDashboardConfig, parseDashboardLock } from "./yaml";
import { isLocalReference } from "./tree-catalog";
import type { ResolvedTreeResult } from "./tree-resolve";

/**
 * Links between standalone dashboard bundles and the prop-level references
 * that name nodes. Resolution calls in here for config-link nodes; validation
 * and namespacing share the same reference-path walker.
 */

const MAX_CONFIG_LINK_DEPTH = 16;

export function childEdges<Node>(children: ComponentChildren<Node> | undefined): ComponentChildEdge<Node>[] {
  if (children === undefined) return [];
  if (Array.isArray(children)) return children;
  const edges: ComponentChildEdge<Node>[] = [];
  const collect = (layout: ComponentChildLayout<Node>): void => {
    if ("node" in layout) edges.push(layout);
    else {
      collect(layout.first);
      collect(layout.second);
    }
  };
  collect(children);
  return edges;
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

export interface ReferenceLocation {
  parent: Record<string, unknown>;
  key: string;
  path: string;
}

/**
 * Find every prop location named by a manifest reference path such as
 * `items.*.action`. A trailing `*` makes each array item a reference; its
 * location is the array and the item's index, so writes replace the item.
 */
export function referenceLocations(root: Record<string, unknown>, path: string): ReferenceLocation[] {
  const parts = path.split(".");
  const locations: ReferenceLocation[] = [];
  const visit = (value: unknown, index: number, prefix: string[]): void => {
    if (index >= parts.length) return;
    const part = parts[index]!;
    if (index === parts.length - 1) {
      if (part === "*") {
        if (Array.isArray(value)) value.forEach((_item, itemIndex) => {
          locations.push({ parent: value as unknown as Record<string, unknown>, key: String(itemIndex), path: [...prefix, String(itemIndex)].join(".") });
        });
      } else if (value && typeof value === "object" && !Array.isArray(value) && part in value) {
        locations.push({ parent: value as Record<string, unknown>, key: part, path: [...prefix, part].join(".") });
      }
      return;
    }
    if (part === "*") {
      if (Array.isArray(value)) value.forEach((item, itemIndex) => visit(item, index + 1, [...prefix, String(itemIndex)]));
      return;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      visit((value as Record<string, unknown>)[part], index + 1, [...prefix, part]);
    }
  };
  visit(root, 0, []);
  return locations;
}

function mapLayout<Node, Mapped>(
  layout: ComponentChildLayout<Node>,
  mapNode: (node: Node) => Mapped,
): ComponentChildLayout<Mapped> {
  if ("node" in layout) {
    return {
      node: mapNode(layout.node),
      ...(layout.metadata === undefined ? {} : { metadata: { ...layout.metadata } }),
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
  if (!Array.isArray(children)) {
    return mapLayout(children, mapNode);
  }
  return children.map((edge) => ({
    node: mapNode(edge.node),
    ...(edge.metadata === undefined ? {} : { metadata: { ...edge.metadata } }),
  }));
}

/** Copy a linked tree under `<prefix>::`, remapping node-bearing references. */
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
    const props = structuredClone(node.props);
    for (const [propName, reference] of Object.entries(node.manifest?.references ?? {})) {
      for (const { parent, key } of referenceLocations(props, propName)) {
        if (reference.resource === "action") {
          const invocation = actionInvocation(parent[key]);
          if (invocation) {
            const run = remapActionReferenceNode(invocation.run, (id) => ids.get(id));
            parent[key] = typeof parent[key] === "string"
              ? run
              : { ...(parent[key] as Record<string, unknown>), run };
          }
        } else if (typeof parent[key] === "string") {
          parent[key] = ids.get(parent[key]) ?? parent[key];
        }
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

export function configLinkManifest(reference: string, configName: string | undefined): ComponentManifest {
  return {
    schemaVersion: 2,
    id: `config:${reference}`,
    name: configName ?? reference,
    description: "Renders another standalone dashboard configuration.",
    entry: "config:link",
    renderMode: "layout",
    propsSchema: { type: "object", additionalProperties: false },
    children: {
      min: 0,
      max: 1,
      presentation: { type: "managed" },
    },
  };
}

export type ResolveTree = (
  location: ProjectLocation,
  config: DashboardConfig,
  configStack: readonly string[],
) => Promise<ResolvedTreeResult>;

export interface LinkedDashboard {
  configPath?: string;
  configName?: string;
  configError?: string;
  /** The linked bundle's resolution, already namespaced under the link node ID. */
  linked?: {
    tree: ResolvedComponentNode;
    ids: Map<string, string>;
    result: ResolvedTreeResult;
  };
}

/**
 * Resolve the standalone bundle behind a config-link node. A broken or
 * recursive link is reported on the link itself instead of failing the
 * containing dashboard.
 */
export async function resolveLinkedDashboard(
  location: ProjectLocation,
  reference: string,
  linkId: string,
  configStack: readonly string[],
  resolveTree: ResolveTree,
): Promise<LinkedDashboard> {
  let configPath: string | undefined;
  let configName: string | undefined;
  try {
    configPath = await resolveConfigReferencePath(location, reference);
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
    const result = await resolveTree(linkedLocation, linkedConfig.value, [...configStack, configPath]);
    if (!result.tree || result.diagnostics.some((item) => item.severity === "error")) {
      throw new Error(result.diagnostics[0]?.message ?? "The linked config could not be resolved.");
    }
    const namespaced = namespaceLinkedTree(result.tree, linkId);
    return { configPath, configName, linked: { ...namespaced, result } };
  } catch (error) {
    return {
      ...(configPath === undefined ? {} : { configPath }),
      ...(configName === undefined ? {} : { configName }),
      configError: errorMessage(error),
    };
  }
}
