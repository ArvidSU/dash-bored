import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type {
  ComponentNode,
  ProjectDeletionDependency,
  ProjectDeletionPreview,
  ProjectListItem,
} from "../shared/contracts";
import { CONFIG_DIRECTORY } from "../shared/contracts";
import { CoreError, errorMessage } from "./diagnostics";
import {
  assertProjectLocationContained,
  isPathContained,
  resolveProjectLocation,
  type ProjectLocation,
} from "./paths";
import { parseDashboardConfig } from "./yaml";
import { isConfigReference, resolveConfigReferencePath } from "./tree";

interface ScanState {
  readonly targetDirectory: string;
  readonly visited: Set<string>;
  readonly stack: Set<string>;
  readonly dependencies: Map<string, Set<string>>;
  readonly issues: string[];
}

function configReferenceCandidate(location: ProjectLocation, reference: string): string {
  return isAbsolute(reference)
    ? resolve(reference)
    : resolve(location.configDirectory, reference);
}

async function canonicalizeCandidatePath(path: string): Promise<string> {
  const absolute = resolve(path);
  let cursor = absolute;
  const missing: string[] = [];
  while (true) {
    try {
      return join(await realpath(cursor), ...missing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return absolute;
      const parent = dirname(cursor);
      if (parent === cursor) return absolute;
      missing.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

function addDependency(state: ScanState, projectRoot: string, configPath: string): void {
  if (!isPathContained(state.targetDirectory, configPath)) return;
  const paths = state.dependencies.get(projectRoot) ?? new Set<string>();
  paths.add(configPath);
  state.dependencies.set(projectRoot, paths);
}

function addIssue(state: ScanState, message: string): void {
  if (!state.issues.includes(message)) state.issues.push(message);
}

async function scanNode(
  node: ComponentNode,
  location: ProjectLocation,
  projectRoot: string,
  state: ScanState,
): Promise<void> {
  if (isConfigReference(node.component)) {
    const rawCandidate = configReferenceCandidate(location, node.component);
    const candidate = await canonicalizeCandidatePath(rawCandidate);
    // Preserve a lexical dependency when a link inside the target directory
    // resolves through a symlink to an external config. Removing the target
    // still removes that link even though the resolved config lives elsewhere.
    const lexicalTargetDependency =
      isPathContained(state.targetDirectory, rawCandidate) &&
      !isPathContained(state.targetDirectory, candidate);
    let configPath: string;
    try {
      configPath = await resolveConfigReferencePath(location, node.component);
    } catch (error) {
      addDependency(state, projectRoot, candidate);
      if (lexicalTargetDependency) addDependency(state, projectRoot, rawCandidate);
      addIssue(
        state,
        `Could not inspect config link ${node.component} in ${location.configPath}: ${errorMessage(error)}`,
      );
      return;
    }

    addDependency(state, projectRoot, configPath);
    if (lexicalTargetDependency) addDependency(state, projectRoot, rawCandidate);
    const canonicalConfigPath = await realpath(configPath).catch(() => resolve(configPath));
    if (state.stack.has(canonicalConfigPath)) {
      addIssue(state, `Config link cycle detected at ${canonicalConfigPath}.`);
      return;
    }
    if (state.visited.has(canonicalConfigPath)) return;

    const linkedLocation = await resolveProjectLocation(configPath).catch((error: unknown) => {
      addIssue(state, `Could not resolve config link ${node.component}: ${errorMessage(error)}`);
      return null;
    });
    if (linkedLocation === null) return;
    await scanConfig(linkedLocation, projectRoot, state);
    return;
  }

  if (
    node.component.startsWith("./components/") &&
    isPathContained(state.targetDirectory, resolve(location.configDirectory, node.component))
  ) {
    addIssue(
      state,
      `Could not statically determine file access from local component ${node.component} in ${location.configPath}.`,
    );
  }

  for (const configured of Object.values(node.slots ?? {})) {
    const children = Array.isArray(configured) ? configured : [configured];
    for (const child of children) await scanNode(child, location, projectRoot, state);
  }
}

async function scanConfig(
  location: ProjectLocation,
  projectRoot: string,
  state: ScanState,
): Promise<void> {
  const canonicalConfigPath = await realpath(location.configPath).catch(() => resolve(location.configPath));
  if (state.stack.has(canonicalConfigPath)) {
    addIssue(state, `Config link cycle detected at ${canonicalConfigPath}.`);
    return;
  }
  if (state.visited.has(canonicalConfigPath)) return;

  state.visited.add(canonicalConfigPath);
  state.stack.add(canonicalConfigPath);
  try {
    const parsed = await parseDashboardConfig(location.configPath);
    if (parsed.value === null) {
      addIssue(
        state,
        `Could not inspect ${location.configPath}: ${parsed.diagnostics[0]?.message ?? "The dashboard config is invalid."}`,
      );
      return;
    }
    await scanNode(parsed.value.root, location, projectRoot, state);
  } catch (error) {
    addIssue(state, `Could not inspect ${location.configPath}: ${errorMessage(error)}`);
  } finally {
    state.stack.delete(canonicalConfigPath);
  }
}

async function inspectFilesDirectory(
  location: ProjectLocation,
  issues: string[],
): Promise<boolean> {
  try {
    await assertProjectLocationContained(location);
    const info = await lstat(location.configDirectory);
    if (info.isSymbolicLink()) {
      issues.push(`The ${CONFIG_DIRECTORY}/ directory must not be a symbolic link.`);
      return false;
    }
    if (!info.isDirectory()) {
      issues.push(`The ${CONFIG_DIRECTORY}/ path is not a directory.`);
      return false;
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    issues.push(`The project files could not be inspected: ${errorMessage(error)}`);
    return false;
  }
}

export async function inspectProjectDeletion(
  target: ProjectListItem,
  projects: readonly ProjectListItem[],
): Promise<ProjectDeletionPreview> {
  let location: ProjectLocation;
  try {
    location = await resolveProjectLocation(target.projectRoot, { inputKind: "project-root" });
  } catch (error) {
    throw new CoreError("PROJECT_DELETE_PATH_INVALID", errorMessage(error));
  }

  const analysisIssues: string[] = [];
  const filesExist = await inspectFilesDirectory(location, analysisIssues);
  const state: ScanState = {
    targetDirectory: resolve(location.configDirectory),
    visited: new Set(),
    stack: new Set(),
    dependencies: new Map(),
    issues: analysisIssues,
  };

  for (const project of projects) {
    if (project.projectRoot === target.projectRoot) continue;
    // The same linked config can be reached from more than one registered
    // dashboard. Keep dependency collection per source dashboard while still
    // deduplicating paths within that dashboard's traversal.
    state.visited.clear();
    state.stack.clear();
    let projectLocation: ProjectLocation;
    try {
      projectLocation = await resolveProjectLocation(project.configPath);
    } catch (error) {
      addIssue(state, `Could not inspect ${project.projectRoot}: ${errorMessage(error)}`);
      continue;
    }
    await scanConfig(projectLocation, project.projectRoot, state);
  }

  const dependencies: ProjectDeletionDependency[] = projects
    .filter((project) => state.dependencies.has(project.projectRoot))
    .map((project) => ({
      projectRoot: project.projectRoot,
      dashboardName: project.dashboardName,
      configPaths: [...(state.dependencies.get(project.projectRoot) ?? [])].sort(),
    }))
    .sort((left, right) =>
      (left.dashboardName ?? left.projectRoot).localeCompare(right.dashboardName ?? right.projectRoot),
    );

  return {
    projectRoot: target.projectRoot,
    configPath: target.configPath,
    dashboardName: target.dashboardName,
    filesDirectory: location.configDirectory,
    filesExist,
    dependencies,
    analysisComplete: state.issues.length === 0,
    analysisIssues: [...state.issues],
  };
}
