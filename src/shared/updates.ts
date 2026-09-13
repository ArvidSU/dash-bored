/** Versioned public release contract. Compatibility identifiers never follow display names. */
export const RELEASE_CHANNELS = [
  { id: "stable", label: "Stable", available: true },
  { id: "beta", label: "Beta", available: true },
  { id: "canary", label: "Canary", available: true },
] as const;
export type ReleaseChannel = typeof RELEASE_CHANNELS[number]["id"];
export interface UpdateSettings { channel: ReleaseChannel; automaticChecks: boolean }
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
  channel: ReleaseChannel;
  platform: "macos";
  arch: "arm64";
  dashboardContract: number;
  minimumContract: number;
  recipes: MigrationRecipe[];
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
