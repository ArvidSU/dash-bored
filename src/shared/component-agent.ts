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

/**
 * A validated insertion target restated as the YAML edit the structural editor
 * would make, so an agent can reproduce it without inferring split semantics.
 */
export interface DashboardInsertion {
  /** YAML path of the new child edge once inserted. */
  path: string;
  /** YAML path of the node whose `children` receives the edge. */
  parentPath: string;
  parent: NodeSummary;
  placement:
    | { type: "managed"; index: number; childCount: number }
    | { type: "empty" }
    | {
        type: "split";
        /** YAML path of the existing edge that becomes the split. */
        edgePath: string;
        existing: NodeSummary;
        axis: "horizontal" | "vertical";
        position: "first" | "second";
        /** Written only for a non-default horizontal ratio, as the editor does. */
        ratio?: number;
      };
  /** Edge metadata the editor would write for the new edge. */
  metadata?: Record<string, unknown>;
}

export interface NodeSummary {
  id?: string;
  component: string;
}

export interface ComponentCreationAgentContext {
  projectRoot: string;
  configPath: string;
  insertion: DashboardInsertion;
}

export interface DiagnosticsAgentContext {
  projectRoot: string;
  configPath: string;
  diagnostics: readonly Diagnostic[];
  originalPrompt?: string;
}

export function findResolvedNode(
  root: ResolvedComponentNode,
  nodeId: string,
): ResolvedComponentNode | null {
  if (root.id === nodeId) return root;
  const edges = Array.isArray(root.children)
    ? root.children
    : root.children !== undefined
      ? collectLayoutEdges(root.children)
      : [];
  for (const edge of edges) {
    const found = findResolvedNode(edge.node, nodeId);
    if (found) return found;
  }
  return null;
}

function collectLayoutEdges(
  layout: ComponentChildLayout<ResolvedComponentNode>,
): Array<{ node: ResolvedComponentNode }> {
  if ("node" in layout) return [layout];
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
        return `${path}.children[${segment.index}].node`;
      }
      const layoutPath = segment.path.map((branch) => `.${branch}`).join("");
      return `${path}.children${layoutPath}.node`;
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
    return `${parentPath}.children[${target.placement.index}]`;
  }
  if (tiledMode === undefined) {
    throw new Error("Tiled insertion paths require an empty or split mode.");
  }
  if (tiledMode === "empty") return `${parentPath}.children`;
  const layoutPath = target.placement.path.map((branch) => `.${branch}`).join("");
  return `${parentPath}.children${layoutPath}.${target.placement.position}`;
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
    if (!("axis" in current)) return null;
    current = current[branch];
  }
  return "node" in current ? current.node : null;
}

function childCount(node: ComponentNode): number {
  if (node.children === undefined) return 0;
  if (Array.isArray(node.children)) return node.children.length;
  const countLayout = (layout: ComponentChildLayout): number =>
    "node" in layout ? 1 : countLayout(layout.first) + countLayout(layout.second);
  return countLayout(node.children);
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
  return node.children === undefined || (Array.isArray(node.children) ? "managed" : "tiled") === definition.presentation.type;
}

function configuredCardinalityIsValid(
  node: ComponentNode,
  definition: ComponentChildrenDefinition,
): boolean {
  const count = childCount(node);
  return count >= definition.min && (definition.max === undefined || count <= definition.max);
}

function nodeSummary(node: ComponentNode): NodeSummary {
  return node.id === undefined ? { component: node.component } : { id: node.id, component: node.component };
}

/** Mirrors the editor's split-ratio normalization: three decimals, 0.5 omitted. */
function writtenSplitRatio(
  axis: "horizontal" | "vertical",
  ratio: number | undefined,
): number | undefined {
  if (axis !== "horizontal" || ratio === undefined) return undefined;
  const rounded = Math.round(ratio * 1_000) / 1_000;
  return rounded === 0.5 ? undefined : rounded;
}

function insertionMetadata(
  metadata: Record<string, unknown> | undefined,
): Pick<DashboardInsertion, "metadata"> {
  return metadata !== null && typeof metadata === "object" && Object.keys(metadata).length > 0
    ? { metadata: structuredClone(metadata) }
    : {};
}

/**
 * Resolves a fresh editor insertion target against the current config and catalog.
 * Returns null when any locator, manifest contract, or capacity assumption is stale.
 */
