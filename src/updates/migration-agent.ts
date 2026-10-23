import { createHash, randomUUID } from "node:crypto";
import { chmod, cp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DASH_BORED_SKILL_FILES } from "../cli/skill-payload";
import { loadProjectDefinition, resolveProjectLocation, TrustStore } from "../core/index";
import { resolveEnvironment } from "../core/environment";
import { assertProjectLocationContained, type ProjectLocation } from "../core/paths";
import { assertAgentAvailable } from "../main/agent-preflight";
import { DashboardSetupSupervisor, type DashboardSetupHarness } from "../main/dashboard-setup";
import { updateInstalledTools } from "../main/installed-tools";
import { APP_VERSION } from "../shared/app-metadata";
import type { Permission } from "../shared/contracts";
import type { UpdateReceipt, UpdateState } from "../shared/updates";
import { BUNDLED_MIGRATIONS } from "./releases";
import { inspectMigration } from "./migrations";
import { atomicJson } from "./storage";

export interface MigrationAgentOptions {
  directory: string;
  configPath: string;
  receipt: UpdateReceipt;
  /** The target release's bundled agent tool. */
  toolPath: string;
  command: string;
  trustStore: TrustStore;
  harness: DashboardSetupHarness;
  cancelled: () => Promise<boolean>;
  /** Ends one of the migration's agent sessions; `cancelled` when the migration was stopped. */
  close?: (id: string, options: { cancelled: boolean }) => Promise<unknown>;
  report: (phase: UpdateState["phase"], message: string) => void;
  snapshotReady: (path: string) => Promise<void>;
}

export interface MigrationSessionOptions {
  command: string;
  location: ProjectLocation;
  configPath: string;
  prompt: string;
  env: Record<string, string>;
  /** The trust grant the migration was authorized with. */
  permissions: Permission[];
  /** The app's agent sessions. */
  harness: DashboardSetupHarness;
  close?: MigrationAgentOptions["close"];
  /** Reads project trust again; false, or a thrown error, stops the migration. */
  isTrusted: () => Promise<boolean>;
  cancelled: () => Promise<boolean>;
  report: MigrationAgentOptions["report"];
}

/**
 * Runs the migration's agent session until the supervisor reports a final
 * validation. Resolves on a valid dashboard; rejects on any other outcome,
 * including a failed turn-end hook. Every session it started is closed
 * before it returns, and validations after the outcome are ignored.
 */
export async function superviseMigrationSession(options: MigrationSessionOptions): Promise<{ stopped: boolean }> {
  const { command, location, configPath, report } = options;
  let trusted = true;
  const refreshTrust = async () => { trusted = await options.isTrusted(); };
  // Sessions stay open after their turn; every one this migration started is
  // closed when it ends, and at once if it is cancelled or trust changes.
  const active = new Set<string>();
  const cancelled = new Set<string>();
  let stopped = false;
  let settled = false;
  let succeed!: () => void;
  let fail!: (error: unknown) => void;
  const outcome = new Promise<void>((resolve, reject) => {
    succeed = () => { settled = true; resolve(); };
    fail = (error) => { settled = true; reject(error); };
  });
  const ensureAllowed = async () => {
    await refreshTrust();
    if (!trusted || await options.cancelled()) throw new Error('Migration cancelled or project trust changed.');
  };
  const harness: DashboardSetupHarness = {
    launch: async request => {
      await ensureAllowed();
      const onTurnEnd = request.onTurnEnd;
      const result = await options.harness.launch({ ...request, ...onTurnEnd ? { onTurnEnd: async task => {
        try {
          await refreshTrust();
          await onTurnEnd(task);
        } catch (error) {
          // The sessions only record a failed hook on the task; the migration must end too.
          fail(error);
          throw error;
        }
      } } : {} });
      active.add(result.taskId);
      return result;
    },
    followUp: async (id, prompt) => {
      await ensureAllowed();
      await options.harness.followUp(id, prompt);
    },
    setValidation: (id, value) => options.harness.setValidation(id, value),
    isCancelled: id => stopped || cancelled.has(id) || options.harness.isCancelled?.(id) === true,
  };
  const timer = setInterval(() => { void (async () => {
    await refreshTrust();
    if (!trusted || await options.cancelled()) {
      stopped = true;
      for (const id of active) { cancelled.add(id); await options.close?.(id, { cancelled: true }); }
    }
  })().catch(() => { stopped = true; }); }, 500);
  try {
    const supervisor = new DashboardSetupSupervisor({
      command, location, harness, preflight: assertAgentAvailable,
      runtime: {
        getSnapshot: () => ({ configPath, projectRoot: location.projectRoot, tree: null, trusted, requestedPermissions: options.permissions }),
        getLaunchEnvironment: async () => { await refreshTrust(); return options.env; },
        reload: async () => { await refreshTrust(); },
      },
      onValidation: validation => {
        if (settled) return;
        if (validation.status === 'checking') report('verifying', 'Validating migrated dashboard…');
        else if (validation.status === 'repairing') report('migrating', 'Running the single corrective attempt…');
        else if (validation.status === 'valid') succeed();
        else fail(new Error(`${validation.message ?? validation.status} ${validation.diagnostics.map(d => d.message).join('; ')}`));
      },
    });
    report('migrating', `Migrating ${configPath}…`);
    void supervisor.launchRequest({ prompt: options.prompt, configPath, componentPath: `${configPath}#migration`, request: 'Migrate this dashboard', purpose: 'migration' }).catch(fail);
    await outcome;
    return { stopped };
  } finally {
    clearInterval(timer);
    // Closing an already closed session is a no-op; a finished migration's session is not "cancelled".
    for (const id of active) await options.close?.(id, { cancelled: false }).catch(() => undefined);
  }
}

