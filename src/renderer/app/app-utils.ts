import type {
  ComponentChildLayout,
  ComponentCatalogItem,
  ComponentNode,
  DashboardAgentTask,
  DashboardConfig,
  DashboardConfigSource,
  DashboardDraftValidation,
  ProcessSnapshot,
  ProjectListItem,
  ProjectOutline,
  ProjectSnapshot,
  ResolvedComponentNode,
} from "../../shared/contracts";
import { childEdges } from "../../shared/child-edges";
import type { SplitRatioOverrides } from "../render/split-layout";
import type { ThemeCatalogItem } from "../../shared/themes";
import type { DashboardCompositionSource } from "../composition/composition-interaction-controller";

export const EMPTY_SPLIT_RATIO_OVERRIDES: Readonly<SplitRatioOverrides> = Object.freeze({});

export function replaceProcess(
  snapshot: ProjectSnapshot,
  process: ProcessSnapshot,
): ProjectSnapshot {
  const index = snapshot.processes.findIndex((item) => item.id === process.id);
  const processes = [...snapshot.processes];
  if (index === -1) processes.push(process);
  else processes[index] = process;
  return { ...snapshot, processes };
}

export function replaceDashboardAgentTask(
  tasks: readonly DashboardAgentTask[],
  next: DashboardAgentTask,
): DashboardAgentTask[] {
  return [next, ...tasks.filter((task) => task.id !== next.id)]
    .sort((left, right) => (right.startedAt ?? "").localeCompare(left.startedAt ?? ""));
}

