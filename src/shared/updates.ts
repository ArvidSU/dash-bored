/** Versioned public release contract. Compatibility identifiers never follow display names. */
export const RELEASE_CHANNELS = [
  { id: "canary", label: "Canary", available: true },
  { id: "beta", label: "Beta — coming later", available: false },
  { id: "stable", label: "Stable — coming later", available: false },
] as const;
export interface UpdateSettings { channel: "canary"; automaticChecks: boolean }
export interface MigrationRecipe {
  id: string;
  from: number;
  to: number;
  title: string;
  instructions: string;
}
export interface ReleaseMetadata {
  format: 1;
  product: "dash-bored";
  version: string;
  channel: "canary";
  platform: "macos";
  arch: "arm64";
  dashboardContract: number;
  minimumContract: number;
  recipes: MigrationRecipe[];
  /** Exact component API targets supported by this release. */
  componentApiVersions?: string[];
  notes: string;
  updater: { file: string; sha256: string };
  archive: { file: string; sha256: string };
  dmg: { file: string; sha256: string };
}
export interface PublishedRelease { metadata: ReleaseMetadata; url: string; assetBase: string }
export interface DashboardMigration {
  configPath: string;
  contract: number | null;
  status: "current" | "required" | "unsupported";
  steps: MigrationRecipe[];
  componentApi?: { supportedVersions: string[]; manifests: { path: string; version: string | null }[]; instructions: string };
  message: string;
}
export type MigrationChoice = "update-and-migrate" | "update-only";
export interface UpdateReceipt {
  format: 1;
  id: string;
  release: PublishedRelease;
  choice: MigrationChoice;
  selected: string[];
  installation: "downloading" | "ready" | "awaiting-install" | "installed" | "failed";
  cancelled: boolean;
  problem?: string;
  dmgPath?: string;
  migrations: Record<string, {
    status: "pending" | "running" | "finished" | "failed" | "interrupted";
    snapshot?: string;
    message?: string;
  }>;
}
export interface UpdateState {
  directInstallAvailable?: boolean;
  currentVersion: string;
  settings: UpdateSettings;
  release: PublishedRelease | null;
  dashboards: DashboardMigration[];
  receipt: UpdateReceipt | null;
  /** When this process last finished a successful release check. */
  checkedAt?: string;
  /** Startup reconciliation found this process is the receipt's newly installed target. */
  installedThisLaunch?: boolean;
  phase: "idle" | "checking" | "available" | "downloading" | "ready" | "updating-guidance" | "migrating" | "verifying" | "finished" | "problem";
  message: string;
}
export type UpdateAction =
  | { type: "check" }
  | { type: "settings"; settings: UpdateSettings }
  | { type: "prepare"; choice: MigrationChoice; selected: string[] }
  | { type: "install"; method?: "dmg" }
  | { type: "recover" }
  | { type: "cancel" }
  | { type: "migrate"; selected: string[] };

export function compareVersions(left: string, right: string): number {
  const parse = (value: string) => {
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/.exec(value);
    if (!match) throw new Error(`Unsupported release version: ${value}`);
    return { numbers: match.slice(1, 4).map(Number), pre: match[4] };
  };
  const a = parse(left), b = parse(right);
  for (let i = 0; i < 3; i++) if (a.numbers[i] !== b.numbers[i]) return a.numbers[i]! - b.numbers[i]!;
  if (a.pre === b.pre) return 0;
  if (!a.pre) return 1;
  if (!b.pre) return -1;
  const aa = a.pre.split('.'), bb = b.pre.split('.');
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
    const x = aa[i], y = bb[i];
    if (x === y) continue;
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) - Number(y);
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}
