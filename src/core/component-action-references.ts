import type { Diagnostic, ResolvedComponentNode } from "../shared/contracts";
import { parseComponentActionReference } from "../shared/action-reference";
import { actionInvocation } from "../shared/action-invocation";
import { diagnostic } from "./diagnostics";

/** Check stable component action references only when the target opts into declarations. */
export function validateDeclaredComponentActionReferences(
  nodes: readonly ResolvedComponentNode[],
): Diagnostic[] {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const diagnostics: Diagnostic[] = [];
  for (const node of nodes) {
    for (const [propName, referenceDefinition] of Object.entries(node.manifest?.references ?? {})) {
      if (referenceDefinition.resource !== "action") continue;
      const invocation = actionInvocation(node.props[propName]);
      if (!invocation) continue;
      const target = parseComponentActionReference(invocation.run);
      if (!target) continue;
      const targetNode = nodesById.get(target.nodeId);
      const declaredActions = targetNode?.manifest?.actions;
      // Omission is the legacy dynamic-registration contract. In particular,
      // package-scripts discovers action IDs from package.json at runtime.
      if (declaredActions === undefined) continue;
      if (declaredActions.some((action) => action.id === target.actionId)) continue;
      diagnostics.push(diagnostic({
        code: "COMPONENT_ACTION_REFERENCE_UNKNOWN",
        message: `${targetNode?.manifest?.name ?? targetNode?.component ?? target.nodeId} does not declare action ${target.actionId}.`,
        path: `${node.id}.props.${propName}`,
      }));
    }
  }
  return diagnostics;
}
