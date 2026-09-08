import type { UpdateReceipt } from '../shared/updates';
import { downloadArtifact, hashFile } from './artifacts';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { APP_IDENTIFIER } from '../shared/app-metadata';

/** 2026-09-08: isolated ad-hoc signed 99.0.1 -> 99.0.2 native replacement,
 * relaunch and matching CLI passed. See docs/release-qa.md. No OS approval bypass. */
export const DIRECT_UNSIGNED_UPDATES_VERIFIED = true;
export interface NativeUpdater {
  getLocalInfo(): Promise<{ baseUrl: string; channel: string; identifier: string }>;
  checkForUpdate(): Promise<{ version: string; error: string }>;
  downloadUpdate(): Promise<void>;
  updateInfo(): { version: string; updateReady: boolean; error: string };
  getStatusHistory?(): { status: string; message: string }[];
  applyUpdate(): Promise<void>;
}

/** Native updater sees only a version-pinned local mirror of SHA-256-verified
 * GitHub artifacts. It retains its native staging, quit approval, swap, and
 * rollback implementation. The caller owns the cross-process operation lock. */
export async function applyVerifiedNativeUpdate(native: NativeUpdater, receipt: UpdateReceipt, directory: string, fetcher: typeof fetch = fetch, beforeApply?: () => void | Promise<void>): Promise<void> {
  const release = receipt.release;
  const staging = join(directory, receipt.id);
  const archive = await downloadArtifact(release, 'archive', staging, fetcher);
  const manifestPath = await downloadArtifact(release, 'updater', staging, fetcher);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const expected = release.metadata;
  if (manifest.schemaVersion !== 1 || manifest.identifier !== APP_IDENTIFIER || manifest.channel !== 'canary' || manifest.platform !== 'macos' || manifest.arch !== 'arm64' || manifest.version !== expected.version || manifest.artifact?.file !== expected.archive.file || typeof manifest.hash !== 'string' || !manifest.hash) throw new Error('Native update manifest does not match the selected release. Use the verified DMG.');
  if (await hashFile(archive) !== expected.archive.sha256) throw new Error('Native archive changed after staging.');
  const local = await native.getLocalInfo();
  if (local.identifier !== APP_IDENTIFIER || local.channel !== 'canary') throw new Error('Native updater is not running in the installed canary app.');
  const previousBase = local.baseUrl;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/canary-macos-arm64-update.json') return new Response(Bun.file(manifestPath));
    if (path === `/${expected.archive.file}`) return new Response(Bun.file(archive));
    return new Response('Not found', { status: 404 });
  } });
  try {
    // Electrobun 2.0.1 exposes its cached mutable LocalUpdateInfo object.
    // Scope the channel bucket override to this verified local preparation.
    local.baseUrl = `http://127.0.0.1:${server.port}`;
    const check = await native.checkForUpdate();
    if (check.error || check.version !== expected.version) throw new Error(check.error || 'Native updater selected a different version.');
    await native.downloadUpdate();
    const ready = native.updateInfo();
    if (ready.error || !ready.updateReady || ready.version !== expected.version) throw new Error(ready.error || 'Native updater did not prepare the selected release.');
  } finally { local.baseUrl = previousBase; await server.stop(true); }
  await beforeApply?.();
  await native.applyUpdate();
  const last = native.getStatusHistory?.().at(-1);
  if (last?.status === "idle" && last.message.includes("cancelled")) throw new Error(last.message);
  const result = native.updateInfo();
  if (result.error) throw new Error(result.error);
}
