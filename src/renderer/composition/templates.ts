import type { ComponentCatalogItem, ComponentNode, DashboardConfig } from "../../shared/contracts";
import type { ComponentTemplate } from "../../shared/package-templates";
import { childEdges } from "../../shared/child-edges";
import { remapActionReferenceNode } from "../../shared/action-reference";
import { actionInvocation } from "../../shared/action-invocation";
import { referenceLocations } from "../../shared/reference-locations";

/** Allocate fresh IDs and rewrite declared bindings, without interpreting component props. */
export function instantiateTemplateNode(template: ComponentTemplate, config: DashboardConfig, catalog: readonly ComponentCatalogItem[]): ComponentNode {
  const used = new Set<string>();
  const visit = (node: ComponentNode, callback: (node: ComponentNode) => void): void => {
    callback(node);
    for (const edge of childEdges(node.children)) visit(edge.node, callback);
  };
  visit(config.root, (node) => { if (node.id) used.add(node.id); });
  const root = structuredClone(template.root);
  const ids = new Map<string, string>();
  visit(root, (node) => {
    const base = node.id ?? "panel";
    let id = base;
    let suffix = 2;
    while (used.has(id)) id = `${base}-${suffix++}`;
    used.add(id);
    if (node.id) {
      if (ids.has(node.id)) throw new Error(`Duplicate template node ID: ${node.id}`);
      ids.set(node.id, id);
    }
    node.id = id;
  });
  const remap = (value: string): string => remapActionReferenceNode(value, (id) => ids.get(id));
  visit(root, (node) => {
    const manifest = catalog.find((item) => item.reference === node.component)?.manifest;
    if (!manifest) throw new Error(`Template component is unavailable: ${node.component}`);
    const props = node.props ?? {};
    const defaultProp = manifest.children?.defaultChildProp;
    if (defaultProp) {
      for (const { parent, key } of referenceLocations(props, defaultProp)) {
        const value = parent[key];
        if (typeof value === "string" && ids.has(value)) parent[key] = ids.get(value)!;
      }
    }
    for (const [path, definition] of Object.entries(manifest.references ?? {})) {
      for (const { parent, key } of referenceLocations(props, path)) {
        const value = parent[key];
        if (definition.resource === "process") {
          if (typeof value === "string" && ids.has(value)) parent[key] = ids.get(value)!;
        } else {
          const invocation = actionInvocation(value);
          if (invocation) parent[key] = typeof value === "string" ? remap(invocation.run) : { ...(value as Record<string, unknown>), run: remap(invocation.run) };
        }
      }
    }
    if (node.watch?.action) node.watch.action.run = remap(node.watch.action.run);
  });
  return root;
}
