import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UpdateCoordinator, parseReceipt } from '../../src/updates/coordinator';
import { compareVersions, discoverRelease, parseReleaseMetadata, RELEASE_ASSET_BASE } from '../../src/updates/releases';
import { inspectMigration } from '../../src/updates/migrations';
import { atomicJson, getUpdateSettings, validateUpdateSettings, withUpdateLock } from '../../src/updates/storage';
import { downloadArtifact } from '../../src/updates/artifacts';
import type { PublishedRelease, ReleaseMetadata, UpdateReceipt } from '../../src/shared/updates';
import { APP_NAME } from '../../src/shared/app-metadata';
import { DASH_BORED_SKILL_FILES } from '../../src/cli/skill-payload';

const directories: string[] = [];
afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
function metadata(version = '0.3.0', migrate = false): ReleaseMetadata {
  return { format: 1, product: 'dash-bored', version, channel: 'canary', platform: 'macos', arch: 'arm64', dashboardContract: migrate ? 3 : 2, minimumContract: 2,
    recipes: migrate ? [{ id: 'contract-three', from: 2, to: 3, title: 'Third contract', instructions: 'Upgrade the dashboard contract.' }] : [],
    notes: 'Release notes', updater: { file: 'canary-macos-arm64-update.json', sha256: sha('manifest') }, archive: { file: 'app.app.tar.zst', sha256: sha('archive') }, dmg: { file: 'app.dmg', sha256: sha('dmg') } };
}
function release(m = metadata()): PublishedRelease { return { metadata: m, assetBase: `${RELEASE_ASSET_BASE}v${m.version}/`, url: `https://github.com/ArvidSU/dash-bored/releases/tag/v${m.version}` }; }
const fetcher = (m = metadata(), payload = 'dmg'): typeof fetch => (async (url: string | URL | Request) => {
  const u = String(url);
  if (u.includes('api.github.com')) return Response.json([{ draft: true, tag_name: 'v99.0.0', assets: [{ name: 'dash-bored-release.json' }] }, { draft: false, tag_name: `v${m.version}`, assets: [{ name: 'dash-bored-release.json' }, { name: m.dmg.file }, { name: m.archive.file }, { name: m.updater.file }] }]);
  if (u.endsWith('dash-bored-release.json')) return Response.json(m);
  return new Response(payload);
}) as typeof fetch;
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'dash-bored-updates-')); directories.push(dir);
  const config = join(dir, 'project', '.dash-bored', 'dash-bored.yaml');
  await mkdir(join(dir, 'project', '.dash-bored'), { recursive: true });
  await writeFile(config, 'schemaVersion: 2\n');
  return { dir, config };
}
function receipt(config: string, m = metadata('0.3.0', true)): UpdateReceipt {
  return { format: 1, id: 'test-transaction', release: release(m), choice: 'update-and-migrate', selected: [config], cancelled: false, installation: 'awaiting-install', migrations: { [config]: { status: 'pending' } } };
}