/** Target executable's embedded payload is authoritative even when installed skills conflict. */
export async function runMigrationAgent(options: MigrationAgentOptions): Promise<{ snapshot: string; message: string }> {
  const { receipt, configPath, report, trustStore, command } = options;
  const metadata = receipt.release.metadata;
  if (metadata.version !== APP_VERSION || metadata.dashboardContract !== BUNDLED_MIGRATIONS.dashboardContract || metadata.minimumContract !== BUNDLED_MIGRATIONS.minimumContract || JSON.stringify(metadata.recipes) !== JSON.stringify(BUNDLED_MIGRATIONS.recipes) || JSON.stringify(metadata.componentApiVersions) !== JSON.stringify(BUNDLED_MIGRATIONS.componentApiVersions)) throw new Error("Target release guidance does not match this executable. Install the exact target version first.");
  const location = await resolveProjectLocation(configPath);
  if (await realpath(configPath) !== configPath) throw new Error("Dashboard path changed or became a symlink; explicitly select it again.");
  await assertProjectLocationContained(location);
  const grant = await trustStore.getGrant(location.projectRoot);
  if (!grant || !grant.permissions.includes('process:execute')) throw new Error("Review project trust in dash-bored before running a migration agent.");
  const toolVersion = Bun.spawn([options.toolPath, '--version'], { stdout: 'pipe', stderr: 'pipe' });
  if (await toolVersion.exited !== 0 || (await new Response(toolVersion.stdout).text()).trim() !== APP_VERSION) throw new Error("The migration agent tool is not the target release's executable.");
  const migration = await inspectMigration(configPath, metadata, { fresh: true });
  if (migration.status !== 'required') throw new Error(migration.message);
  const initial = await loadProjectDefinition(location, { compile: true });
  const env = { ...await resolveEnvironment(configPath, {}), DASH_BORED_TOOL: options.toolPath, DASH_BORED_AGENT: command };
  assertAgentAvailable(command, env, location.projectRoot);
  if (await options.cancelled()) throw new Error("Migration cancelled before snapshot.");
  report('updating-guidance', 'Refreshing previously installed agent guidance…');
  const conflicts = await updateInstalledTools({ projectRoots: [location.projectRoot] });
  const runDirectory = join(options.directory, 'migrations', receipt.id, `${createHash('sha256').update(configPath).digest('hex').slice(0, 16)}-${randomUUID()}`);
  const handoff = join(runDirectory, 'guidance');
  for (const [path, text] of Object.entries(DASH_BORED_SKILL_FILES)) {
    const target = join(handoff, path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, text, { mode: path.startsWith('scripts/') ? 0o555 : 0o444 });
  }
  await writeFile(join(handoff, 'migration.json'), JSON.stringify(migration, null, 2), { mode: 0o444 });
  await chmod(handoff, 0o555);
  const snapshot = join(runDirectory, 'snapshot');
  await cp(location.configDirectory, snapshot, { recursive: true, dereference: false, errorOnExist: true, force: false });
  await atomicJson(join(runDirectory, 'recovery.json'), { configPath, snapshot, createdAt: new Date().toISOString(), release: APP_VERSION });
  await options.snapshotReady(snapshot);
  const prompt = [
    `Migrate only the selected dashboard ${JSON.stringify(configPath)} to dash-bored ${APP_VERSION}.`,
    `Read the exact target skill ${JSON.stringify(join(handoff, 'SKILL.md'))} and its references/migrations.md, then ${JSON.stringify(join(handoff, 'migration.json'))}.`,
    `Agent tool: ${JSON.stringify(join(handoff, 'scripts', 'dash-bored'))} (resolves ${JSON.stringify(options.toolPath)}). Recovery snapshot: ${JSON.stringify(snapshot)}.`,
    'Preserve unrelated files, environment files, customized guidance, and exact component pins except incompatible packages identified by the supplied component API migration instructions. Do not grant trust. Do not edit the read-only handoff or snapshot.',
    `Current diagnostics: ${JSON.stringify(initial.diagnostics)}`,
    `Guidance refresh conflicts (preserved): ${JSON.stringify(conflicts)}`,
    'Apply the supplied cumulative recipes in order and the componentApi instructions when present, then validate with that agent tool. When your turn ends, the host validates the dashboard and may ask for at most one repair in this session.',
  ].join('\n');
  const { stopped } = await superviseMigrationSession({
    command, location, configPath, prompt, env, permissions: grant.permissions as Permission[],
    harness: options.harness, close: options.close, report, cancelled: options.cancelled,
    isTrusted: () => trustStore.isTrusted(location.projectRoot, grant.permissions),
  });
  if (await options.cancelled() || stopped) throw new Error('Migration cancelled. Review the saved edits before retrying.');
  if ((await inspectMigration(configPath, metadata, { fresh: true })).status !== 'current') throw new Error('Agent finished but the dashboard contract was not migrated. Review the snapshot and retry.');
  // Read recovery metadata back before reporting a usable recovery path.
  await readFile(join(runDirectory, 'recovery.json'), 'utf8');
  return { snapshot, message: 'Dashboard migration and validation finished.' };
}
