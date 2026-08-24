import { lstat } from "node:fs/promises";
import type { ProjectListItem, ProjectSnapshot } from "../shared/contracts";
import {
  CoreError,
  inspectProjectDeletion,
  type ProjectRuntime,
  type TrustGrantSnapshot,
  type TrustStore,
} from "../core";
import { assertProjectLocationContained, resolveProjectLocation } from "../core/paths";
import { ProjectRegistry } from "./project-registry";

export interface ProjectDeletionServiceOptions {
  registry: ProjectRegistry;
  runtime: ProjectRuntime;
  trustStore: TrustStore;
  projectRoot: string;
  removeFiles: boolean;
  moveToTrash: (path: string) => boolean | Promise<boolean>;
}

function findRegisteredProject(
  projects: readonly ProjectListItem[],
  projectRoot: string,
): ProjectListItem {
  const project = projects.find((candidate) => candidate.projectRoot === projectRoot);
  if (project === undefined) {
    throw new CoreError(
      "PROJECT_NOT_REGISTERED",
      "That dashboard is no longer registered in dash-bored.",
    );
  }
  return project;
}

export async function getProjectDeletionPreview(
  registry: ProjectRegistry,
  projectRoot: string,
) {
  const projects = await registry.list();
  const project = findRegisteredProject(projects, projectRoot);
  return inspectProjectDeletion(project, projects);
}

async function moveProjectFilesToTrash(
  projectRoot: string,
  moveToTrash: (path: string) => boolean | Promise<boolean>,
): Promise<void> {
  const location = await resolveProjectLocation(projectRoot, { inputKind: "project-root" });
  await assertProjectLocationContained(location);

  let info;
  try {
    info = await lstat(location.configDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (info.isSymbolicLink()) {
    throw new CoreError(
      "PROJECT_DELETE_PATH_INVALID",
      "The app-owned dash-bored/ path is a symbolic link and cannot be moved to Trash.",
    );
  }
  if (!info.isDirectory()) {
    throw new CoreError(
      "PROJECT_DELETE_PATH_INVALID",
      "The app-owned dash-bored/ path is not a directory and cannot be moved to Trash.",
    );
  }

  let moved: boolean;
  try {
    moved = await moveToTrash(location.configDirectory);
  } catch (error) {
    throw new CoreError(
      "PROJECT_FILES_TRASH_FAILED",
      `Could not move the app-owned dash-bored/ directory to Trash: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!moved) {
    throw new CoreError(
      "PROJECT_FILES_TRASH_FAILED",
      "The operating system could not move the app-owned dash-bored/ directory to Trash.",
    );
  }
}

async function restoreTrust(
  trustStore: TrustStore,
  projectRoot: string,
  grant: TrustGrantSnapshot | null,
): Promise<void> {
  if (grant === null) return;
  await trustStore.trust(projectRoot, grant.permissions);
}

export async function deleteRegisteredProject(
  options: ProjectDeletionServiceOptions,
): Promise<ProjectSnapshot> {
  const projects = await options.registry.list();
  const project = findRegisteredProject(projects, options.projectRoot);
  const preview = await inspectProjectDeletion(project, projects);
  if (options.removeFiles && !preview.analysisComplete) {
    throw new CoreError(
      "PROJECT_DELETE_ANALYSIS_INCOMPLETE",
      `The project files cannot be removed because dependency analysis was incomplete: ${preview.analysisIssues.join(" ")}`,
    );
  }

  const wasActive = options.runtime.getSnapshot().projectRoot === project.projectRoot;
  const grant = options.removeFiles
    ? await options.trustStore.getGrant(project.projectRoot)
    : null;
  let removed: ProjectListItem | null = null;
  let trustRevoked = false;

  try {
    if (wasActive) await options.runtime.unload();
    if (options.removeFiles) {
      await options.trustStore.revoke(project.projectRoot);
      trustRevoked = true;
    }

    removed = await options.registry.remove(project.projectRoot);
    if (removed === null) {
      throw new CoreError(
        "PROJECT_NOT_REGISTERED",
        "That dashboard is no longer registered in dash-bored.",
      );
    }

    if (options.removeFiles) {
      await moveProjectFilesToTrash(project.projectRoot, options.moveToTrash);
    }
    return options.runtime.getSnapshot();
  } catch (error) {
    if (removed !== null) {
      await options.registry.restore(removed).catch(() => undefined);
    }
    if (trustRevoked) {
      await restoreTrust(options.trustStore, project.projectRoot, grant).catch(() => undefined);
    }
    if (wasActive && options.runtime.getSnapshot().projectRoot === null) {
      await options.runtime
        .load(project.projectRoot, { inputKind: "project-root" })
        .then(() => options.runtime.watch())
        .catch(() => undefined);
    }
    throw error;
  }
}