describe('release identity and discovery', () => {
  test('canonical CLI and skill identity match shared metadata', () => { expect(APP_NAME).toBe('dash-bored'); expect(DASH_BORED_SKILL_FILES['SKILL.md']).toContain('name: dash-bored'); expect(DASH_BORED_SKILL_FILES['agents/openai.yaml']).toContain('display_name: "dash-bored"'); expect(DASH_BORED_SKILL_FILES['references/migrations.md']).toContain('snapshot'); });
  test('semver ordering and drafts/older releases', async () => {
    expect(compareVersions('1.0.0-beta.10', '1.0.0-beta.2')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '1.0.0-beta.10')).toBeGreaterThan(0);
    expect((await discoverRelease('0.2.6', fetcher()))?.metadata.version).toBe('0.3.0');
    expect(await discoverRelease('0.3.0', fetcher())).toBeNull();
  });
  test('offline check is recoverable and does not destroy pending authorization', async () => {
    const { dir, config } = await fixture(); await atomicJson(join(dir, 'receipt.json'), receipt(config));
    const c = new UpdateCoordinator({ directory: dir, listDashboards: async () => [config], fetcher: (async () => { throw new Error('offline'); }) as unknown as typeof fetch });
    expect((await c.check()).phase).toBe('problem'); expect((await c.receipt())?.choice).toBe('update-and-migrate');
  });
  test('malformed metadata fails closed', () => {
    expect(() => parseReleaseMetadata({ ...metadata(), channel: 'stable' })).toThrow();
    expect(() => parseReleaseMetadata({ ...metadata(), archive: { file: '../bad', sha256: sha('') } })).toThrow();
    expect(() => parseReleaseMetadata({ ...metadata('0.3.0', true), recipes: [] })).toThrow('Missing');
    expect(() => parseReleaseMetadata({ ...metadata('0.3.0', true), recipes: [metadata('0.3.0', true).recipes[0], metadata('0.3.0', true).recipes[0]] })).toThrow();
  });
  test('checksum mismatch never publishes staged file', async () => {
    const { dir } = await fixture(); await expect(downloadArtifact(release(), 'dmg', dir, fetcher(metadata(), 'wrong'))).rejects.toThrow('SHA-256');
    await expect(readFile(join(dir, 'app.dmg'))).rejects.toThrow();
  });
  test('channels and check preference are shared, persisted, and strict', async () => {
    const { dir } = await fixture(); expect(await getUpdateSettings(dir)).toEqual({ channel: 'canary', automaticChecks: true });
    const settings = validateUpdateSettings({ channel: 'canary', automaticChecks: false }); await atomicJson(join(dir, 'settings.json'), settings);
    expect((await getUpdateSettings(dir)).automaticChecks).toBe(false); expect(() => validateUpdateSettings({ channel: 'beta', automaticChecks: true })).toThrow('Only Canary');
  });
});
describe('migration detection and durable journey', () => {
  test('cumulative recipes and unsupported historical/unknown schema', async () => {
    const { config } = await fixture(); expect((await inspectMigration(config, metadata('0.3.0', true))).steps).toHaveLength(1);
    for (const text of ['schemaVersion: 1', 'schemaVersion: 99', 'schemaVersion: unknown', 'bad: [']) { await writeFile(config, text); expect((await inspectMigration(config, metadata())).status).toBe('unsupported'); }
  });
  test('explicit combined authorization survives restart; completed migration never replays', async () => {
    const { dir, config } = await fixture(); const m = metadata('0.3.0', true);
    const old = new UpdateCoordinator({ directory: dir, listDashboards: async () => [config], currentVersion: '0.2.6', fetcher: fetcher(m) });
    await old.action({ type: 'prepare', choice: 'update-and-migrate', selected: [config] });
    let calls = 0;
    const next = () => new UpdateCoordinator({ directory: dir, currentVersion: '0.3.0', listDashboards: async () => [config], migrate: async () => { calls++; return { snapshot: '/snapshot', message: 'done' }; } });
    await next().reconcile(); await next().reconcile(); expect(calls).toBe(1); expect((await next().receipt())?.installation).toBe('installed');
  });
  test('no-migration update finishes without invoking an agent', async () => {
    const { dir, config } = await fixture(); await atomicJson(join(dir, 'receipt.json'), receipt(config, metadata()));
    const c = new UpdateCoordinator({ directory: dir, currentVersion: '0.3.0', listDashboards: async () => [config], migrate: async () => { throw new Error('should never run'); } });
    await c.reconcile(); expect((await c.state()).phase).toBe('finished'); expect((await c.receipt())?.migrations[config]?.status).toBe('finished');
  });
  test('update only defers migration until explicit selected retry', async () => {
    const { dir, config } = await fixture(); const r = receipt(config); r.choice = 'update-only'; await atomicJson(join(dir, 'receipt.json'), r); let calls = 0;
    const c = new UpdateCoordinator({ directory: dir, currentVersion: '0.3.0', listDashboards: async () => [config], migrate: async () => { calls++; return { snapshot: '/saved', message: 'done' }; } });
    await c.reconcile(); expect(calls).toBe(0); await c.action({ type: 'migrate', selected: [config] }); expect(calls).toBe(1);
  });
  test('cancellation prevents restart continuation', async () => {
    const { dir, config } = await fixture(); await atomicJson(join(dir, 'receipt.json'), receipt(config)); let calls = 0;
    const c = new UpdateCoordinator({ directory: dir, currentVersion: '0.3.0', listDashboards: async () => [config], migrate: async () => { calls++; throw new Error(); } });
    await c.action({ type: 'cancel' }); await c.reconcile(); expect(calls).toBe(0); expect((await c.state()).receipt?.cancelled).toBe(true);
  });
  test('interrupted work is not replayed and unavailable agents remain recoverable', async () => {
    const { dir, config } = await fixture(); const r = receipt(config); r.migrations[config]!.status = 'running'; await atomicJson(join(dir, 'receipt.json'), r);
    const c = new UpdateCoordinator({ directory: dir, currentVersion: '0.3.0', listDashboards: async () => [config] });
    await c.reconcile(); expect((await c.receipt())?.migrations[config]?.status).toBe('interrupted');
    await c.action({ type: 'migrate', selected: [config] }); expect((await c.receipt())?.migrations[config]?.message).toContain('unavailable');
    expect((await c.receipt())?.installation).toBe('installed');
  });
  test('multiple dashboards preserve separate success/failure and snapshots', async () => {
    const { dir, config } = await fixture(); const second = join(dir, 'second.yaml'); await writeFile(second, 'schemaVersion: 2');
    const r = receipt(config); r.selected.push(second); r.migrations[second] = { status: 'pending' }; await atomicJson(join(dir, 'receipt.json'), r);
    const c = new UpdateCoordinator({ directory: dir, currentVersion: '0.3.0', listDashboards: async () => [config, second], migrate: async (p, _r, _report, snapshotReady) => {
      await snapshotReady('/backup'); if (p === second) throw new Error('agent failed'); return { snapshot: '/backup', message: 'done' };
    } }); await c.reconcile(); const result = (await c.receipt())!;
    expect(result.installation).toBe('installed'); expect(result.migrations[config]?.status).toBe('finished'); expect(result.migrations[second]).toMatchObject({ status: 'failed', snapshot: '/backup' });
  });
  test('concurrent operations cannot both install', async () => {
    const { dir } = await fixture(); let releaseLock!: () => void;
    const entered = Promise.withResolvers<void>();
    const operation = withUpdateLock(dir, async () => { entered.resolve(); await new Promise<void>(resolve => { releaseLock = resolve; }); });
    await entered.promise; await expect(withUpdateLock(dir, async () => {})).rejects.toThrow('lock'); releaseLock(); await operation;
  });
  test('installation failures leave verified staging recoverable', async () => {
    const { dir, config } = await fixture(); const c = new UpdateCoordinator({ directory: dir, listDashboards: async () => [config], fetcher: fetcher(), install: async () => { throw new Error('installer unavailable'); } });
    await c.action({ type: 'prepare', choice: 'update-only', selected: [] }); await expect(c.action({ type: 'install' })).rejects.toThrow('installer unavailable');
    expect((await c.receipt())?.installation).toBe('ready');
  });
  test('invalid receipt and unselected dashboard never authorize edits', async () => {
    const { dir, config } = await fixture(); expect(() => parseReceipt({ ...receipt(config), choice: 'yes' })).toThrow();
    const c = new UpdateCoordinator({ directory: dir, listDashboards: async () => [], fetcher: fetcher() });
    await expect(c.action({ type: 'prepare', choice: 'update-and-migrate', selected: [config] })).rejects.toThrow('not available');
  });
});

