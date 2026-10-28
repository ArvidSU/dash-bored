import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { PackageKind, PackageUpdateItem, PackageVersion } from "../shared/package-updates";
import { errorMessage } from "./diagnostics";
import {
  assertManagedCheckout,
  checkedOutCommit,
  git,
  readPackageStore,
  readRemoteHeadAndTags,
  type PackageStrategy,
  type RemoteHeadAndTags,
} from "./package-store";
import { exists, resolveProjectLocation } from "./paths";
import { personalThemesDirectory } from "./themes";
import { EXTERNAL_NAME_PATTERN } from "./tree-catalog";

/**
 * Update checks for pinned packages. A check reads each pin, inspects its
 * checkout locally, and reads remote HEAD and tags with one ls-remote per
 * repository. It never fetches, writes a lock, or touches a checkout, so it can
 * run unattended; updating stays with the package kinds' explicit operations.
 */

export interface PackageUpdateSource {
  /** A dashboard bundle's config path, or null for the personal theme store. */
  configPath: string | null;
  dashboardName?: string | null;
}

export interface PinnedPackage {
  id: string;
  kind: PackageKind;
  name: string;
  url: string;
  commit: string;
  configPath: string | null;
  dashboardName: string | null;
  /** Where the package kind places this checkout. */
  checkout: string;
  /** The store root that owns the checkout's Git metadata. */
  storeRoot: string;
  strategy: PackageStrategy;
}

export interface PackageUpdateCheck {
  packages: PackageUpdateItem[];
  /** Stores that could not be read, in words. */
  problems: string[];
}

export interface PackageUpdateCheckOptions {
  personalDirectory?: string;
  readRemote?: (url: string) => Promise<RemoteHeadAndTags>;
}

const REMOTE_CONCURRENCY = 4;
const LOCAL_GIT_TIMEOUT_MS = 15_000;

export function packageUpdateId(kind: PackageKind, configPath: string | null, name: string): string {
  return `${kind}:${configPath ?? "personal"}:${name}`;
}

/** Every pin in one store; a bundle without a lock file, or no longer on disk, pins nothing. */
export async function listPinnedPackages(
  source: PackageUpdateSource,
  options: { personalDirectory?: string } = {},
): Promise<PinnedPackage[]> {
  const dashboardName = source.dashboardName ?? null;
  if (source.configPath === null) {
    const root = options.personalDirectory ?? personalThemesDirectory();
    const { lock } = await readPackageStore(root, "clone");
    return Object.entries(lock.themes ?? {}).filter(([name]) => EXTERNAL_NAME_PATTERN.test(name)).map(([name, entry]) => ({
      id: packageUpdateId("theme", null, name), kind: "theme" as const, name, url: entry.url, commit: entry.commit.toLowerCase(),
      configPath: null, dashboardName, checkout: join(root, name), storeRoot: root, strategy: "clone" as const,
    }));
  }
  if (!(await exists(source.configPath, stat))) return [];
  const location = await resolveProjectLocation(source.configPath);
  if (!(await exists(location.lockPath, stat))) return [];
  const { lock } = await readPackageStore(location.configDirectory, "submodule");
  const configPath = location.configPath;
  const pinned = (kind: PackageKind, entries: typeof lock.components, directory: string): PinnedPackage[] =>
    Object.entries(entries).filter(([name]) => EXTERNAL_NAME_PATTERN.test(name)).map(([name, entry]) => ({
      id: packageUpdateId(kind, configPath, name), kind, name, url: entry.url, commit: entry.commit.toLowerCase(),
      configPath, dashboardName, checkout: join(directory, name), storeRoot: location.configDirectory, strategy: "submodule",
    }));
  return [
    ...pinned("component", lock.components, join(location.componentsDirectory, "external")),
    ...pinned("theme", lock.themes ?? {}, join(location.configDirectory, "themes", "external")),
  ];
}

interface CheckoutState {
  blocked?: string;
  base?: PackageVersion["base"];
}

/** Local reasons an update would refuse, and the nearest tag below the pin. */
async function inspectCheckout(pkg: PinnedPackage): Promise<CheckoutState> {
  if ((await checkedOutCommit(pkg.checkout)) === null) {
    return { blocked: pkg.configPath ? "Not checked out. Sync this dashboard's packages, then update." : "Not checked out. Sync personal themes, then update." };
  }
  if (pkg.strategy === "submodule") {
    try {
      await assertManagedCheckout({ root: pkg.storeRoot }, pkg.checkout);
    } catch (error) {
      return { blocked: errorMessage(error) };
    }
  }
  let base: CheckoutState["base"];
  try {
    const described = await git(pkg.checkout, ["describe", "--tags", "--long", "--abbrev=7", pkg.commit], LOCAL_GIT_TIMEOUT_MS);
    const match = /^(.+)-(\d+)-g[0-9a-f]+$/.exec(described);
    if (match) base = { tag: match[1]!, ahead: Number(match[2]) };
  } catch {
    // No tag below the pin, or the pin is not in the local clone yet.
  }
  try {
    // Optional locks off: a background status must not rewrite the index.
    if (await git(pkg.checkout, ["--no-optional-locks", "status", "--porcelain"], LOCAL_GIT_TIMEOUT_MS)) {
      return { blocked: `Has local changes. Commit or discard them in ${pkg.checkout} before updating.`, base };
    }
  } catch (error) {
    return { blocked: `Could not read the checkout: ${errorMessage(error)}`, base };
  }
  return { base };
}

