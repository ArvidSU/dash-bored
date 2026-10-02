import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { DashboardLock } from "../shared/contracts";
import { CoreError, errorMessage } from "./diagnostics";
import { writeFileAtomically } from "./fs-atomic";
import { parseThemeLock } from "./themes";
import { parseDashboardLock, serializeDashboardLock } from "./yaml";

/**
 * One store for git-pinned packages: external components and theme packages.
 * A store is a directory holding a lock file. Each package is a checkout at
 * its pinned commit, placed by one of two strategies:
 *
 * - `submodule`: a submodule of the repository around a dashboard bundle,
 *   pinned in `dash-bored-lock.yaml` beside `dash-bored.yaml`.
 * - `clone`: a plain clone in a personal directory, pinned in `pins.yaml`.
 *
 * The store owns git, lock I/O, the per-store operation guard, and staged
 * installs. Package kinds keep their own policy: names, validation, and the
 * messages for their commands.
 */

export type PackageStrategy = "submodule" | "clone";

export interface PackageStore {
  /** Directory holding the lock file, the operation guard, and install stages. */
  root: string;
  lockPath: string;
  strategy: PackageStrategy;
  lock: DashboardLock;
}

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 120_000;
const LS_REMOTE_TIMEOUT_MS = 30_000;
const FULL_SHA_PATTERN = /^[0-9a-fA-F]{40}$/;
const WORK_PREFIX = ".package-";

/** Stages and the operation guard live beside the lock; file watchers ignore them. */
export function isPackageWorkPath(segment: string): boolean {
  return segment.startsWith(WORK_PREFIX);
}

/** A fresh scratch directory path inside the store for staging a checkout. */
export function packageWorkPath(store: Pick<PackageStore, "root">, purpose: "stage" | "remove"): string {
  return join(store.root, `${WORK_PREFIX}${purpose}-${randomUUID()}`);
}

/** Run git with local file transport allowed; resolves to trimmed stdout and rejects with git's own error. */
export async function git(cwd: string, args: readonly string[], timeoutMs = GIT_TIMEOUT_MS): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["-c", "protocol.file.allow=always", ...args],
    { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
  );
  return stdout.trim();
}

/** git's stderr when it printed any, otherwise the error message; bounded for display. */
export function gitErrorDetail(error: unknown): string {
  const withOutput = error as { stdout?: unknown; stderr?: unknown };
  const stderr = typeof withOutput.stderr === "string" ? withOutput.stderr.trim() : "";
  if (stderr) return stderr.slice(0, 2_000);
  return errorMessage(error).slice(0, 2_000);
}

function lockFileFor(root: string, strategy: PackageStrategy): string {
  return join(root, strategy === "clone" ? "pins.yaml" : "dash-bored-lock.yaml");
}