export function starterDashboardAgentTask(
  configPath: string | null | undefined,
  process: ProcessSnapshot,
): DashboardAgentTask | null {
  if (process.id !== "setup-dashboard-with-agent" || process.phase === "idle") return null;
  const resolvedConfigPath = configPath ?? "dash-bored.yaml";
  return {
    id: process.id,
    command: "DASH_BORED_AGENT",
    prompt: "Initial dashboard setup",
    componentPath: `${resolvedConfigPath}#id=${encodeURIComponent(process.id)}`,
    request: "Initial dashboard setup",
    configPath: resolvedConfigPath,
    startedAt: new Date().toISOString(),
    dashboardChanged: false,
    process,
  };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The header and region name: the configured dashboard name, else the project folder. */
export function dashboardTitle(snapshot: Pick<ProjectSnapshot, "dashboardName" | "projectRoot"> | null): string {
  return snapshot?.dashboardName?.trim() || (snapshot?.projectRoot ? basename(snapshot.projectRoot) : "dash-bored");
}

export function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

export function resolvedNodeById(
  root: ResolvedComponentNode,
  id: string,
): ResolvedComponentNode | null {
  if (root.id === id) return root;
  for (const edge of childEdges(root.children)) {
    const match = resolvedNodeById(edge.node, id);
    if (match) return match;
  }
  return null;
}

export function rememberProject(
  projects: ProjectListItem[],
  snapshot: ProjectSnapshot,
): ProjectListItem[] {
  if (snapshot.projectRoot === null || snapshot.configPath === undefined || snapshot.configPath === null) return projects;
  const item: ProjectListItem = {
    projectRoot: snapshot.projectRoot,
    configPath: snapshot.configPath,
    dashboardName: snapshot.dashboardName,
    iconDataUrl: snapshot.iconDataUrl,
  };
  const existingIndex = projects.findIndex(
    (project) => project.configPath === item.configPath,
  );
  if (existingIndex === -1) return [...projects, item];
  const next = [...projects];
  next[existingIndex] = item;
  return next;
}

export function dashboardKey(project: ProjectListItem): string {
  return project.configPath;
}

export interface ActionNotice {
  id: number;
  message: string;
}

export interface DashboardEditSession {
  projectRoot: string;
  configPath: string;
  /** Concrete config-link occurrence for namespacing resolved draft identities. */
  sourceNodeId?: string;
  componentCatalog: ComponentCatalogItem[];
  original: DashboardConfig;
  draft: DashboardConfig;
  validatedConfig: DashboardConfig;
  validatedDraft: string;
  expectedConfigRevision: string;
  validation: DashboardDraftValidation;
}

/** YAML mappings have no key order; child arrays and prop values do. */
export function sameDashboardConfig(left: DashboardConfig, right: DashboardConfig): boolean {
  const serialize = (config: DashboardConfig) => JSON.stringify(config, (_key, value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
      : value,
  );
  return serialize(left) === serialize(right);
}

export function createDashboardEditSession(
  projectRoot: string,
  source: DashboardConfigSource,
  validation: DashboardDraftValidation,
  sourceNodeId?: string,
): DashboardEditSession {
  return {
    projectRoot,
    configPath: source.configPath,
    ...(sourceNodeId ? { sourceNodeId } : {}),
    componentCatalog: source.componentCatalog,
    original: structuredClone(source.config),
    draft: structuredClone(source.config),
    validatedConfig: structuredClone(source.config),
    validatedDraft: JSON.stringify(source.config),
    expectedConfigRevision: source.configRevision,
    validation,
  };
}

export function sameDashboardTopology(left: DashboardConfig, right: DashboardConfig): boolean {
  const sameNode = (a: ComponentNode, b: ComponentNode): boolean => {
    if (!a.id || !b.id || a.component !== b.component || a.id !== b.id) return false;
    const ac = a.children;
    const bc = b.children;
    if (ac === undefined || bc === undefined) return ac === bc;
    if (Array.isArray(ac) !== Array.isArray(bc)) return false;
    if (Array.isArray(ac) && Array.isArray(bc)) {
      return ac.length === bc.length && ac.every((edge, index) => sameNode(edge.node, bc[index]!.node));
    }
    const sameLayout = (x: ComponentChildLayout<ComponentNode>, y: ComponentChildLayout<ComponentNode>): boolean => {
      if ("node" in x || "node" in y) return "node" in x && "node" in y && sameNode(x.node, y.node);
      return x.axis === y.axis && sameLayout(x.first, y.first) && sameLayout(x.second, y.second);
    };
    return sameLayout(ac as ComponentChildLayout<ComponentNode>, bc as ComponentChildLayout<ComponentNode>);
  };
  return sameNode(left.root, right.root);
}

export function patchDashboardAppearance(
  config: DashboardConfig,
  change: Pick<DashboardConfig, "theme" | "themeMode">,
): DashboardConfig {
  const draft = { ...config };
  if ("theme" in change) {
    if (change.theme) draft.theme = change.theme;
    else delete draft.theme;
  }
  if ("themeMode" in change) {
    if (change.themeMode) draft.themeMode = change.themeMode;
    else delete draft.themeMode;
  }
  return draft;
}

export function mergeThemeCatalog(
  applicationThemes: readonly ThemeCatalogItem[],
  projectThemes: readonly ThemeCatalogItem[] | undefined,
): ThemeCatalogItem[] {
  return [
    ...applicationThemes,
    ...(projectThemes ?? []).filter((item) => item.reference.startsWith("./")),
  ];
}

export function isCompositionSourceCurrent(
  source: DashboardCompositionSource | null | undefined,
  snapshot: ProjectSnapshot | null | undefined,
  focusedSourcePath: string | undefined,
  focusedSourceNodeId?: string,
): source is DashboardCompositionSource {
  return Boolean(
    source
    && snapshot
    && source.projectRoot === snapshot.projectRoot
    && source.activeDashboardPath === snapshot.configPath
    && source.focusedSourcePath === focusedSourcePath
    && source.sourceNodeId === focusedSourceNodeId
    && source.snapshotRevision === snapshot.revision,
  );
}

export function replaceResolvedConfigLinkTree(
  root: ResolvedComponentNode,
  sourceNodeId: string,
  replacement: ResolvedComponentNode,
): ResolvedComponentNode | null {
  let changed = false;
  const replaceNode = (node: ResolvedComponentNode): ResolvedComponentNode => {
    if (node.id === sourceNodeId) {
      changed = true;
      const existing = childEdges(node.children)[0];
      return {
        ...node,
        children: [{ node: replacement, ...(existing?.metadata === undefined ? {} : { metadata: structuredClone(existing.metadata) }) }],
      };
    }
    if (!node.children) return node;
    if (Array.isArray(node.children)) {
      let localChange = false;
      const children = node.children.map((edge) => {
        const next = replaceNode(edge.node);
        if (next !== edge.node) localChange = true;
        return next === edge.node ? edge : { ...edge, node: next };
      });
      if (!localChange) return node;
      changed = true;
      return { ...node, children };
    }
    const replaceLayout = (layout: ComponentChildLayout<ResolvedComponentNode>): ComponentChildLayout<ResolvedComponentNode> => {
      if ("node" in layout) {
        const next = replaceNode(layout.node);
        return next === layout.node ? layout : { ...layout, node: next };
      }
      const first = replaceLayout(layout.first);
      const second = replaceLayout(layout.second);
      return first === layout.first && second === layout.second
        ? layout
        : { ...layout, first, second };
    };
    const children = replaceLayout(node.children);
    return children === node.children ? node : { ...node, children };
  };
  const next = replaceNode(root);
  return changed ? next : null;
}

/** Find the active config-link boundary that owns the focused resolved node. */
export function resolvedConfigLinkNodeId(
  root: ResolvedComponentNode | null | undefined,
  targetNodeId: string | null | undefined,
  configPath: string | undefined,
): string | undefined {
  if (!root || !targetNodeId || !configPath) return undefined;
  const ancestors: ResolvedComponentNode[] = [];
  const visit = (node: ResolvedComponentNode): boolean => {
    ancestors.push(node);
    if (node.id === targetNodeId) return true;
    for (const edge of childEdges(node.children)) {
      if (visit(edge.node)) return true;
    }
    ancestors.pop();
    return false;
  };
  if (!visit(root)) return undefined;
  return [...ancestors].reverse().find((node) =>
    node.source === "config" && node.configPath === configPath)?.id;
}

export function resolvedLocalComponentIds(root: ResolvedComponentNode | null | undefined): Set<string> {
  const ids = new Set<string>();
  if (!root) return ids;
  const visit = (node: ResolvedComponentNode): void => {
    if (node.source === "local" && node.manifest?.id) ids.add(node.manifest.id);
    for (const edge of childEdges(node.children)) visit(edge.node);
  };
  visit(root);
  return ids;
}

export function outlineError(outline: Pick<ProjectOutline, "tree" | "diagnostics">): string | null {
  if (outline.tree) return null;
  return outline.diagnostics.find((item) => item.severity === "error")?.message
    ?? "The dashboard tree is unavailable.";
}
