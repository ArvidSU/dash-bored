import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, stat, lstat, readdir } from "node:fs/promises";
import { join, relative, resolve, sep, dirname } from "node:path";
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
 * - `submodule`: a submodule of a private repository below a dashboard bundle,
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

/** Bundle pins live at root; each package kind owns a separate private Git root. */
export async function ensurePackageIgnore(root: string): Promise<void> {
  const path = join(root, ".gitignore");
  let source = "";
  try {
    if (!(await lstat(path)).isFile()) throw new Error("Bundle .gitignore must be a regular file.");
    source = await readFile(path, "utf8");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const missing = ["/components/external/", "/themes/external/"].filter((rule) => !source.split(/\r?\n/).includes(rule));
  if (missing.length) await writeFileAtomically(path, source + (source && !source.endsWith("\n") ? "\n" : "") + "# Dash-bored manages these pinned checkouts; commit the lock file.\n" + missing.join("\n") + "\n");
}

export async function submoduleLocation(store: Pick<PackageStore, "root">, checkout: string): Promise<{ repo: string; gitPath: string }> {
  const repo = resolve(checkout, "..");
  const allowed = [join(store.root, "components", "external"), join(store.root, "themes", "external")];
  if (!allowed.some((path) => resolve(path) === repo)) throw new CoreError("PACKAGE_GIT_REQUIRED", `Invalid managed package root: ${repo}.`);
  await mkdir(repo, { recursive: true });
  const canonicalRoot = await realpath(store.root);
  const canonicalRepo = await realpath(repo);
  if (relative(canonicalRoot, canonicalRepo).startsWith("..")) throw new CoreError("PACKAGE_GIT_REQUIRED", "Managed package root escapes its bundle.");
  await ensurePackageIgnore(store.root);
  try {
    if (!(await lstat(join(repo, ".git"))).isDirectory()) throw new CoreError("PACKAGE_GIT_REQUIRED", "Managed package Git metadata must be a directory.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await git(repo, ["init", "--quiet"]);
  }
  for (const path of [join(repo,".gitmodules"), join(repo,".git","config"), join(repo,".git","index"), join(repo,".git","modules")]) {
    try { if ((await lstat(path)).isSymbolicLink()) throw new CoreError("PACKAGE_GIT_REQUIRED", `Managed Git metadata cannot be a symlink: ${path}.`); }
    catch(error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return { repo, gitPath: relative(repo, checkout).split(sep).join("/") };
}

function isPathInBundle(root: string, path: string): boolean { const rel = relative(root, path); return rel !== ".." && !rel.startsWith(`..${sep}`); }

/** Ordinary operations never detach or rewrite a parent-owned submodule. */
export async function assertManagedCheckout(store: Pick<PackageStore, "root">, checkout: string): Promise<void> {
  const expected = join(await realpath(resolve(checkout, "..")), ".git");
  if (!isPathInBundle(store.root, checkout)) throw new CoreError("PACKAGE_GIT_REQUIRED", "Package escapes its bundle.");
  const common = await realpath(resolve(checkout, await git(checkout, ["rev-parse", "--git-common-dir"])));
  if (!common.startsWith(expected + sep)) throw new CoreError("PACKAGE_LEGACY_OWNERSHIP", `Package ${checkout} is owned by the parent repository. Use explicit package ownership migration before changing it.`);
}

export async function recordSubmodulePin(store: Pick<PackageStore, "root">, checkout: string): Promise<void> {
  const { repo, gitPath } = await submoduleLocation(store, checkout);
  await git(repo, ["add", "--", gitPath, ".gitmodules"]);
}

export async function repositoryRoot(directory: string): Promise<string> {
  try {
    return await git(directory, ["rev-parse", "--show-toplevel"], 15_000);
  } catch {
    throw new CoreError(
      "PACKAGE_GIT_REQUIRED",
      `No parent Git repository was found for explicit ownership migration: ${directory}.`,
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

/** Snapshot only dash-bored's private registrations; the parent repository is never opened. */
export async function snapshotPackageMetadata(store: Pick<PackageStore, "root">, checkout: string): Promise<() => Promise<void>> {
  const { repo } = await submoduleLocation(store, checkout);
  const paths = [join(repo, ".gitmodules"), join(repo, ".git", "index"), join(repo, ".git", "config")];
  const files = await Promise.all(paths.map(async path => {
    try { return {path, bytes: await readFile(path)}; }
    catch(error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return {path, bytes: null}; }
  }));
  return async () => { for (const {path,bytes} of files) { if(bytes) await writeFileAtomically(path, bytes); else await rm(path, {force:true}); } };
}

/** Remove after preserving a recoverable checkout until the lock write succeeds. */
export async function removePackage(store: PackageStore, checkout: string, commitLock: () => Promise<void>): Promise<void> {
  const current = await checkedOutCommit(checkout);
  if (current) {
    await assertManagedCheckout(store, checkout);
    if (await hasLocalChanges(checkout)) throw new CoreError("PACKAGE_DIRTY", `Package has local changes: ${checkout}; save them before removing it.`);
  } else {
    try { if ((await readdir(checkout)).length) throw new Error(`Unmanaged files at ${checkout}; refusing to remove them.`); }
    catch(error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const rollback = await snapshotPackageMetadata(store, checkout);
  const { repo, gitPath } = await submoduleLocation(store, checkout);
  const backup = packageWorkPath(store, "remove");
  if (current) await rename(checkout, backup);
  try {
    if (await git(repo, ["ls-files", "--", gitPath])) await git(repo, ["rm", "--cached", "-f", "--", gitPath]);
    await git(repo, ["config", "-f", ".gitmodules", "--remove-section", `submodule.${gitPath}`]).catch(() => undefined);
    await git(repo, ["config", "--remove-section", `submodule.${gitPath}`]).catch(() => undefined);
    try { await stat(join(repo,".gitmodules")); await git(repo,["add","--",".gitmodules"]); } catch(error) { if((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await commitLock();
  } catch(error) { await rollback(); if(current) await rename(backup, checkout); throw error; }
  await rm(backup,{recursive:true,force:true});
  await rm(checkout,{recursive:true,force:true});
  await removeSubmoduleObjects(repo,gitPath).catch(()=>undefined);
}

/** A surviving checkout may lose only its dash-bored-owned Git object store. */
export async function hasMissingManagedMetadata(store: Pick<PackageStore, "root">, checkout: string): Promise<boolean> {
  try {
    if (!isPathInBundle(await realpath(store.root), await realpath(dirname(checkout)))) return false;
    const file = join(checkout, ".git");
    if (!(await lstat(file)).isFile()) return false;
    const match = /^gitdir: (.+)\s*$/.exec((await readFile(file,"utf8")).trim());
    if (!match) return false;
    const target = resolve(checkout, match[1]!);
    const expected = join(await realpath(dirname(checkout)), ".git", "modules", checkout.split(sep).at(-1)!);
    return target === expected && await checkedOutCommit(checkout) === null;
  } catch { return false; }
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
    /** Already cloned and pinned by the guarded ownership conversion. */
    preparedStage?: string;
    commitLock: () => Promise<void>;
  },
): Promise<void> {
  const { url, commit, checkout } = options;
  let restoreMetadata: (() => Promise<void>) | undefined;
  let reusedGitFile: Uint8Array | undefined;
  let reusedObjectStore: string | undefined;
  let installationLocation: { repo: string; gitPath: string } | undefined;
  const stage = options.preparedStage ?? packageWorkPath(store, "stage");
  let placed = false;
  try {
    if (!options.preparedStage) {
      await git(store.root, ["clone", "--no-checkout", "--", url, stage]);
      await git(stage, ["checkout", "--detach", commit]);
    } else if (await checkedOutCommit(stage) !== commit.toLowerCase()) throw new Error("Prepared package revision changed.");
    await options.validate?.(stage);
    if (store.strategy === "clone") {
      await rename(stage, checkout);
      placed = true;
    } else {
      const { repo, gitPath } = await submoduleLocation(store, checkout);
      restoreMetadata = await snapshotPackageMetadata(store, checkout);
      if (await hasMissingManagedMetadata(store, checkout)) {
        // Compare against the authoritative pin before attaching new metadata.
        if (await git(stage, ["--work-tree", checkout, "status", "--porcelain", "--untracked-files=all"])) throw new CoreError("PACKAGE_DIRTY", `Surviving checkout ${checkout} differs from its pin; refusing metadata reconstruction.`);
        reusedGitFile = await readFile(join(checkout,".git"));
        reusedObjectStore = join(repo,".git","modules",gitPath);
        await mkdir(dirname(reusedObjectStore),{recursive:true});
        await rename(join(stage,".git"),reusedObjectStore);
        await git(reusedObjectStore,["config","core.worktree",relative(reusedObjectStore,checkout)]);
        await git(repo,["config","-f",".gitmodules",`submodule.${gitPath}.path`,gitPath]);
        await git(repo,["config","-f",".gitmodules",`submodule.${gitPath}.url`,url]);
        await git(repo,["config",`submodule.${gitPath}.url`,url]);
        await git(repo,["config",`submodule.${gitPath}.active`,"true"]);
        await writeFileAtomically(join(checkout,".git"),`gitdir: ${relative(checkout,reusedObjectStore)}\n`);
        await recordSubmodulePin(store,checkout);
        await options.commitLock();
        return;
      }
      // Only an absent or empty target can become a new managed checkout.
      try {
        if ((await readdir(checkout)).length) throw new CoreError("PACKAGE_TARGET_EXISTS", `Existing files at ${checkout}; refusing to replace them.`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      // A deleted checkout may still have its private registration and objects.
      if (await git(repo, ["ls-files", "--", gitPath])) {
        await git(repo, ["rm", "--cached", "-f", "--", gitPath]);
        await git(repo, ["config", "-f", ".gitmodules", "--remove-section", `submodule.${gitPath}`]).catch(() => undefined);
        await git(repo, ["config", "--remove-section", `submodule.${gitPath}`]).catch(() => undefined);
      }
      installationLocation = { repo, gitPath };
      // Reuse the verified stage, including during ownership conversion. Remote
      // availability must not be tested again after replacing old checkouts.
      await git(repo, ["submodule", "add", "--force", "--", stage, gitPath]);
      placed = true;
      await git(checkout, ["remote", "set-url", "origin", url]);
      await git(repo, ["config", "-f", ".gitmodules", `submodule.${gitPath}.url`, url]);
      await git(repo, ["config", `submodule.${gitPath}.url`, url]);
      // A deleted checkout's surviving object store may predate this pin.
      await git(checkout, ["fetch", stage, commit]);
      await git(checkout, ["checkout", "--detach", commit]);
      await recordSubmodulePin(store, checkout);
    }
    await options.commitLock();
  } catch (error) {
    if (placed && store.strategy === "clone") await rm(checkout, { recursive: true, force: true });
    if (installationLocation) {
      // submodule add can clone successfully and then fail to register its
      // index entry. Clean up that partial checkout as well as placed ones.
      await rm(checkout, { recursive: true, force: true });
      await removeSubmoduleObjects(installationLocation.repo, installationLocation.gitPath);
    }
    if (reusedObjectStore) await rm(reusedObjectStore,{recursive:true,force:true});
    if (reusedGitFile) await writeFileAtomically(join(checkout,".git"),reusedGitFile);
    await restoreMetadata?.();
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
  await assertManagedCheckout(store, checkout);
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
  await git(repo, ["add", "--", ".gitmodules"]);
  // The lock is the source of truth; a leftover object store only costs disk
  // space until the same path is added again.
  await removeSubmoduleObjects(repo, gitPath).catch(() => undefined);
}

async function removeSubmoduleObjects(repo: string, gitPath: string): Promise<void> {
  const canonicalRepo = await realpath(repo);
  const common = await realpath(resolve(canonicalRepo, await git(repo, ["rev-parse", "--git-common-dir"])));
  const objectStore = resolve(canonicalRepo, await git(repo, ["rev-parse", "--git-path", `modules/${gitPath}`]));
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
