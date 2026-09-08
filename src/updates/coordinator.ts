import { randomUUID } from "node:crypto";
import { join, isAbsolute } from "node:path";
import { APP_VERSION } from "../shared/app-metadata";
import type { UpdateAction, UpdateReceipt, UpdateState, PublishedRelease } from "../shared/updates";
import { assertReleaseSource, downloadArtifact, hashFile } from "./artifacts";
import { BUNDLED_MIGRATIONS, compareVersions, discoverRelease, parseReleaseMetadata } from "./releases";
import { inspectMigration } from "./migrations";
import { atomicJson, getUpdateSettings, readJson, updateDirectory, validateUpdateSettings, withUpdateLock, recoverUpdateLock } from "./storage";

export interface UpdateCoordinatorOptions {
  directory?: string;
  currentVersion?: string;
  listDashboards: () => Promise<string[]>;
  fetcher?: typeof fetch;
  /** Host resolves drafts and running work before opening an installer. */
  install?: (receipt: UpdateReceipt, method?: "dmg") => Promise<void>;
  migrate?: (configPath: string, receipt: UpdateReceipt, report: (phase: UpdateState["phase"], message: string) => void, snapshotReady: (path: string) => Promise<void>) => Promise<{ snapshot: string; message: string }>;
}
export function parseReceipt(value: unknown): UpdateReceipt {
  const r = value as UpdateReceipt;
  if (!r || r.format !== 1 || typeof r.id !== "string" || !/^[a-zA-Z0-9-]+$/.test(r.id) || !r.release || !["update-only", "update-and-migrate"].includes(r.choice) || typeof r.cancelled !== "boolean" || !Array.isArray(r.selected) || r.selected.some(p => typeof p !== 'string' || !isAbsolute(p)) || !r.migrations || !["downloading", "ready", "awaiting-install", "installed", "failed"].includes(r.installation)) throw new Error("Update receipt is invalid; inspect it before recovery.");
  r.release.metadata = parseReleaseMetadata(r.release.metadata);
  assertReleaseSource(r.release);
  for (const [path, m] of Object.entries(r.migrations)) if (!r.selected.includes(path) || !m || !["pending", "running", "finished", "failed", "interrupted"].includes(m.status)) throw new Error("Invalid dashboard migration authorization.");
  return r;
}

