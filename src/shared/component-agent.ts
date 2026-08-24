import type { ResolvedComponentNode } from "./contracts";

export interface ComponentAgentContext {
  projectRoot: string;
  configPath: string;
  componentPath: string;
  componentId: string;
  componentReference: string;
}

export function findResolvedNode(
  root: ResolvedComponentNode,
  nodeId: string,
): ResolvedComponentNode | null {
  if (root.id === nodeId) return root;
  for (const children of Object.values(root.slots)) {
    for (const child of children) {
      const found = findResolvedNode(child, nodeId);
      if (found) return found;
    }
  }
  return null;
}

export function componentPath(node: ResolvedComponentNode): string {
  const configPath = node.sourceConfigPath ?? "dash-bored.yaml";
  const sourcePath = node.sourcePath ?? `id=${encodeURIComponent(node.id)}`;
  return `${configPath}#${sourcePath}`;
}

export function buildComponentAgentPrompt(
  context: ComponentAgentContext,
  userPrompt: string,
): string {
  return [
    "You are changing a dash-bored dashboard from its component context menu.",
    "Interpret the request in the dash-bored product and component-tree model. Inspect the project and its instructions before editing, use the installed dash-bored skill when available, preserve unrelated changes, and validate the result.",
    `Project root: ${context.projectRoot}`,
    `Owning dashboard config: ${context.configPath}`,
    `Target component path: ${context.componentPath}`,
    `Target component id: ${context.componentId}`,
    `Target component reference: ${context.componentReference}`,
    "",
    "User request:",
    userPrompt.trim(),
  ].join("\n");
}
