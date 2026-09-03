import type {
  ComponentCatalogItem,
  ComponentNode,
  DashboardAgentTask,
  DashboardConfig,
  DashboardDraftValidation,
  ProcessSnapshot,
  ProjectListItem,
  ProjectOutline,
  ProjectSnapshot,
  ResolvedComponentNode,
} from "../../shared/contracts";
import { childEdges } from "../lib/component-children";
import type { ComponentHeightOverrides } from "../lib/component-height";
import type { SplitRatioOverrides } from "../render/split-layout";

export const EMPTY_COLLAPSED_COMPONENT_IDS = new Set<string>();
export const EMPTY_SPLIT_RATIO_OVERRIDES: Readonly<SplitRatioOverrides> = Object.freeze({});
export const EMPTY_COMPONENT_HEIGHT_OVERRIDES: Readonly<ComponentHeightOverrides> = Object.freeze({});

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
    command: "dash-bored agent",
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
  componentCatalog: ComponentCatalogItem[];
  original: DashboardConfig;
  draft: DashboardConfig;
  expectedConfigRevision: string;
  validation: DashboardDraftValidation;
}

export interface DashboardCompositionSource {
  projectRoot: string;
  activeDashboardPath: string;
  focusedSourcePath: string;
  snapshotRevision: number;
  configPath: string;
  componentCatalog: ComponentCatalogItem[];
  config: DashboardConfig;
}

export function findResolvedConfigRoot(
  node: ResolvedComponentNode,
  configPath: string,
): ResolvedComponentNode | null {
  if (node.sourceConfigPath === configPath && node.sourcePath === "root") return node;
  for (const edge of childEdges(node.children)) {
    const match = findResolvedConfigRoot(edge.node, configPath);
    if (match) return match;
  }
  return null;
}

export function linkedComponentIdNamespace(
  template: ResolvedComponentNode,
  rawRoot: ComponentNode,
): string | undefined {
  const rawRootId = rawRoot.id ?? "root";
  const suffix = `::${rawRootId}`;
  if (template.id.endsWith(suffix)) return template.id.slice(0, -suffix.length);
  const separator = template.id.lastIndexOf("::");
  return separator > 0 ? template.id.slice(0, separator) : undefined;
}

export function outlineError(outline: Pick<ProjectOutline, "tree" | "diagnostics">): string | null {
  if (outline.tree) return null;
  return outline.diagnostics.find((item) => item.severity === "error")?.message
    ?? "The dashboard tree is unavailable.";
}
