import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import { resolveProjectLocation, TrustStore } from "../core/index";
import { AppSettingsStore, resolveDashBoredAgent } from "../main/app-settings";
import { ProjectRegistry } from "../main/project-registry";
import { resolveEnvironment } from "../core/environment";
import { UpdateCoordinator } from "../updates/coordinator";
import { assertNoRunningApp, bundledInstallation, openVerifiedDmg, releaseAppDataDirectory } from "../updates/installation";
import { createHeadlessHarness, runMigrationAgent } from "../updates/migration-agent";
import { inspectMigration } from "../updates/migrations";
import { BUNDLED_MIGRATIONS } from "../updates/releases";
import { atomicJson, getUpdateSettings, recoverUpdateLock, updateDirectory, validateUpdateSettings } from "../updates/storage";
import type { MigrationChoice } from "../shared/updates";

export const UPDATE_USAGE = `dash-bored update check | status | install | resume | cancel | recover
  dash-bored update [--update-and-migrate | --update-only] [--dashboard <path> ...]
  dash-bored update settings [--channel canary] [--automatic-checks on|off]
  dash-bored migrate inspect <dashboard>
  dash-bored migrate --dashboard <path> [--dashboard <path> ...]
--yes does not authorize migration. Non-interactive updates require an explicit choice.
The verified DMG retains normal macOS approval. Finish running work and save drafts before replacing the app.`;

export async function runUpdateCommand(command: 'update' | 'migrate', args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(UPDATE_USAGE); return 0; }
  const directory = updateDirectory();
  const data = releaseAppDataDirectory();
  const registry = new ProjectRegistry(join(data, 'projects-v1.json'));
  const selected: string[] = [];
  let choice: MigrationChoice | undefined;
  let channel: string | undefined;
  let checks: boolean | undefined;
  const verbs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--dashboard') { const p = args[++i]; if (!p || p.startsWith('-')) throw new Error('--dashboard needs a path.'); selected.push((await resolveProjectLocation(p)).configPath); }
    else if (arg === '--update-and-migrate' || arg === '--update-only') { if (choice) throw new Error('Choose exactly one update mode.'); choice = arg === '--update-only' ? 'update-only' : 'update-and-migrate'; }
    else if (arg === '--channel') { channel = args[++i]; if (!channel) throw new Error('--channel needs a value.'); }
    else if (arg === '--automatic-checks') { const value = args[++i]; if (value !== 'on' && value !== 'off') throw new Error('--automatic-checks accepts on or off.'); checks = value === 'on'; }
    else if (arg === '--yes') { /* Never confers migration authority. */ }
    else if (arg.startsWith('-')) throw new Error(`Unknown update option: ${arg}`);
    else verbs.push(arg);
  }
  if (command === 'migrate' && verbs[0] === 'inspect') {
    if (verbs.length !== 2 || selected.length || choice || channel || checks !== undefined) throw new Error('Usage: dash-bored migrate inspect <dashboard>');
    const path = (await resolveProjectLocation(verbs[1]!)).configPath;
    const result = await inspectMigration(path, BUNDLED_MIGRATIONS);
    console.log(JSON.stringify(result, null, 2)); return result.status === 'unsupported' ? 1 : 0;
  }
  if (verbs.length > 1) throw new Error(UPDATE_USAGE);
  const verb = verbs[0];
  if ((channel !== undefined || checks !== undefined) && verb !== 'settings') throw new Error('Use update settings for channel and automatic-check preferences.');
  if (verb === 'settings') {
    const old = await getUpdateSettings(directory);
    const next = validateUpdateSettings({ channel: channel ?? old.channel, automaticChecks: checks ?? old.automaticChecks });
    await atomicJson(join(directory, 'settings.json'), next); console.log(JSON.stringify(next, null, 2)); return 0;
  }
  const harness = createHeadlessHarness();
  const coordinator: UpdateCoordinator = new UpdateCoordinator({ directory,
    listDashboards: async () => [...new Set([...selected, ...(await registry.list()).map(p => p.configPath), ...(await coordinator.receipt())?.selected ?? []])],
    install: async receipt => { await assertNoRunningApp(directory); await bundledInstallation(); await openVerifiedDmg(receipt); },
    migrate: async (configPath, receipt, report, snapshotReady) => {
      await assertNoRunningApp(directory);
      const install = await bundledInstallation();
      const settings = await new AppSettingsStore(join(data, 'settings-v1.json')).get();
      return runMigrationAgent({ directory, configPath, receipt, report, snapshotReady, cliPath: install.cliPath,
        command: resolveDashBoredAgent(settings.dashBoredAgent, await resolveEnvironment(configPath, {})),
        trustStore: new TrustStore(join(data, 'trusted-projects-v1.json')), harness, stop: id => harness.stop(id), cancelled: () => coordinator.cancelled(receipt) });
    },
  });
  if (verb === 'recover') { await recoverUpdateLock(directory); console.log('Released the interrupted operation lock. Migrations still require explicit retry.'); return 0; }
  if (verb === 'cancel') { console.log(JSON.stringify(await coordinator.action({ type: 'cancel' }), null, 2)); return 0; }
  if (command === 'migrate') {
    if (verb || choice || !selected.length) throw new Error('Select dashboards explicitly: dash-bored migrate --dashboard <path>');
    console.log(JSON.stringify(await coordinator.action({ type: 'migrate', selected }), null, 2)); return 0;
  }
  if (verb === 'check') { const state = await coordinator.check(); console.log(JSON.stringify(state, null, 2)); return state.phase === 'problem' ? 1 : 0; }
  if (verb === 'resume') { await coordinator.reconcile(); console.log(JSON.stringify(await coordinator.state(), null, 2)); return 0; }
  if (verb === 'status') { console.log(JSON.stringify(await coordinator.state(), null, 2)); return 0; }
  if (verb === 'install') { console.log(JSON.stringify(await coordinator.action({ type: 'install' }), null, 2)); return 0; }
  if (verb) throw new Error(UPDATE_USAGE);
  if (!choice && !process.stdin.isTTY) throw new Error('Non-interactive updates require --update-and-migrate or --update-only; --yes alone does not authorize migration.');
  await bundledInstallation();
  const state = await coordinator.check();
  if (!state.release || state.phase === 'problem') { console.log(state.message); return state.phase === 'problem' ? 1 : 0; }
  console.log(`${state.message}\n${state.release.metadata.notes}\n${state.release.url}`);
  for (const d of state.dashboards) console.log(`${d.configPath}: ${d.message}`);
  if (!choice) {
    const input = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = (await input.question('1 Update and migrate selected dashboards; 2 Update only (affected dashboards may remain unavailable); 3 Later: ')).trim();
      if (answer === '3') return 0;
      if (answer !== '1' && answer !== '2') throw new Error('Choose 1, 2, or 3.');
      choice = answer === '1' ? 'update-and-migrate' : 'update-only';
      if (choice === 'update-and-migrate' && !selected.length) for (const d of state.dashboards.filter(d => d.status === 'required')) {
        if ((await input.question(`Migrate ${d.configPath}? [y/N] `)).trim().toLowerCase() === 'y') selected.push(d.configPath);
      }
    } finally { input.close(); }
  }
  const result = await coordinator.action({ type: 'prepare', choice, selected });
  console.log(`${result.message}\nRun dash-bored update install to open the verified DMG. Combined authorization continues when the target app starts. For CLI-only use, run dash-bored update resume in the new version.`);
  return 0;
}
