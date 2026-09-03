import { execFile } from "node:child_process";
import { rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import type { DashboardLock, ExternalComponentLockEntry } from "../shared/contracts";
import { CoreError, errorMessage } from "./diagnostics";
import { resolveProjectLocation, type ProjectLocation } from "./paths";
import { EXTERNAL_NAME_PATTERN } from "./tree";
import { parseDashboardLock, serializeDashboardLock } from "./yaml";

const execFileAsync = promisify(execFile);
const FULL_SHA_PATTERN = /^[0-9a-fA-F]{40}$/;
const GIT_TIMEOUT_MS = 120_000;
const LS_REMOTE_TIMEOUT_MS = 30_000;

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

interface GitRunOptions {
  timeoutMs?: number;
}

function gitErrorDetail(error: unknown): string {
  const withOutput = error as { stdout?: unknown; stderr?: unknown };
  const stderr = typeof withOutput.stderr === "string" ? withOutput.stderr.trim() : "";
  if (stderr) return stderr.slice(0, 2_000);
  return errorMessage(error).slice(0, 2_000);
}

async function runGit(args: string[], cwd: string, options: GitRunOptions = {}): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-c", "protocol.file.allow=always", ...args],
      { cwd, timeout: options.timeoutMs ?? GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
    );
    return stdout;
  } catch (error) {
    throw new CoreError(
      "COMPONENT_GIT_FAILED",
      `git ${args.join(" ")} failed: ${gitErrorDetail(error)}`,
    );
  }
}

async function repoRootFor(configDirectory: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-c", "protocol.file.allow=always", "rev-parse", "--show-toplevel"],
      { cwd: configDirectory, timeout: 15_000 },
    );
    return stdout.trim();
  } catch {
    throw new CoreError(
      "COMPONENT_GIT_REQUIRED",
      `External components require git: ${configDirectory} is not inside a git checkout. Initialize one (git init, then commit the bundle) before running component commands.`,
    );
  }
}

function submoduleGitPath(repoRoot: string, targetDirectory: string): string {
  const value = relative(repoRoot, targetDirectory).split(sep).join("/");
  if (value === "" || value.startsWith("../") || value === ".." || isAbsolute(value)) {
    throw new CoreError(
      "COMPONENT_GIT_REQUIRED",
      `External component directory escapes its git checkout: ${targetDirectory}.`,
    );
  }
  return value;
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

async function readLock(location: ProjectLocation): Promise<DashboardLock> {
  const parsed = await parseDashboardLock(location.lockPath);
  if (parsed.value === null) {
    const detail = parsed.diagnostics[0]?.message ?? "unknown error";
    throw new CoreError(
      "COMPONENT_LOCK_INVALID",
      `Cannot manage external components: ${location.lockPath} is invalid (${detail}). Fix the lock file and retry.`,
    );
  }
  return parsed.value;
}

async function writeLock(location: ProjectLocation, lock: DashboardLock): Promise<void> {
  const temporaryPath = `${location.lockPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, serializeDashboardLock(lock), "utf8");
    await rename(temporaryPath, location.lockPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw new CoreError(
      "COMPONENT_LOCK_WRITE_FAILED",
      `Could not write ${location.lockPath}: ${errorMessage(error)}`,
    );
  }
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
    output = await runGit(["ls-remote", url], process.cwd(), { timeoutMs: LS_REMOTE_TIMEOUT_MS });
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
    output = await runGit(
      ["ls-remote", url, ref, `refs/heads/${ref}`, `refs/tags/${ref}`],
      process.cwd(),
      { timeoutMs: LS_REMOTE_TIMEOUT_MS },
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function readCheckedOutCommit(targetDirectory: string): Promise<string | null> {
  // The `.git` entry (a gitfile for submodules, a directory for full clones)
  // proves the probe stays inside the component checkout: without it git
  // discovery would walk up and resolve the parent repository instead.
  try {
    await stat(join(targetDirectory, ".git"));
  } catch {
    return null;
  }
  try {
    const output = await runGit(["rev-parse", "HEAD"], targetDirectory, { timeoutMs: 15_000 });
    const sha = output.trim().toLowerCase();
    return FULL_SHA_PATTERN.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

async function readRemoteHead(url: string, cwd: string): Promise<string | null> {
  try {
    const output = await runGit(["ls-remote", url, "HEAD"], cwd, { timeoutMs: LS_REMOTE_TIMEOUT_MS });
    const refs = parseLsRemote(output);
    return refs[0]?.sha ?? null;
  } catch {
    // A status report must survive an unreachable remote; callers show "unknown".
    return null;
  }
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
  const location = await resolveProjectLocation(projectInput);
  const repoRoot = await repoRootFor(location.configDirectory);
  const lock = await readLock(location);
  if (lock.components[name] !== undefined) {
    throw new CoreError(
      "COMPONENT_ALREADY_PINNED",
      `External component ${name} is already pinned. ${pinnedNames(lock)}`,
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
  const gitPath = submoduleGitPath(repoRoot, targetDirectory);
  try {
    await runGit(["submodule", "add", url, gitPath], repoRoot);
  } catch (error) {
    throw new CoreError(
      "COMPONENT_ADD_FAILED",
      `Could not add ${name} from ${url}: ${gitErrorDetail(error)}`,
    );
  }
  try {
    await runGit(["checkout", commit], targetDirectory);
  } catch (error) {
    throw new CoreError(
      "COMPONENT_ADD_FAILED",
      `Added the ${name} submodule but could not check out ${commit}: ${gitErrorDetail(error)} Run \`dash-bored component remove ${name}\` to start over.`,
    );
  }
  const next: DashboardLock = {
    lockfileVersion: 1,
    components: { ...lock.components, [name]: { url, commit, path: lockPathFor(name) } },
  };
  await writeLock(location, next);
  return { name, commit };
}