export class UpdateCoordinator {
  readonly directory: string;
  private readonly current: string;
  private phase: UpdateState["phase"] = "idle";
  private message = "Check for published canary releases.";
  private discovered: PublishedRelease | null = null;
  private abort: AbortController | null = null;
  constructor(private readonly options: UpdateCoordinatorOptions) {
    this.directory = options.directory ?? updateDirectory();
    this.current = options.currentVersion ?? APP_VERSION;
  }
  private report = (phase: UpdateState["phase"], message: string) => { this.phase = phase; this.message = message; };
  async receipt(): Promise<UpdateReceipt | null> {
    const value = await readJson(join(this.directory, "receipt.json"));
    return value === null ? null : parseReceipt(value);
  }
  private save(receipt: UpdateReceipt): Promise<void> { return atomicJson(join(this.directory, "receipt.json"), receipt); }
  async state(): Promise<UpdateState> {
    const receipt = await this.receipt();
    if (receipt && await this.cancelled(receipt)) receipt.cancelled = true;
    const release = this.discovered ?? receipt?.release ?? null;
    const paths = [...new Set([...await this.options.listDashboards(), ...receipt?.selected ?? []])];
    return { currentVersion: this.current, settings: await getUpdateSettings(this.directory), release, receipt,
      dashboards: await Promise.all(paths.map(p => inspectMigration(p, release?.metadata ?? BUNDLED_MIGRATIONS))),
      phase: this.phase, message: this.message };
  }
  problem(error: unknown): void { this.report("problem", error instanceof Error ? error.message : String(error)); }
  async check(): Promise<UpdateState> {
    this.report("checking", "Checking GitHub for published canary releases…");
    try {
      this.discovered = await discoverRelease(this.current, this.options.fetcher);
      this.report(this.discovered ? "available" : "idle", this.discovered ? `Update available: ${this.discovered.metadata.version}` : "No newer published canary release.");
    } catch (error) { this.report("problem", String(error)); }
    return this.state();
  }
  async action(action: UpdateAction): Promise<UpdateState> {
    if (action.type === "recover") { await recoverUpdateLock(this.directory); await this.reconcile(); return this.state(); }
    if (action.type === "check") return this.check();
    if (action.type === "settings") { await atomicJson(join(this.directory, "settings.json"), validateUpdateSettings(action.settings)); return this.state(); }
    if (action.type === "cancel") {
      this.abort?.abort();
      // Cancellation is independent of the operation lock so a running download
      // or agent can observe it without waiting for that operation to finish.
      const r = await this.receipt();
      if (r) await atomicJson(join(this.directory, `cancel-${r.id}.json`), { cancelled: true });
      this.report("idle", "Continuation cancelled. Review existing edits before explicitly retrying.");
      return this.state();
    }
    return withUpdateLock(this.directory, async () => {
      try {
        if (action.type === "prepare") {
          if (!["update-only", "update-and-migrate"].includes(action.choice)) throw new Error("Choose Update and migrate or Update only explicitly.");
          const previous = await this.receipt();
          if (previous && !['installed', 'failed'].includes(previous.installation) && !await this.cancelled(previous)) throw new Error("An update is already pending. Cancel it before selecting another release.");
          const release = this.discovered ?? await discoverRelease(this.current, this.options.fetcher);
          if (!release || compareVersions(release.metadata.version, this.current) <= 0) throw new Error("No newer published update is available.");
          const selected = await this.selected(action.selected);
          if (action.choice === 'update-and-migrate') {
            for (const p of selected) if ((await inspectMigration(p, release.metadata)).status === 'unsupported') throw new Error(`Unsupported migration path: ${p}. Choose Update only or resolve the dashboard separately.`);
          }
          const receipt: UpdateReceipt = { format: 1, id: randomUUID(), release, choice: action.choice, selected, installation: "downloading", cancelled: false,
            migrations: Object.fromEntries(selected.map(p => [p, { status: "pending" as const }])) };
          await this.save(receipt);
          this.abort = new AbortController();
          this.report("downloading", "Downloading and verifying the macOS installer…");
          try {
            receipt.dmgPath = await downloadArtifact(release, "dmg", join(this.directory, receipt.id), this.options.fetcher, this.abort.signal);
            receipt.installation = 'ready';
            await this.save(receipt);
            this.report('ready', 'Ready to install. Save or cancel drafts and finish running work before replacing the app.');
          } catch (error) { receipt.installation = 'failed'; receipt.problem = String(error); await this.save(receipt); throw error; }
          finally { this.abort = null; }
        } else if (action.type === "install") {
          const r = await this.requiredReceipt();
          if (await this.cancelled(r)) throw new Error("Update continuation was cancelled. Choose an update again.");
          if (r.installation !== "ready" && r.installation !== "awaiting-install") throw new Error("Download and verify an installer before installation.");
          const dmgPath = join(this.directory, r.id, r.release.metadata.dmg.file);
          if (r.dmgPath !== dmgPath || await hashFile(dmgPath) !== r.release.metadata.dmg.sha256) throw new Error("Staged installer verification failed. Cancel and download again.");
          if (!this.options.install) throw new Error("Installation is unavailable in this host. Use the verified DMG and restart the matching app/CLI.");
          r.installation = "awaiting-install";
          await this.save(r);
          this.report("downloading", "Preparing verified installation. Finish running work before restart…");
          try { await this.options.install(r, action.method); }
          catch (error) { r.installation = "ready"; r.problem = String(error); await this.save(r); throw error; }
          this.report('ready', 'Verified DMG opened. Quit dash-bored after saving drafts and finishing running work, replace the app, and open the new version. Normal macOS Open Anyway approval still applies.');
        } else if (action.type === "migrate") {
          const r = await this.requiredReceipt();
          if (r.release.metadata.version !== this.current) throw new Error("Open the selected target version before migrating dashboards.");
          const selected = await this.selected(action.selected);
          r.installation = "installed";
          r.choice = "update-and-migrate";
          r.cancelled = false;
          // A new explicit action supersedes a cancelled authorization with a new id.
          r.id = randomUUID();
          r.selected = [...new Set([...r.selected, ...selected])];
          for (const [p, item] of Object.entries(r.migrations)) {
            if (!selected.includes(p) && item.status === 'pending') {
              item.status = 'interrupted'; item.message = 'Not selected for renewed migration authorization.';
            }
          }
          for (const p of selected) r.migrations[p] = { status: "pending" };
          await this.save(r);
          await this.continueMigrations(r);
        }
      } catch (error) { this.report("problem", error instanceof Error ? error.message : String(error)); throw error; }
      return this.state();
    });
  }
  async recordInstallationProblem(message: string): Promise<void> {
    this.problem(message);
    await withUpdateLock(this.directory, async () => {
      const r = await this.receipt();
      if (r && r.installation === 'awaiting-install' && r.release.metadata.version !== this.current) {
        r.installation = 'ready'; r.problem = message;
        await this.save(r);
      }
    });
  }
  async cancelled(r: UpdateReceipt): Promise<boolean> { return r.cancelled || await readJson(join(this.directory, `cancel-${r.id}.json`)) !== null; }
  private async selected(paths: string[]): Promise<string[]> {
    if (!Array.isArray(paths) || paths.some(p => typeof p !== 'string')) throw new Error("Select dashboard paths explicitly.");
    const known = await this.options.listDashboards();
    const unique = [...new Set(paths)];
    if (unique.some(p => !isAbsolute(p) || !known.includes(p))) throw new Error("Selected dashboard is not available in this app/CLI request.");
    return unique;
  }
  private async requiredReceipt(): Promise<UpdateReceipt> { const r = await this.receipt(); if (!r) throw new Error("No pending update. Check for updates first."); return r; }
  /** Run once per process startup; no polling path calls this. */
  async reconcile(): Promise<void> {
    await withUpdateLock(this.directory, async () => {
      const r = await this.receipt();
      if (!r) return;
      if (r.release.metadata.version === this.current) r.installation = "installed";
      if (await this.cancelled(r)) { r.cancelled = true; await this.save(r); this.report("finished", "App installed; automatic migration continuation cancelled."); return; }
      for (const migration of Object.values(r.migrations)) if (migration.status === "running") { migration.status = "interrupted"; migration.message = "Interrupted work requires explicit retry after reviewing the snapshot and edits."; }
      if (r.release.metadata.version !== this.current) { await this.save(r); return; }
      r.installation = "installed";
      await this.save(r);
      await this.continueMigrations(r);
    });
  }
  private async continueMigrations(r: UpdateReceipt): Promise<void> {
    if (await this.cancelled(r) || r.choice !== "update-and-migrate") { this.report('finished', 'App installed. Migrate dashboard remains available for deferred dashboards.'); return; }
    for (const path of r.selected) {
      if (await this.cancelled(r)) break;
      const item = r.migrations[path];
      if (!item || item.status !== "pending") continue;
      if (!(await this.options.listDashboards()).includes(path)) { item.status = 'failed'; item.message = 'Dashboard is no longer registered or selected.'; await this.save(r); continue; }
      const migration = await inspectMigration(path, r.release.metadata);
      if (migration.status === 'current') { item.status = 'finished'; item.message = migration.message; await this.save(r); continue; }
      if (migration.status === 'unsupported' || !this.options.migrate) { item.status = 'failed'; item.message = migration.status === 'unsupported' ? migration.message : 'Migration agent unavailable. Configure an agent and retry.'; await this.save(r); continue; }
      item.status = 'running';
      await this.save(r); // Durable claim before any edits; never auto-replay this state.
      try { const result = await this.options.migrate(path, r, this.report, async snapshot => { item.snapshot = snapshot; await this.save(r); }); item.status = 'finished'; Object.assign(item, result); }
      catch (error) { item.status = 'failed'; item.message = String(error); }
      await this.save(r);
    }
    const incomplete = Object.values(r.migrations).some(m => m.status !== 'finished');
    this.report(incomplete ? 'problem' : 'finished', incomplete ? 'App installed. Some dashboard migrations need review or explicit retry.' : 'App installation and selected dashboard migrations finished.');
  }
}
