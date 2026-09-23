import type { Diagnostic, ResolvedComponentNode } from "../shared/contracts";
import { parseComponentActionReference } from "../shared/action-reference";
import { actionInvocation } from "../shared/action-invocation";
import { diagnostic } from "./diagnostics";

function referenceValues(root: Record<string, unknown>, path: string): Array<{ value: unknown; suffix: string }> {
  const values: Array<{ value: unknown; suffix: string }> = [];
  const parts = path.split(".");
  const visit = (current: unknown, index: number, prefix: string[]): void => {
    if (index === parts.length) {
      values.push({ value: current, suffix: prefix.join(".") });
      return;
    }
    const part = parts[index]!;
    if (part === "*") {
      if (Array.isArray(current)) current.forEach((item, itemIndex) => visit(item, index + 1, [...prefix, String(itemIndex)]));
    } else if (current && typeof current === "object" && !Array.isArray(current)) {
      visit((current as Record<string, unknown>)[part], index + 1, [...prefix, part]);
    }
  };
  visit(root, 0, []);
  return values;
}

/** Check stable component action references only when the target opts into declarations. */
export function validateDeclaredComponentActionReferences(
  nodes: readonly ResolvedComponentNode[],
): Diagnostic[] {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const diagnostics: Diagnostic[] = [];
  for (const node of nodes) {
    for (const [propName, referenceDefinition] of Object.entries(node.manifest?.references ?? {})) {
      if (referenceDefinition.resource !== "action") continue;
      for (const { value, suffix } of referenceValues(node.props, propName)) {
        const invocation = actionInvocation(value);
        if (!invocation) continue;
        const target = parseComponentActionReference(invocation.run);
        if (!target) continue;
        const targetNode = nodesById.get(target.nodeId);
        const declaredActions = targetNode?.manifest?.actions;
        // Omission is the legacy dynamic-registration contract.
        if (declaredActions === undefined) continue;
        if (declaredActions.some((action) => action.id === target.actionId)) continue;
        diagnostics.push(diagnostic({
          code: "COMPONENT_ACTION_REFERENCE_UNKNOWN",
          message: `${targetNode?.manifest?.name ?? targetNode?.component ?? target.nodeId} does not declare action ${target.actionId}.`,
          path: `${node.id}.props.${suffix}`,
        }));
      }
    }
  }
  return diagnostics;
}