export async function listComponents(projectInput: string): Promise<ExternalComponentSummary[]> {
  const location = await resolveProjectLocation(projectInput);
  const lock = await readLock(location);
  return Object.entries(lock.components)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, entry]) => ({ name, url: entry.url, commit: entry.commit, path: entry.path }));
}

export async function statusComponents(
  projectInput: string,
  name?: string,
): Promise<ExternalComponentStatus[]> {
  const location = await resolveProjectLocation(projectInput);
  const repoRoot = await repoRootFor(location.configDirectory);
  const lock = await readLock(location);
  const entries = name === undefined
    ? Object.entries(lock.components).sort(([left], [right]) => left.localeCompare(right))
    : [[name, lockEntryOrThrow(lock, name)] as const];
  const statuses: ExternalComponentStatus[] = [];
  for (const [entryName, entry] of entries) {
    const targetDirectory = targetDirectoryFor(location, entryName);
    const checkedOutCommit = await readCheckedOutCommit(targetDirectory);
    const initialized = checkedOutCommit !== null;
    const dirty = initialized
      ? (await runGit(["status", "--porcelain"], targetDirectory, { timeoutMs: 15_000 })).trim().length > 0
      : false;
    const remoteHead = await readRemoteHead(entry.url, repoRoot);
    statuses.push({
      name: entryName,
      url: entry.url,
      commit: entry.commit,
      path: entry.path,
      initialized,
      checkedOutCommit,
      dirty,
      inSync: initialized && checkedOutCommit === entry.commit.toLowerCase(),
      updateAvailable: remoteHead === null ? null : remoteHead !== entry.commit.toLowerCase(),
    });
  }
  return statuses;
}