test('renewed authorization cannot resurrect unselected cancelled dashboards', async () => {
  const { dir, config } = await fixture(); const other = join(dir, 'other.yaml'); await writeFile(other, 'schemaVersion: 2');
  const r = receipt(config); r.selected.push(other); r.migrations[other] = { status: 'pending' }; r.cancelled = true; r.installation = 'installed';
  await atomicJson(join(dir, 'receipt.json'), r); const calls: string[] = [];
  const create = () => new UpdateCoordinator({ directory: dir, currentVersion: '0.3.0', listDashboards: async () => [config, other], migrate: async p => { calls.push(p); return { snapshot: '/saved', message: 'done' }; } });
  await create().action({ type: 'migrate', selected: [config] }); await create().reconcile(); expect(calls).toEqual([config]);
});

test('native adapter serves only verified artifacts and restores its bucket before applying', async () => {
  const { applyVerifiedNativeUpdate } = await import('../../src/updates/native-updater');
  const { dir, config } = await fixture(); const m = metadata();
  const manifest = JSON.stringify({ schemaVersion: 1, identifier: 'dev.dash-bored.app', version: m.version, channel: 'canary', platform: 'macos', arch: 'arm64', hash: 'testhash', artifact: { file: m.archive.file } });
  m.updater.sha256 = sha(manifest);
  const local = { baseUrl: 'original', channel: 'canary', identifier: 'dev.dash-bored.app' };
  let applied = false;
  const native = {
    async getLocalInfo() { return local; },
    async checkForUpdate() { const response = await fetch(`${local.baseUrl}/canary-macos-arm64-update.json`); expect(await response.json()).toEqual(JSON.parse(manifest)); return { version: m.version, error: '' }; },
    async downloadUpdate() { expect(await (await fetch(`${local.baseUrl}/${m.archive.file}`)).text()).toBe('archive'); expect((await fetch(`${local.baseUrl}/unpublished`)).status).toBe(404); },
    updateInfo() { return { version: m.version, error: '', updateReady: true }; },
    async applyUpdate() { expect(local.baseUrl).toBe('original'); applied = true; },
  };
  const downloads = (async (url: unknown) => new Response(String(url).endsWith('.json') ? manifest : 'archive')) as typeof fetch;
  await applyVerifiedNativeUpdate(native, receipt(config, m), dir, downloads); expect(applied).toBe(true);
});
