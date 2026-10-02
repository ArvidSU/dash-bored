import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { DashboardLock, ExternalComponentLockEntry } from "../shared/contracts";
import { CoreError } from "./diagnostics";
import {
  checkedOutCommit,
  git,
  gitErrorDetail,
  installPackage,
  readPackageStore,
  readRemoteHead,
  removeSubmodule,
  repositoryRoot,
  resolveRemoteCommit,
  submoduleLocation,
  withPackageStore,
  writePackageLock,
} from "./package-store";
import { resolveProjectLocation, type ProjectLocation } from "./paths";
import { EXTERNAL_NAME_PATTERN } from "./tree-catalog";

/**
 * External components: submodule packages below `components/external/`,
 * pinned in the bundle lock's `components` section. Git, lock I/O, the
 * operation guard, and staged installs come from the package store.
 */

export interface ExternalComponentAddOptions {
  name?: string;
  ref?: string;
}

export interface ExternalComponentUpdateOptions {
  to?: string;
}

export interface ExternalComponentSummary {
  name: string;
  url: string;
  commit: string;
  path: string;
}

export interface ExternalComponentStatus extends ExternalComponentSummary {
  initialized: boolean;
  checkedOutCommit: string | null;
  dirty: boolean;
  inSync: boolean;
  /** Remote HEAD versus the pin; null when the remote could not be reached. */
  updateAvailable: boolean | null;
}

export interface ExternalComponentAddResult {
  name: string;
  commit: string;
}

export interface ExternalComponentUpdateResult {
  name: string;
  commit: string;
  changed: boolean;
}

export interface ExternalComponentRemoveResult {
  name: string;
}

/** git through the package store, reported with the component error code. */
async function componentGit(cwd: string, args: string[], timeoutMs?: number): Promise<string> {
  try {
    return await git(cwd, args, timeoutMs);
  } catch (error) {
    throw new CoreError(
      "COMPONENT_GIT_FAILED",
      `git ${args.join(" ")} failed: ${gitErrorDetail(error)}`,
    );
  }
}

function targetDirectoryFor(location: ProjectLocation, name: string): string {
  return join(location.componentsDirectory, "external", name);
}

function lockPathFor(name: string): string {
  return `components/external/${name}`;
}

function validateComponentName(name: string): void {
  if (!EXTERNAL_NAME_PATTERN.test(name)) {
    throw new CoreError(
      "COMPONENT_NAME_INVALID",
      `Invalid external component name: ${name}. Names start with a letter and contain only letters, digits, '_' or '-'.`,
    );
  }
}