function semverParts(tag: string): number[] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(tag);
  return match ? match.slice(1).map(Number) : null;
}

/** The release-like name for a commit: the highest semver tag, else the last by name. */
export function preferredTag(tags: readonly string[] | undefined): string | undefined {
  if (!tags?.length) return undefined;
  return [...tags].sort((left, right) => {
    const a = semverParts(left);
    const b = semverParts(right);
    if (a && b) return a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!;
    if (a || b) return a ? 1 : -1;
    return left.localeCompare(right);
  }).at(-1);
}

const HOSTED_REPOSITORY = /^(?:https:\/\/|ssh:\/\/git@|git@)(github\.com|gitlab\.com|codeberg\.org)[/:](.+?)(?:\.git)?\/?$/;
const PATH_SEGMENT = /^[A-Za-z0-9_.-]+$/;

/** A browser page listing the commits between two pins, for well-known hosts only. */
export function packageChangesUrl(url: string, from: string, to: string): string | undefined {
  const match = HOSTED_REPOSITORY.exec(url.trim());
  if (!match) return undefined;
  const [, host, path] = match as unknown as [string, string, string];
  const segments = path.split("/");
  if (segments.length < 2 || segments.some((segment) => !PATH_SEGMENT.test(segment) || /^\.+$/.test(segment))) return undefined;
  return `https://${host}/${segments.join("/")}${host === "gitlab.com" ? "/-" : ""}/compare/${from}...${to}`;
}

async function mapLimited<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]!);
    }
  }));
  return results;
}

/** Compare every pin in `sources` with its remote's default branch. */
export async function checkPackageUpdates(
  sources: readonly PackageUpdateSource[],
  options: PackageUpdateCheckOptions = {},
): Promise<PackageUpdateCheck> {
  const problems: string[] = [];
  const pinned: PinnedPackage[] = [];
  for (const source of sources) {
    try {
      pinned.push(...await listPinnedPackages(source, options));
    } catch (error) {
      const owner = source.configPath === null ? "personal themes" : source.dashboardName?.trim() || source.configPath;
      problems.push(`Could not read the packages of ${owner}: ${errorMessage(error)}`);
    }
  }
  const readRemote = options.readRemote ?? readRemoteHeadAndTags;
  const urls = [...new Set(pinned.map((pkg) => pkg.url))];
  const remotes = new Map<string, RemoteHeadAndTags | Error>();
  await mapLimited(urls, REMOTE_CONCURRENCY, async (url) => {
    remotes.set(url, await readRemote(url).catch((error: unknown) => error instanceof Error ? error : new Error(String(error))));
  });
  const checkouts = await mapLimited(pinned, REMOTE_CONCURRENCY, inspectCheckout);
  const packages = pinned.map((pkg, index): PackageUpdateItem => {
    const local = checkouts[index]!;
    const remote = remotes.get(pkg.url)!;
    const known = remote instanceof Error ? undefined : remote;
    const tag = preferredTag(known?.tags.get(pkg.commit)) ?? (local.base?.ahead === 0 ? local.base.tag : undefined);
    const current: PackageVersion = { commit: pkg.commit, ...tag ? { tag } : local.base ? { base: local.base } : {} };
    const item: PackageUpdateItem = {
      id: pkg.id, kind: pkg.kind, name: pkg.name, url: pkg.url, configPath: pkg.configPath, dashboardName: pkg.dashboardName,
      current, latest: null, status: "unknown", ...local.blocked ? { blocked: local.blocked } : {},
    };
    if (!known) return { ...item, error: errorMessage(remote) };
    if (!known.head) return { ...item, error: `${pkg.url} advertises no default branch.` };
    const latestTag = preferredTag(known.tags.get(known.head));
    const latest: PackageVersion = { commit: known.head, ...latestTag ? { tag: latestTag } : {} };
    if (known.head === pkg.commit) return { ...item, latest: current, status: "current" };
    const changesUrl = packageChangesUrl(pkg.url, pkg.commit, known.head);
    return { ...item, latest, status: "available", ...changesUrl ? { changesUrl } : {} };
  });
  return { packages, problems };
}