export async function updateComponent(
  projectInput: string,
  name: string,
  options: ExternalComponentUpdateOptions = {},
): Promise<ExternalComponentUpdateResult> {
  validateComponentName(name);
  const location = await resolveProjectLocation(projectInput);
  await repoRootFor(location.configDirectory);
  const lock = await readLock(location);
  const entry = lockEntryOrThrow(lock, name);
  const targetDirectory = targetDirectoryFor(location, name);
  const checkedOutCommit = await readCheckedOutCommit(targetDirectory);
  if (checkedOutCommit === null) {
    throw new CoreError(
      "COMPONENT_NOT_INITIALIZED",
      `External component ${name} is not initialized. Run \`dash-bored component sync\` first.`,
    );
  }
  const porcelain = await runGit(["status", "--porcelain"], targetDirectory, { timeoutMs: 15_000 });
  if (porcelain.trim().length > 0) {
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
  if (commit === entry.commit.toLowerCase() && checkedOutCommit === entry.commit.toLowerCase()) {
    return { name, commit: entry.commit, changed: false };
  }
  let fetchDetail: string | null = null;
  try {
    await runGit(["fetch", "origin"], targetDirectory);
  } catch (error) {
    // A SHA checkout is content-addressed: stale objects fail below with a clear
    // error, so a failed opportunistic fetch must not block an update that the
    // local clone can already satisfy.
    fetchDetail = gitErrorDetail(error);
  }
  try {
    await runGit(["checkout", commit], targetDirectory);
  } catch (error) {
    throw new CoreError(
      "COMPONENT_UPDATE_FAILED",
      `Could not check out ${commit} for ${name}: ${gitErrorDetail(error)}${fetchDetail ? ` (fetch also failed: ${fetchDetail})` : ""} Run \`dash-bored component sync\` to restore the pinned checkout.`,
    );
  }
  const next: DashboardLock = {
    lockfileVersion: 1,
    components: { ...lock.components, [name]: { ...entry, commit } },
  };
  await writeLock(location, next);
  return { name, commit, changed: commit !== entry.commit.toLowerCase() };
}

export async function removeComponent(
  projectInput: string,
  name: string,
): Promise<ExternalComponentRemoveResult> {
  validateComponentName(name);
  const location = await resolveProjectLocation(projectInput);
  const repoRoot = await repoRootFor(location.configDirectory);
  const lock = await readLock(location);
  lockEntryOrThrow(lock, name);
  const targetDirectory = targetDirectoryFor(location, name);
  const gitPath = submoduleGitPath(repoRoot, targetDirectory);
  // Best effort: a hand-edited .gitmodules may already lack the entry, in which
  // case `git rm` below still performs the removal.
  try {
    await runGit(["submodule", "deinit", "-f", "--", gitPath], repoRoot);
  } catch {
    // Fall through to `git rm`, which reports the actionable error if the path
    // is genuinely not a registered submodule.
  }
  try {
    await runGit(["rm", "-f", "--", gitPath], repoRoot);
  } catch (error) {
    throw new CoreError(
      "COMPONENT_REMOVE_FAILED",
      `Could not detach ${name}: ${gitErrorDetail(error)}`,
    );
  }
  // `git rm` keeps the submodule's object store below .git/modules when the
  // submodule was never committed; that residue blocks re-adding the same
  // name, so remove the entry that belongs to exactly this submodule.
  try {
    const gitDir = join(repoRoot, ".git");
    if ((await stat(gitDir)).isDirectory()) {
      await rm(join(gitDir, "modules", ...gitPath.split("/")), { recursive: true, force: true });
    }
  } catch {
    // The lock entry below is the source of truth; a leftover object store
    // only costs disk space and never affects resolution.
  }
  const { [name]: _removed, ...remaining } = lock.components;
  await writeLock(location, { lockfileVersion: 1, components: remaining });
  return { name };
}

export async function syncComponents(projectInput: string): Promise<ExternalComponentSummary[]> {
  const location = await resolveProjectLocation(projectInput);
  const repoRoot = await repoRootFor(location.configDirectory);
  const lock = await readLock(location);
  const entries = Object.entries(lock.components).sort(([left], [right]) => left.localeCompare(right));
  const synced: ExternalComponentSummary[] = [];
  for (const [name, entry] of entries) {
    const targetDirectory = targetDirectoryFor(location, name);
    const gitPath = submoduleGitPath(repoRoot, targetDirectory);
    try {
      await runGit(["submodule", "update", "--init", "--checkout", "--", gitPath], repoRoot);
    } catch (error) {
      throw new CoreError(
        "COMPONENT_SYNC_FAILED",
        `Could not initialize ${name} from ${entry.url}: ${gitErrorDetail(error)} Re-add it with \`dash-bored component add ${entry.url} --name ${name}\`.`,
      );
    }
    try {
      await runGit(["checkout", entry.commit], targetDirectory);
    } catch (error) {
      throw new CoreError(
        "COMPONENT_SYNC_FAILED",
        `Initialized ${name} but could not check out the pinned ${entry.commit}: ${gitErrorDetail(error)} Discard local changes inside ${targetDirectory} and retry.`,
      );
    }
    synced.push({ name, url: entry.url, commit: entry.commit, path: entry.path });
  }
  return synced;
}