export function resolveDashboardInsertion(
  source: DashboardConfigSource,
  target: DashboardInsertionTarget,
): DashboardInsertion | null {
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
        !Array.isArray(parent.children) ||
        !validIndex(segment.index) ||
        segment.index >= parent.children.length
      ) return null;
      parent = parent.children[segment.index]!.node;
      continue;
    }
    if (
      segment.type !== "tiled" ||
      definition.presentation.type !== "tiled" ||
      (parent.children === undefined || Array.isArray(parent.children)) ||
      !validLayoutPath(segment.path)
    ) return null;
    const child = childAtLayoutPath(parent.children, segment.path);
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
  const parentPath = dashboardParentPath(target);
  const common = { parentPath, parent: nodeSummary(parent), ...insertionMetadata(placement.metadata) };
  if (placement.type === "managed") {
    if (definition.presentation.type !== "managed" || !validIndex(placement.index)) return null;
    const length = Array.isArray(parent.children) ? parent.children.length : 0;
    if (placement.index > length) return null;
    return {
      path: dashboardInsertionPath(target, "split"),
      ...common,
      placement: { type: "managed", index: placement.index, childCount: length },
    };
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
    return placement.path.length === 0
      ? { path: dashboardInsertionPath(target, "empty"), ...common, placement: { type: "empty" } }
      : null;
  }
  if (Array.isArray(parent.children)) return null;
  const existing = childAtLayoutPath(parent.children, placement.path);
  if (existing === null) return null;
  const ratio = writtenSplitRatio(placement.axis, placement.ratio);
  return {
    path: dashboardInsertionPath(target, "split"),
    ...common,
    placement: {
      type: "split",
      edgePath: `${parentPath}.children${placement.path.map((branch) => `.${branch}`).join("")}`,
      existing: nodeSummary(existing),
      axis: placement.axis,
      position: placement.position,
      ...(ratio === undefined ? {} : { ratio }),
    },
  };
}

function describeNode(node: NodeSummary): string {
  return node.id === undefined ? `the ${node.component} node` : `node \`${node.id}\` (${node.component})`;
}

/** States the exact YAML edit the structural editor would make for this insertion. */
export function describeDashboardInsertion(insertion: DashboardInsertion): string {
  const { placement } = insertion;
  const parent = `${describeNode(insertion.parent)} at ${insertion.parentPath}`;
  const newEdge = insertion.metadata === undefined
    ? "{ node: <new node> }"
    : `{ metadata: ${JSON.stringify(insertion.metadata)}, node: <new node> }`;
  const metadataNote = insertion.metadata === undefined
    ? ""
    : " Replace placeholder metadata values with a fitting name.";
  let edit: string;
  if (placement.type === "managed") {
    edit = placement.childCount === 0
      ? `${parent} has no children yet; set its \`children\` to a list holding only the new edge \`${newEdge}\`.`
      : placement.index === placement.childCount
        ? `Append the new edge \`${newEdge}\` to the \`children\` list of ${parent}, after its ${placement.childCount} current item${placement.childCount === 1 ? "" : "s"}.`
        : `Insert the new edge \`${newEdge}\` into the \`children\` list of ${parent} at index ${placement.index}, before the item now at that index.`;
  } else if (placement.type === "empty") {
    edit = `${parent} has no children yet; set its \`children\` to the single edge \`${newEdge}\`, with no split.`;
  } else {
    const side = placement.axis === "horizontal"
      ? (placement.position === "first" ? "left of" : "right of")
      : (placement.position === "first" ? "above" : "below");
    const existing = "<existing edge, unchanged>";
    const [first, second] = placement.position === "first" ? [newEdge, existing] : [existing, newEdge];
    const ratio = placement.ratio === undefined ? "" : `ratio: ${placement.ratio}, `;
    const ratioNote = placement.ratio !== undefined
      ? ""
      : placement.axis === "horizontal" ? " Omit `ratio` (equal widths)." : " Vertical splits have no `ratio`.";
    edit = `Split the tile of ${describeNode(placement.existing)} so the new node sits ${side} it: replace the edge at ${placement.edgePath} with \`{ axis: ${placement.axis}, ${ratio}first: ${first}, second: ${second} }\`.${ratioNote}`;
  }
  return `${edit.charAt(0).toUpperCase()}${edit.slice(1)}${metadataNote}`;
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
    "The editor's catalog text search found no component for the user's description, but a built-in view (status, list, chart, or markdown) fed by a small source script often still fits, with item actions or agent:prompt for follow-up work. Prefer that; build a small project-local component only when no view can present it. Either way, add the new node exactly as the placement below says.",
    `Project root: ${context.projectRoot}`,
    `Owning dashboard config: ${context.configPath}`,
    `YAML insertion path: ${context.insertion.path}`,
    `Placement: ${describeDashboardInsertion(context.insertion)}`,
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
    ...(context.originalPrompt ? ["", "Original setup request:", context.originalPrompt] : []),
  ].join("\n");
}
