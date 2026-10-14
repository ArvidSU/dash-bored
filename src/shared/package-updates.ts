/**
 * Update checks for git-pinned packages: external components in every
 * registered dashboard bundle, project themes, and personal themes. A check
 * reads remote refs only; an update is always an explicit command.
 */

export type PackageKind = "component" | "theme";

/** A pinned or advertised commit and the release tag that names it, when known. */
export interface PackageVersion {
  commit: string;
  /** A tag pointing at exactly this commit. */
  tag?: string;
  /** The nearest earlier local tag and how many commits follow it. */
  base?: { tag: string; ahead: number };
}

export interface PackageUpdateItem {
  /** Stable for one package in one store: kind, owner, and name. */
  id: string;
  kind: PackageKind;
  name: string;
  url: string;
  /** The owning dashboard bundle's config path, or null for a personal theme. */
  configPath: string | null;
  dashboardName: string | null;
  current: PackageVersion;
  /** The remote's default-branch head; null when the remote could not be read. */
  latest: PackageVersion | null;
  status: "current" | "available" | "unknown";
  /** Why Update cannot run here (missing checkout, local changes, parent-owned). */
  blocked?: string;
  /** The unreachable remote, or the last update failure for this package. */
  error?: string;
  /** A hosted compare page between the pin and the latest commit. */
  changesUrl?: string;
}

export interface PackageUpdateState {
  phase: "idle" | "checking" | "updating";
  /** When this process last finished a package check. */
  checkedAt: string | null;
  packages: PackageUpdateItem[];
  /** Packages the running update works through. */
  updating: string[];
  /** The last finished check or update, in words. */
  message: string;
  /** A failure that is not tied to one package, such as an unreadable lock. */
  problem: string;
}

export type PackageUpdateCommand =
  | { type: "check" }
  | { type: "update"; ids: string[] };

export const INITIAL_PACKAGE_UPDATE_STATE: PackageUpdateState = Object.freeze({
  phase: "idle",
  checkedAt: null,
  packages: [],
  updating: [],
  message: "",
  problem: "",
});

/** `v0.1.4`, `v0.1.4+3` for three commits after it, or the short commit. */
export function packageVersionLabel(version: PackageVersion): string {
  if (version.tag) return version.tag;
  if (version.base) return `${version.base.tag}+${version.base.ahead}`;
  return version.commit.slice(0, 7);
}

/** Packages an Update can act on now. */
export function updatablePackages(state: PackageUpdateState): PackageUpdateItem[] {
  return state.packages.filter((item) => item.status === "available" && !item.blocked);
}
