import type {
  DashboardInsertionTarget,
  ResolvedComponentNode,
} from "./contracts";

export interface ComponentAgentContext {
  projectRoot: string;
  configPath: string;
  componentPath: string;
  componentId: string;
  componentReference: string;
}

export interface ComponentCreationAgentContext {
  projectRoot: string;
  configPath: string;
  insertionPath: string;
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

export function dashboardInsertionPath(target: DashboardInsertionTarget): string {
  const parentPath = target.parentPath.reduce(
    (path, segment) => `${path}.slots.${segment.slot}[${segment.index}]`,
    "root",
  );
  return `${parentPath}.slots.${target.slot}[${target.index}]`;
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

export function buildComponentCreationAgentPrompt(
  context: ComponentCreationAgentContext,
  userPrompt: string,
): string {
  return [
    "You are adding a component to a dash-bored dashboard from its structural editor.",
    "Use the installed dash-bored skill when available. Inspect the project and its instructions before editing, preserve unrelated changes, and validate the result.",
    "No component in the dashboard catalog matched the user's description. Build a project-local component for this dashboard, then add its component node at the exact YAML insertion path below.",
    `Project root: ${context.projectRoot}`,
    `Owning dashboard config: ${context.configPath}`,
    `YAML insertion path: ${context.insertionPath}`,
    "",
    "User component description:",
    userPrompt.trim(),
  ].join("\n");
}