function deriveNameFromUrl(url: string): string {
  const withoutTrailingSlash = url.trim().replace(/\/+$/, "");
  const lastSegment = withoutTrailingSlash.split("/").pop() ?? "";
  const base = (lastSegment.split(/[?#]/)[0] ?? "").replace(/\.git$/, "");
  if (!EXTERNAL_NAME_PATTERN.test(base)) {
    throw new CoreError(
      "COMPONENT_NAME_INVALID",
      `Could not derive a component name from ${url}. Pass --name explicitly (a letter followed by letters, digits, '_' or '-').`,
    );
  }
  return base;
}

/** Resolve the bundle and require its git checkout before the lock is read. */
async function componentBundle(projectInput: string): Promise<{ location: ProjectLocation; repoRoot: string }> {
  const location = await resolveProjectLocation(projectInput);
  return { location, repoRoot: await repositoryRoot(location.configDirectory) };
}

function pinnedNames(lock: DashboardLock): string {
  const names = Object.keys(lock.components).sort();
  return names.length === 0 ? "No external components are pinned." : `Pinned: ${names.join(", ")}.`;
}

function lockEntryOrThrow(lock: DashboardLock, name: string): ExternalComponentLockEntry {
  const entry = lock.components[name];
  if (entry === undefined) {
    throw new CoreError(
      "COMPONENT_NOT_PINNED",
      `Unknown external component: ${name}. ${pinnedNames(lock)}`,
    );
  }
  return entry;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function isDirty(checkout: string): Promise<boolean> {
  return (await componentGit(checkout, ["status", "--porcelain"], 15_000)).length > 0;
}

export async function addComponent(
  projectInput: string,
  url: string,
  options: ExternalComponentAddOptions = {},
): Promise<ExternalComponentAddResult> {
  if (url.trim() === "") {
    throw new CoreError("COMPONENT_URL_INVALID", "component add requires a repository URL.");
  }
  const name = options.name ?? deriveNameFromUrl(url);
  validateComponentName(name);
  const { location } = await componentBundle(projectInput);
  return withPackageStore(location.configDirectory, "submodule", async (store) => {
    if (store.lock.components[name] !== undefined) {
      throw new CoreError(
        "COMPONENT_ALREADY_PINNED",
        `External component ${name} is already pinned. ${pinnedNames(store.lock)}`,
      );
    }
    const targetDirectory = targetDirectoryFor(location, name);
    if (await pathExists(targetDirectory)) {
      throw new CoreError(
        "COMPONENT_TARGET_EXISTS",
        `${targetDirectory} already exists. Remove it or pick another name with --name.`,
      );
    }
    const commit = await resolveRemoteCommit(url, options.ref);
    const next: DashboardLock = {
      ...store.lock,
      components: { ...store.lock.components, [name]: { url, commit, path: lockPathFor(name) } },
    };
    try {
      // The pinned commit is verified in a stage before the submodule is added;
      // a later failure removes the submodule again.
      await installPackage(store, {
        url,
        commit,
        checkout: targetDirectory,
        commitLock: () => writePackageLock(store, next),
      });
    } catch (error) {
      if (error instanceof CoreError) throw error;
      throw new CoreError(
        "COMPONENT_ADD_FAILED",
        `Could not add ${name} from ${url}: ${gitErrorDetail(error)}`,
      );
    }
    return { name, commit };
  });
}

export async function listComponents(projectInput: string): Promise<ExternalComponentSummary[]> {
  const location = await resolveProjectLocation(projectInput);
  const { lock } = await readPackageStore(location.configDirectory, "submodule");
  return Object.entries(lock.components)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, entry]) => ({ name, url: entry.url, commit: entry.commit, path: entry.path }));
}

export async function statusComponents(
  projectInput: string,
  name?: string,
): Promise<ExternalComponentStatus[]> {
  const { location, repoRoot } = await componentBundle(projectInput);
  const { lock } = await readPackageStore(location.configDirectory, "submodule");
  const entries = name === undefined
    ? Object.entries(lock.components).sort(([left], [right]) => left.localeCompare(right))
    : [[name, lockEntryOrThrow(lock, name)] as const];
  const readStatus = async ([entryName, entry]: readonly [string, ExternalComponentLockEntry]): Promise<ExternalComponentStatus> => {
    const targetDirectory = targetDirectoryFor(location, entryName);
    const checkedOut = await checkedOutCommit(targetDirectory);
    const initialized = checkedOut !== null;
    const dirty = initialized ? await isDirty(targetDirectory) : false;
    // A status report must survive an unreachable remote; callers show "unknown".
    const remoteHead = await readRemoteHead(entry.url, repoRoot);
    return {
      name: entryName,
      url: entry.url,
      commit: entry.commit,
      path: entry.path,
      initialized,
      checkedOutCommit: checkedOut,
      dirty,
      inSync: initialized && checkedOut === entry.commit.toLowerCase(),
      updateAvailable: remoteHead === null ? null : remoteHead !== entry.commit.toLowerCase(),
    };
  };
  const statuses: ExternalComponentStatus[] = [];
  for (let offset = 0; offset < entries.length; offset += 2) {
    const batch = entries.slice(offset, offset + 2);
    const results = await Promise.allSettled(batch.map(readStatus));
    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
      statuses.push(result.value);
    }
  }
  return statuses;
}