async function readLock(lockPath: string, strategy: PackageStrategy): Promise<DashboardLock> {
  if (strategy === "clone") {
    // Personal pins are optional until the first package is added.
    let source: string;
    try {
      source = await readFile(lockPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { lockfileVersion: 1, components: {}, themes: {} };
      throw error;
    }
    const parsed = parseThemeLock(source, lockPath);
    if (parsed.value) return parsed.value;
    if (parsed.invalidYaml) throw new Error("Invalid personal theme pins.yaml.");
    throw new Error(parsed.diagnostics.join("; "));
  }
  const parsed = await parseDashboardLock(lockPath);
  if (parsed.value === null) {
    const detail = parsed.diagnostics.map((item) => item.message).join("; ") || "unknown error";
    throw new CoreError(
      "PACKAGE_LOCK_INVALID",
      `Cannot manage packages: ${lockPath} is invalid (${detail}). Fix the lock file and retry.`,
    );
  }
  return parsed.value;
}

export async function readPackageStore(root: string, strategy: PackageStrategy): Promise<PackageStore> {
  const lockPath = lockFileFor(root, strategy);
  return { root, lockPath, strategy, lock: await readLock(lockPath, strategy) };
}

/**
 * Run one mutating operation per store at a time. The lock is read inside the
 * guard, so the operation always starts from the latest pins.
 */
export async function withPackageStore<T>(
  root: string,
  strategy: PackageStrategy,
  operation: (store: PackageStore) => Promise<T>,
): Promise<T> {
  await mkdir(root, { recursive: true });
  const guard = join(root, `${WORK_PREFIX}operation.lock`);
  try {
    await mkdir(guard);
  } catch {
    throw new CoreError(
      "PACKAGE_OPERATION_ACTIVE",
      `Another package operation is active (${guard}). If interrupted, remove this empty lock directory before retrying.`,
    );
  }
  try {
    return await operation(await readPackageStore(root, strategy));
  } finally {
    await rm(guard, { recursive: true, force: true });
  }
}

export async function writePackageLock(store: PackageStore, lock: DashboardLock): Promise<void> {
  try {
    // Personal pins stay private; bundle locks keep the project's file mode.
    await writeFileAtomically(
      store.lockPath,
      serializeDashboardLock(lock),
      store.strategy === "clone" ? { mode: 0o600 } : {},
    );
  } catch (error) {
    throw new CoreError("PACKAGE_LOCK_WRITE_FAILED", `Could not write ${store.lockPath}: ${errorMessage(error)}`);
  }
}

/** The repository around a submodule store and the package's path inside it. */
export async function submoduleLocation(store: Pick<PackageStore, "root">, checkout: string): Promise<{ repo: string; gitPath: string }> {
  const repo = await repositoryRoot(store.root);
  const gitPath = relative(repo, checkout).split(sep).join("/");
  if (gitPath === "" || gitPath === ".." || gitPath.startsWith("../") || isAbsolute(gitPath)) {
    throw new CoreError("PACKAGE_GIT_REQUIRED", `Package directory escapes its git checkout: ${checkout}.`);
  }
  return { repo, gitPath };
}

export async function repositoryRoot(directory: string): Promise<string> {
  try {
    return await git(directory, ["rev-parse", "--show-toplevel"], 15_000);
  } catch {
    throw new CoreError(
      "PACKAGE_GIT_REQUIRED",
      `Git-pinned packages require git: ${directory} is not inside a git checkout. Initialize one (git init, then commit the bundle) before adding, updating, or syncing packages.`,
    );
  }
}

/** HEAD of a package checkout, or null when it is missing or not a checkout of its own. */
export async function checkedOutCommit(checkout: string): Promise<string | null> {
  // The `.git` entry (a gitfile for submodules, a directory for clones) keeps
  // the probe inside the package: without it git would resolve the parent
  // repository instead.
  try {
    await stat(join(checkout, ".git"));
  } catch {
    return null;
  }
  try {
    const sha = (await git(checkout, ["rev-parse", "HEAD"], 15_000)).toLowerCase();
    return FULL_SHA_PATTERN.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

export async function hasLocalChanges(checkout: string): Promise<boolean> {
  return (await git(checkout, ["status", "--porcelain"], 15_000)).length > 0;
}

/**
 * Install a package at `commit`: verify it in a fresh stage (clone, detached
 * checkout, `validate`), place it with the store's strategy, then record it
 * with `commitLock`. Any failure after placement removes the placed checkout,
 * so the repository, index, and lock stay as they were.
 */
export async function installPackage(
  store: PackageStore,
  options: {
    url: string;
    commit: string;
    checkout: string;
    validate?: (directory: string) => Promise<unknown>;
    commitLock: () => Promise<void>;
  },
): Promise<void> {
  const { url, commit, checkout } = options;
  const stage = packageWorkPath(store, "stage");
  let placed = false;
  try {
    await git(store.root, ["clone", "--no-checkout", "--", url, stage]);
    await git(stage, ["checkout", "--detach", commit]);
    await options.validate?.(stage);
    if (store.strategy === "clone") {
      await rename(stage, checkout);
      placed = true;
    } else {
      const { repo, gitPath } = await submoduleLocation(store, checkout);
      await git(repo, ["submodule", "add", "--", url, gitPath]);
      placed = true;
      await git(checkout, ["checkout", "--detach", commit]);
    }
    await options.commitLock();
  } catch (error) {
    if (placed) {
      if (store.strategy === "clone") await rm(checkout, { recursive: true, force: true });
      else await removeSubmodule(store, checkout, { force: true });
    }
    throw error;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

/** Clone a pinned package into a clone store whose checkout is missing. */
export async function restoreClone(store: PackageStore, url: string, commit: string, checkout: string, validate?: (directory: string) => Promise<unknown>): Promise<void> {
  const stage = packageWorkPath(store, "stage");
  try {
    await git(store.root, ["clone", "--no-checkout", "--", url, stage]);
    await git(stage, ["checkout", "--detach", commit]);
    await validate?.(stage);
    await rename(stage, checkout);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

/**
 * Detach a submodule package and drop its object store below the git common
 * directory, which would otherwise block re-adding the same path. `force`
 * also removes a submodule with local or staged changes.
 */
export async function removeSubmodule(
  store: Pick<PackageStore, "root">,
  checkout: string,
  options: { force?: boolean } = {},
): Promise<void> {
  const { repo, gitPath } = await submoduleLocation(store, checkout);
  const force = options.force ? ["-f"] : [];
  if (options.force) {
    // Best effort: a hand-edited .gitmodules may already lack the entry;
    // `git rm` below reports the actionable error.
    await git(repo, ["submodule", "deinit", ...force, "--", gitPath]).catch(() => undefined);
  } else {
    await git(repo, ["submodule", "deinit", "--", gitPath]);
  }
  await git(repo, ["rm", ...force, "--", gitPath]);
  // The lock is the source of truth; a leftover object store only costs disk
  // space until the same path is added again.
  await removeSubmoduleObjects(repo, gitPath).catch(() => undefined);
}

async function removeSubmoduleObjects(repo: string, gitPath: string): Promise<void> {
  const common = await realpath(resolve(repo, await git(repo, ["rev-parse", "--git-common-dir"])));
  const objectStore = resolve(repo, await git(repo, ["rev-parse", "--git-path", `modules/${gitPath}`]));
  const rel = relative(common, objectStore);
  if (!rel.startsWith(`modules${sep}`) || rel.split(sep).includes("..")) {
    throw new Error("Unexpected submodule object directory.");
  }
  await rm(objectStore, { recursive: true, force: true });
}

interface RemoteRef {
  sha: string;
  ref: string;
}

function parseLsRemote(output: string): RemoteRef[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [sha = "", ref = ""] = line.split(/\s+/);
      return { sha: sha.toLowerCase(), ref };
    })
    .filter((entry) => FULL_SHA_PATTERN.test(entry.sha));
}

async function listRemoteRefs(url: string): Promise<RemoteRef[]> {
  let output: string;
  try {
    // ls-remote needs no repository; run it from the process directory.
    output = await git(process.cwd(), ["ls-remote", url], LS_REMOTE_TIMEOUT_MS);
  } catch (error) {
    throw new CoreError(
      "COMPONENT_REF_UNRESOLVED",
      `Could not reach ${url}: ${gitErrorDetail(error)} Check the URL and network access.`,
    );
  }
  return parseLsRemote(output);
}

/** Resolve a branch, tag, full SHA, or empty ref (remote HEAD) to an exact commit SHA. */
export async function resolveRemoteCommit(url: string, ref?: string): Promise<string> {
  if (ref === undefined) {
    const refs = await listRemoteRefs(url);
    const head = refs.find((entry) => entry.ref === "HEAD");
    if (head === undefined) {
      throw new CoreError(
        "COMPONENT_REF_UNRESOLVED",
        `Could not resolve HEAD in ${url}: the remote advertises no HEAD. Pass --ref explicitly.`,
      );
    }
    return head.sha;
  }
  if (FULL_SHA_PATTERN.test(ref)) {
    const wanted = ref.toLowerCase();
    const refs = await listRemoteRefs(url);
    if (!refs.some((entry) => entry.sha === wanted)) {
      throw new CoreError(
        "COMPONENT_REF_UNRESOLVED",
        `Commit ${ref} was not found in ${url}. Push it or pass a branch or tag name.`,
      );
    }
    return wanted;
  }
  let output: string;
  try {
    output = await git(
      process.cwd(),
      ["ls-remote", url, ref, `refs/heads/${ref}`, `refs/tags/${ref}`],
      LS_REMOTE_TIMEOUT_MS,
    );
  } catch (error) {
    throw new CoreError(
      "COMPONENT_REF_UNRESOLVED",
      `Could not resolve ${ref} in ${url}: ${gitErrorDetail(error)} Check the ref and network access.`,
    );
  }
  const refs = parseLsRemote(output);
  const peeledTag = refs.find((entry) => entry.ref === `refs/tags/${ref}^{}`);
  const branch = refs.find((entry) => entry.ref === `refs/heads/${ref}`);
  const tag = refs.find((entry) => entry.ref === `refs/tags/${ref}`);
  const peeled = refs.find((entry) => entry.ref.endsWith("^{}"));
  const resolved = peeledTag ?? branch ?? tag ?? peeled ?? refs[0];
  if (resolved === undefined) {
    throw new CoreError(
      "COMPONENT_REF_UNRESOLVED",
      `Could not resolve ${ref} in ${url}: no such branch, tag, or commit.`,
    );
  }
  return resolved.sha;
}

/** The remote's HEAD commit, or null when it cannot be reached. */
export async function readRemoteHead(url: string, cwd: string): Promise<string | null> {
  try {
    return parseLsRemote(await git(cwd, ["ls-remote", url, "HEAD"], LS_REMOTE_TIMEOUT_MS))[0]?.sha ?? null;
  } catch {
    return null;
  }
}
