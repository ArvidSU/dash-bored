import type { ComponentChildEdge, ComponentChildLayout, ComponentNode, DashboardConfig } from "../shared/contracts";

function edges(children: ComponentNode["children"]): ComponentChildEdge[] {
  if (children === undefined) return [];
  if (Array.isArray(children)) return children;
  const result: ComponentChildEdge[] = [];
  const visit = (layout: ComponentChildLayout): void => {
    if ("node" in layout) result.push(layout);
    else {
      visit(layout.first);
      visit(layout.second);
    }
  };
  visit(children);
  return result;
}

export interface ActionReferenceMigrationResult {
  config: DashboardConfig;
  migrated: number;
  assignedIds: number;
  diagnostics: string[];
}

/** Transitional schema-v3 resolver. Remove when the v4 migration is mandatory. */
export function resolveLegacyActionReference(
  reference: string,
  resolvePath: (path: string) => string | undefined,
): string {
  if (!reference.includes("${")) return reference;
  let count = 0;
  const result = reference.replace(/\$\{([^{}]*)\}/g, (_token, path: string) => {
    count += 1;
    if (!/^root(?:\.children(?:\[\d+\]|(?:\.(?:first|second))+)?\.node)*$/.test(path)) {
      throw new Error(`Malformed component node path: ${path || "(empty)"}`);
    }
    const id = resolvePath(path);
    if (id === undefined) throw new Error(`Component node path does not exist: ${path}`);
    return encodeURIComponent(id);
  });
  if (count !== (reference.match(/\$\{/g) ?? []).length || result.includes("${") || /[{}]/.test(result)) {
    throw new Error("Malformed component node path interpolation.");
  }
  return result;
}

/** Rewrite legacy `${root...}` action targets to stable IDs without changing topology. */
export function migrateActionReferences(
  config: DashboardConfig,
  isActionReference: (component: string, propPath: string) => boolean = (_component, propPath) => propPath === "action",
): ActionReferenceMigrationResult {
  const next = structuredClone(config);
  const byPath = new Map<string, ComponentNode>();
  const collect = (node: ComponentNode, path: string): void => {
    byPath.set(path, node);
    if (Array.isArray(node.children)) {
      node.children.forEach((edge, index) => collect(edge.node, `${path}.children[${index}].node`));
    } else if (node.children) {
      const walk = (layout: ComponentChildLayout, suffix: string): void => {
        if ("node" in layout) collect(layout.node, `${path}.children${suffix}.node`);
        else {
          walk(layout.first, `${suffix}.first`);
          walk(layout.second, `${suffix}.second`);
        }
      };
      walk(node.children, "");
    }
  };
  collect(next.root, "root");

  const used = new Set<string>();
  const markIds = (node: ComponentNode): void => {
    if (node.id) used.add(node.id);
    for (const edge of edges(node.children)) markIds(edge.node);
  };
  markIds(next.root);
  let migrated = 0;
  let assignedIds = 0;
  const diagnostics: string[] = [];
  const idFor = (node: ComponentNode): string => {
    if (node.id) return node.id;
    let index = 1;
    let id = `action-target-${index}`;
    while (used.has(id)) id = `action-target-${++index}`;
    node.id = id;
    used.add(id);
    assignedIds += 1;
    return id;
  };
  const rewrite = (reference: string, owner: ComponentNode): string => {
    try {
      resolveLegacyActionReference(reference, (path) => byPath.has(path) ? "migration-check" : undefined);
      const rewritten = resolveLegacyActionReference(reference, (path) => {
        const target = byPath.get(path);
        return target ? idFor(target) : undefined;
      });
      migrated += (reference.match(/\$\{[^{}]*\}/g) ?? []).length;
      return rewritten;
    } catch (error) {
      diagnostics.push(`Could not migrate action reference on ${owner.id ?? owner.component}: ${error instanceof Error ? error.message : String(error)}`);
      return reference;
    }
  };
  const visitProp = (node: ComponentNode, value: unknown, path: string): unknown => {
    if (typeof value === "string" && isActionReference(node.component, path) && value.includes("${")) {
      return rewrite(value, node);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const record = value as Record<string, unknown>;
    for (const [key, nested] of Object.entries(record)) record[key] = visitProp(node, nested, path ? `${path}.${key}` : key);
    return record;
  };
  const visit = (node: ComponentNode): void => {
    if (node.props) node.props = visitProp(node, node.props, "") as Record<string, unknown>;
    for (const edge of edges(node.children)) visit(edge.node);
  };
  visit(next.root);
  return { config: next, migrated, assignedIds, diagnostics };
}