export async function updateComponent(
  projectInput: string,
  name: string,
  options: ExternalComponentUpdateOptions = {},
): Promise<ExternalComponentUpdateResult> {
  validateComponentName(name);
  const { location } = await componentBundle(projectInput);
  return withPackageStore(location.configDirectory, "submodule", async (store) => {
    const entry = lockEntryOrThrow(store.lock, name);
    const targetDirectory = targetDirectoryFor(location, name);
    const checkedOut = await checkedOutCommit(targetDirectory);
    if (checkedOut === null) {
      throw new CoreError(
        "COMPONENT_NOT_INITIALIZED",
        `External component ${name} is not initialized. Sync external components first.`,
      );
    }
    if (await isDirty(targetDirectory)) {
      throw new CoreError(
        "COMPONENT_DIRTY",
        `External component ${name} has local changes. Commit, stash, or discard them inside ${targetDirectory} before updating.`,
      );
    }
    let commit: string;
    try {
      commit = await resolveRemoteCommit(entry.url, options.to);
    } catch (error) {
      if (error instanceof CoreError && error.code === "COMPONENT_REF_UNRESOLVED" && options.to === undefined) {
        throw new CoreError(
          "COMPONENT_REMOTE_UNREACHABLE",
          `Could not determine the latest commit for ${name} in ${entry.url}: ${gitErrorDetail(error)} Pass --to explicitly or check network access.`,
        );
      }
      throw error;
    }
    if (commit === entry.commit.toLowerCase() && checkedOut === entry.commit.toLowerCase()) {
      return { name, commit: entry.commit, changed: false };
    }
    let fetchDetail: string | null = null;
    try {
      await componentGit(targetDirectory, ["fetch", "origin"]);
    } catch (error) {
      // A SHA checkout is content-addressed: stale objects fail below with a clear
      // error, so a failed opportunistic fetch must not block an update that the
      // local clone can already satisfy.
      fetchDetail = gitErrorDetail(error);
    }
    try {
      await componentGit(targetDirectory, ["checkout", commit]);
    } catch (error) {
      throw new CoreError(
        "COMPONENT_UPDATE_FAILED",
        `Could not check out ${commit} for ${name}: ${gitErrorDetail(error)}${fetchDetail ? ` (fetch also failed: ${fetchDetail})` : ""} Sync external components to restore the pinned checkout.`,
      );
    }
    await writePackageLock(store, {
      ...store.lock,
      components: { ...store.lock.components, [name]: { ...entry, commit } },
    });
    return { name, commit, changed: commit !== entry.commit.toLowerCase() };
  });
}

export async function removeComponent(
  projectInput: string,
  name: string,
): Promise<ExternalComponentRemoveResult> {
  validateComponentName(name);
  const { location } = await componentBundle(projectInput);
  return withPackageStore(location.configDirectory, "submodule", async (store) => {
    lockEntryOrThrow(store.lock, name);
    try {
      await removeSubmodule(store, targetDirectoryFor(location, name), { force: true });
    } catch (error) {
      if (error instanceof CoreError) throw error;
      throw new CoreError(
        "COMPONENT_REMOVE_FAILED",
        `Could not detach ${name}: ${gitErrorDetail(error)}`,
      );
    }
    const { [name]: _removed, ...remaining } = store.lock.components;
    await writePackageLock(store, { ...store.lock, components: remaining });
    return { name };
  });
}

export async function syncComponents(projectInput: string): Promise<ExternalComponentSummary[]> {
  const { location, repoRoot } = await componentBundle(projectInput);
  return withPackageStore(location.configDirectory, "submodule", async (store) => {
    const entries = Object.entries(store.lock.components).sort(([left], [right]) => left.localeCompare(right));
    const synced: ExternalComponentSummary[] = [];
    for (const [name, entry] of entries) {
      const targetDirectory = targetDirectoryFor(location, name);
      const { gitPath } = await submoduleLocation(store, targetDirectory);
      try {
        await componentGit(repoRoot, ["submodule", "update", "--init", "--checkout", "--", gitPath]);
      } catch (error) {
        throw new CoreError(
          "COMPONENT_SYNC_FAILED",
          `Could not initialize ${name} from ${entry.url}: ${gitErrorDetail(error)} Remove it and add ${entry.url} again as ${name}.`,
        );
      }
      try {
        await componentGit(targetDirectory, ["checkout", entry.commit]);
      } catch (error) {
        throw new CoreError(
          "COMPONENT_SYNC_FAILED",
          `Initialized ${name} but could not check out the pinned ${entry.commit}: ${gitErrorDetail(error)} Discard local changes inside ${targetDirectory} and retry.`,
        );
      }
      synced.push({ name, url: entry.url, commit: entry.commit, path: entry.path });
    }
    return synced;
  });
}
