import type {
  ComponentChildLayout,
  ComponentChildrenDefinition,
  ComponentNode,
  DashboardConfigSource,
  DashboardInsertionTarget,
  Diagnostic,
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

export interface DiagnosticsAgentContext {
  projectRoot: string;
  configPath: string;
  diagnostics: readonly Diagnostic[];
}

export function findResolvedNode(
  root: ResolvedComponentNode,
  nodeId: string,
): ResolvedComponentNode | null {
  if (root.id === nodeId) return root;
  const edges = root.children?.type === "managed"
    ? root.children.items
    : root.children?.type === "tiled"
      ? collectLayoutEdges(root.children.layout)
      : [];
  for (const edge of edges) {
    const found = findResolvedNode(edge.node, nodeId);
    if (found) return found;
  }
  return null;
}

function collectLayoutEdges(
  layout: Extract<NonNullable<ResolvedComponentNode["children"]>, { type: "tiled" }>["layout"],
): Array<{ node: ResolvedComponentNode }> {
  if (layout.type === "child") return [layout.child];
  return [...collectLayoutEdges(layout.first), ...collectLayoutEdges(layout.second)];
}

export function componentPath(node: ResolvedComponentNode): string {
  const configPath = node.sourceConfigPath ?? "dash-bored.yaml";
  const sourcePath = node.sourcePath ?? `id=${encodeURIComponent(node.id)}`;
  return `${configPath}#${sourcePath}`;
}

function dashboardParentPath(target: DashboardInsertionTarget): string {
  return target.parentPath.reduce(
    (path, segment) => {
      if (segment.type === "managed") {
        return `${path}.children.items[${segment.index}].node`;
      }
      const layoutPath = segment.path.map((branch) => `.${branch}`).join("");
      return `${path}.children.layout${layoutPath}.child.node`;
    },
    "root",
  );
}

export function dashboardInsertionPath(
  target: DashboardInsertionTarget,
  tiledMode: "empty" | "split",
): string;
export function dashboardInsertionPath(
  target: DashboardInsertionTarget,
  tiledMode?: "empty" | "split",
): string {
  const parentPath = dashboardParentPath(target);
  if (target.placement.type === "managed") {
    return `${parentPath}.children.items[${target.placement.index}]`;
  }
  if (tiledMode === undefined) {
    throw new Error("Tiled insertion paths require an empty or split mode.");
  }
  if (tiledMode === "empty") return `${parentPath}.children.layout.child`;
  const layoutPath = target.placement.path.map((branch) => `.${branch}`).join("");
  return `${parentPath}.children.layout${layoutPath}.${target.placement.position}.child`;
}

function validIndex(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validLayoutPath(value: unknown): value is Array<"first" | "second"> {
  return Array.isArray(value) && value.every((branch) => branch === "first" || branch === "second");
}

function childAtLayoutPath(
  layout: ComponentChildLayout,
  path: readonly ("first" | "second")[],
): ComponentNode | null {
  let current = layout;
  for (const branch of path) {
    if (current.type !== "split") return null;
    current = current[branch];
  }
  return current.type === "child" ? current.child.node : null;
}

function childCount(node: ComponentNode): number {
  if (node.children === undefined) return 0;
  if (node.children.type === "managed") return node.children.items.length;
  const countLayout = (layout: ComponentChildLayout): number =>
    layout.type === "child" ? 1 : countLayout(layout.first) + countLayout(layout.second);
  return countLayout(node.children.layout);
}

function childrenDefinition(
  source: DashboardConfigSource,
  node: ComponentNode,
): ComponentChildrenDefinition | null {
  const item = source.componentCatalog.find((candidate) => candidate.reference === node.component);
  return item?.available === true ? item.manifest?.children ?? null : null;
}

function configuredPresentationIsValid(
  node: ComponentNode,
  definition: ComponentChildrenDefinition,
): boolean {
  return node.children === undefined || node.children.type === definition.presentation.type;
}

function configuredCardinalityIsValid(
  node: ComponentNode,
  definition: ComponentChildrenDefinition,
): boolean {
  const count = childCount(node);
  return count >= definition.min && (definition.max === undefined || count <= definition.max);
}

/**
 * Resolves a fresh editor insertion target against the current config and catalog.
 * Returns null when any locator, manifest contract, or capacity assumption is stale.
 */
export function resolveDashboardInsertionPath(
  source: DashboardConfigSource,
  target: DashboardInsertionTarget,
): string | null {
  if (
    target === null ||
    typeof target !== "object" ||
    !Array.isArray(target.parentPath) ||
    target.placement === null ||
    typeof target.placement !== "object"
  ) return null;
  let parent = source.config.root;
  for (const segment of target.parentPath) {
    if (segment === null || typeof segment !== "object") return null;
    const definition = childrenDefinition(source, parent);
    if (
      definition === null ||
      !configuredPresentationIsValid(parent, definition) ||
      !configuredCardinalityIsValid(parent, definition)
    ) return null;
    if (segment.type === "managed") {
      if (
        definition.presentation.type !== "managed" ||
        parent.children?.type !== "managed" ||
        !validIndex(segment.index) ||
        segment.index >= parent.children.items.length
      ) return null;
      parent = parent.children.items[segment.index]!.node;
      continue;
    }
    if (
      segment.type !== "tiled" ||
      definition.presentation.type !== "tiled" ||
      parent.children?.type !== "tiled" ||
      !validLayoutPath(segment.path)
    ) return null;
    const child = childAtLayoutPath(parent.children.layout, segment.path);
    if (child === null) return null;
    parent = child;
  }

  const definition = childrenDefinition(source, parent);
  if (definition === null || !configuredPresentationIsValid(parent, definition)) return null;
  const count = childCount(parent);
  const nextCount = count + 1;
  if (nextCount < definition.min || (definition.max !== undefined && nextCount > definition.max)) {
    return null;
  }

  const placement = target.placement;
  if (placement.type === "managed") {
    if (definition.presentation.type !== "managed" || !validIndex(placement.index)) return null;
    const length = parent.children?.type === "managed" ? parent.children.items.length : 0;
    if (placement.index > length) return null;
    return dashboardInsertionPath(target, "split");
  }
  if (
    placement.type !== "tiled" ||
    definition.presentation.type !== "tiled" ||
    !validLayoutPath(placement.path) ||
    (placement.position !== "first" && placement.position !== "second") ||
    (placement.axis !== "horizontal" && placement.axis !== "vertical") ||
    (definition.presentation.axes !== "both" && definition.presentation.axes !== placement.axis) ||
    (placement.ratio !== undefined && (
      !Number.isFinite(placement.ratio) || placement.ratio < 0.1 || placement.ratio > 0.9
    ))
  ) return null;

  if (parent.children === undefined) {
    return placement.path.length === 0 ? dashboardInsertionPath(target, "empty") : null;
  }
  if (parent.children.type !== "tiled") return null;
  return childAtLayoutPath(parent.children.layout, placement.path) === null
    ? null
    : dashboardInsertionPath(target, "split");
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

export function buildDiagnosticsAgentPrompt(
  context: DiagnosticsAgentContext,
): string {
  const diagnostics = context.diagnostics.map((item) => {
    const location = [
      item.file,
      item.path,
      item.line === undefined ? null : `line ${item.line}`,
      item.column === undefined ? null : `column ${item.column}`,
    ].filter(Boolean).join(" · ");
    return `- ${item.severity.toUpperCase()} ${item.code}: ${item.message}${location ? ` (${location})` : ""}`;
  }).join("\n");

  return [
    "You are fixing a dash-bored dashboard configuration after its diagnostics panel reported problems.",
    "Inspect the project and its instructions before editing, use the installed dash-bored skill when available, preserve unrelated changes, fix the underlying configuration issues, and validate the result.",
    `Project root: ${context.projectRoot}`,
    `Owning dashboard config: ${context.configPath}`,
    "",
    "Reported diagnostics:",
    diagnostics,
  ].join("\n");
}
