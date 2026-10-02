import type { Diagnostic, ResolvedComponentNode } from "../shared/contracts";
import { parseSelectionActionReference } from "../shared/action-reference";
import { actionInvocation } from "../shared/action-invocation";
import { diagnostic, errorMessage } from "./diagnostics";
import { referenceLocations } from "./tree-links";

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

/** A target still written as a `${root…}` YAML path instead of a node ID. */
export function isLegacyActionTarget(target: string): boolean {
  return target.includes("${") || /[{}]/.test(target);
}

/**
 * Rewrite positional action targets in one bundle's resolved nodes to the
 * node IDs they resolve to. Props are rewritten in place: they are the loaded
 * config's own objects, so editor sources and saves persist stable IDs.
 * References rejected for another reason (item templates in the target,
 * selection syntax) are left to validation.
 */
export function migrateLegacyActionReferences(nodes: readonly ResolvedComponentNode[]): Diagnostic[] {
  const nodesByBundlePath = new Map<string, ResolvedComponentNode>();
  for (const node of nodes) {
    if (node.sourceConfigPath && node.sourcePath) {
      nodesByBundlePath.set(JSON.stringify([node.sourceConfigPath, node.sourcePath]), node);
    }
  }
  const diagnostics: Diagnostic[] = [];
  for (const node of nodes) {
    for (const [propName, reference] of Object.entries(node.manifest?.references ?? {})) {
      if (reference.resource !== "action") continue;
      const allowsItemTemplates = propName.includes(".*.");
      for (const { parent, key, path } of referenceLocations(node.props, propName)) {
        const rawReference = parent[key];
        const target = actionInvocation(rawReference)?.run;
        if (
          target === undefined
          || !isLegacyActionTarget(target)
          || (allowsItemTemplates && target.includes("${item."))
          || parseSelectionActionReference(target)
        ) continue;
        const diagnosticPath = `${node.id}.props.${path}`;
        try {
          const migrated = resolveLegacyActionReference(target, (sourcePath) =>
            nodesByBundlePath.get(JSON.stringify([node.sourceConfigPath, sourcePath]))?.id);
          parent[key] = typeof rawReference === "string"
            ? migrated
            : { ...(rawReference as Record<string, unknown>), run: migrated };
          diagnostics.push(diagnostic({
            severity: "warning",
            code: "COMPONENT_ACTION_REFERENCE_DEPRECATED",
            message: "Positional action references are deprecated. Migrate this target to a stable node ID before dashboard schema v4.",
            path: diagnosticPath,
          }));
        } catch (error) {
          diagnostics.push(diagnostic({
            code: "COMPONENT_ACTION_REFERENCE_INVALID",
            message: errorMessage(error),
            path: diagnosticPath,
          }));
        }
      }
    }
  }
  return diagnostics;
}
