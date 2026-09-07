import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, lstat, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { parseDocument } from 'yaml';
import type { DashboardLock } from '../shared/contracts';
import { parseDashboardLock, serializeDashboardLock, validateDashboardLockValue } from './yaml';
import { resolveProjectLocation } from './paths';
import { resolveRemoteCommit } from './external-components';
import { parseTheme, personalThemesDirectory, readTheme } from './themes';

const exec = promisify(execFile);
export async function themeGit(cwd: string, args: string[]): Promise<string> {
  const result = await exec('git', ['-c', 'protocol.file.allow=always', ...args], { cwd, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  return result.stdout.trim();
}
async function resolveThemeCommit(url: string, ref?: string): Promise<string> {
  if (!url || url.startsWith('-')) throw new Error('Invalid theme repository URL.');
  // A full object ID may be in remote history without being an advertised ref.
  // The staged checkout/fetch below verifies that it actually exists.
  return ref && /^[0-9a-fA-F]{40}$/.test(ref) ? ref.toLowerCase() : resolveRemoteCommit(url, ref);
}
async function removeDetachedObjects(repo: string, gitPath: string): Promise<void> {
  const common = await realpath(resolve(repo, await themeGit(repo, ['rev-parse', '--git-common-dir'])));
  const objectStore = resolve(repo, await themeGit(repo, ['rev-parse', '--git-path', `modules/${gitPath}`]));
  const rel = relative(common, objectStore);
  if (!rel.startsWith(`modules${sep}`) || rel.split(sep).includes('..')) throw new Error('Unexpected submodule object directory.');
  await rm(objectStore, { recursive: true, force: true });
}
export interface ThemeInstallTarget { project?: string; global?: boolean; globalDirectory?: string }
interface Store { root: string; lockPath: string; global: boolean; lock: DashboardLock }
export function themeName(name: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) throw new Error('Theme names start with a letter and contain letters, numbers, underscores or hyphens.');
  return name;
}
async function storeFor(target: ThemeInstallTarget): Promise<Store> {
  const global = target.global === true;
  const root = global ? target.globalDirectory ?? personalThemesDirectory() : (await resolveProjectLocation(target.project ?? '.')).configDirectory;
  const lockPath = join(root, global ? 'pins.yaml' : 'dash-bored-lock.yaml');
  let lock: DashboardLock;
  if (global) {
    try {
      const doc = parseDocument(await readFile(lockPath, 'utf8'), { uniqueKeys: true });
      if (doc.errors.length || doc.warnings.length) throw new Error('Invalid personal theme pins.yaml.');
      lock = doc.toJS({ maxAliasCount: 0 }) as DashboardLock;
      const errors = validateDashboardLockValue(lock, lockPath);
      if (errors.length) throw new Error(errors.map((e) => e.message).join('; '));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      lock = { lockfileVersion: 1, components: {}, themes: {} };
    }
  } else {
    const parsed = await parseDashboardLock(lockPath);
    if (!parsed.value) throw new Error(parsed.diagnostics.map((e) => e.message).join('; '));
    lock = parsed.value;
  }
  return { root, lockPath, global, lock };
}
async function exists(path: string): Promise<boolean> { try { await lstat(path); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; } }
async function writePins(store: Store, themes: NonNullable<DashboardLock['themes']>): Promise<void> {
  const temporary = `${store.lockPath}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, serializeDashboardLock({ ...store.lock, themes }), { mode: 0o600 }); await rename(temporary, store.lockPath); }
  finally { await rm(temporary, { force: true }); }
}
async function checkoutPath(store: Store, name: string): Promise<string> {
  const path = join(store.root, store.global ? '' : 'themes/external', themeName(name));
  // Check existing parents as well as the target; never follow a symlink outside the store.
  let ancestor = path;
  while (!await exists(ancestor)) ancestor = dirname(ancestor);
  const rel = relative(await realpath(store.root), await realpath(ancestor));
  if (rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('Theme checkout escapes its installation root.');
  if (await exists(path) && (await lstat(path)).isSymbolicLink()) throw new Error('Managed theme checkouts cannot be symlinks.');
  return path;
}
async function cleanCheckout(path: string): Promise<void> {
  if (await themeGit(path, ['status', '--porcelain'])) throw new Error(`Theme has local changes: ${path}. Commit or save them before updating, syncing, or removing it.`);
}
async function withStore<T>(target: ThemeInstallTarget, operation: (store: Store) => Promise<T>): Promise<T> {
  const first = await storeFor(target);
  await mkdir(first.root, { recursive: true });
  const guard = join(first.root, '.theme-operation.lock');
  try { await mkdir(guard); } catch { throw new Error(`Another theme operation is active (${guard}). If interrupted, remove this empty lock directory before retrying.`); }
  try { return await operation(await storeFor(target)); } finally { await rm(guard, { recursive: true, force: true }); }
}
async function repoInfo(store: Store, path: string) {
  const repo = await themeGit(store.root, ['rev-parse', '--show-toplevel']);
  return { repo, gitPath: relative(repo, path).split(sep).join('/') };
}
export async function addTheme(target: ThemeInstallTarget, url: string, options: { name?: string; ref?: string } = {}) {
  if (!url || url.startsWith('-')) throw new Error('A git repository URL is required.');
  const name = themeName(options.name ?? url.replace(/\/+$/, '').split('/').pop()!.replace(/\.git$/, ''));
  return withStore(target, async (store) => {
    const path = await checkoutPath(store, name);
    if (store.lock.themes?.[name] || await exists(path)) throw new Error(`Theme ${name} already exists.`);
    const commit = await resolveThemeCommit(url, options.ref);
    const stage = join(store.root, `.theme-stage-${randomUUID()}`);
    let installed = false;
    try {
      // Validate the exact revision before touching the project submodule/index.
      await themeGit(store.root, ['clone', '--no-checkout', '--', url, stage]);
      await themeGit(stage, ['checkout', '--detach', commit]);
      await readTheme(stage);
      if (store.global) { await rename(stage, path); installed = true; }
      else {
        const { repo, gitPath } = await repoInfo(store, path);
        await themeGit(repo, ['submodule', 'add', '--', url, gitPath]);
        installed = true;
        await themeGit(path, ['checkout', '--detach', commit]);
      }
      await writePins(store, { ...store.lock.themes, [name]: { url, commit, path: `themes/external/${name}` } });
      return { name, commit };
    } catch (error) {
      if (installed) {
        if (store.global) await rm(path, { recursive: true, force: true });
        else {
          const { repo, gitPath } = await repoInfo(store, path);
          await themeGit(repo, ['submodule', 'deinit', '-f', '--', gitPath]);
          await themeGit(repo, ['rm', '-f', '--', gitPath]);
          await removeDetachedObjects(repo, gitPath);
        }
      }
      throw error;
    } finally { await rm(stage, { recursive: true, force: true }); }
  });
}
export async function statusThemes(target: ThemeInstallTarget) {
  const store = await storeFor(target);
  return Promise.all(Object.entries(store.lock.themes ?? {}).map(async ([name, entry]) => {
    const path = await checkoutPath(store, name);
    let commit: string | null = null;
    let dirty = false;
    if (await exists(join(path, '.git'))) {
      commit = await themeGit(path, ['rev-parse', 'HEAD']);
      dirty = Boolean(await themeGit(path, ['status', '--porcelain']));
    }
    return { name, ...entry, checkedOutCommit: commit, initialized: commit !== null, dirty, inSync: commit === entry.commit };
  }));
}
export async function updateTheme(target: ThemeInstallTarget, name: string, ref?: string) {
  themeName(name);
  return withStore(target, async (store) => {
    const entry = store.lock.themes?.[name];
    if (!entry) throw new Error(`Theme ${name} is not installed.`);
    const path = await checkoutPath(store, name);
    if (!await exists(join(path, '.git'))) throw new Error('Theme checkout is uninitialized; run theme sync first.');
    await cleanCheckout(path);
    const previous = await themeGit(path, ['rev-parse', 'HEAD']);
    const commit = await resolveThemeCommit(entry.url, ref);
    await themeGit(path, ['fetch', 'origin']);
    parseTheme(await themeGit(path, ['show', `${commit}:theme.yaml`]));
    try {
      await themeGit(path, ['checkout', '--detach', commit]);
      await readTheme(path);
      await writePins(store, { ...store.lock.themes, [name]: { ...entry, commit } });
    } catch (error) { await themeGit(path, ['checkout', '--detach', previous]); throw error; }
    return { name, commit, changed: previous !== commit };
  });
}
export async function syncThemes(target: ThemeInstallTarget) {
  return withStore(target, async (store) => {
    for (const [name, entry] of Object.entries(store.lock.themes ?? {})) {
      const path = await checkoutPath(store, name);
      const initialized = await exists(join(path, '.git'));
      if (initialized) await cleanCheckout(path);
      else if (store.global && await exists(path)) throw new Error(`Unmanaged directory at ${path}; refusing to overwrite it.`);
      if (store.global) {
        if (!await exists(path)) {
          const stage = join(store.root, `.theme-stage-${randomUUID()}`);
          try {
            await themeGit(store.root, ['clone', '--no-checkout', '--', entry.url, stage]);
            await themeGit(stage, ['checkout', '--detach', entry.commit]);
            await readTheme(stage);
            await rename(stage, path);
          } finally { await rm(stage, { recursive: true, force: true }); }
          continue;
        }
        await themeGit(path, ['fetch', 'origin']);
      } else {
        const { repo, gitPath } = await repoInfo(store, path);
        if (!initialized) await themeGit(repo, ['submodule', 'update', '--init', '--', gitPath]);
        await themeGit(path, ['fetch', 'origin']);
      }
      const previous = await themeGit(path, ['rev-parse', 'HEAD']);
      try { await themeGit(path, ['checkout', '--detach', entry.commit]); await readTheme(path); }
      catch (error) { await themeGit(path, ['checkout', '--detach', previous]); throw error; }
    }
    return Object.keys(store.lock.themes ?? {});
  });
}
export async function removeTheme(target: ThemeInstallTarget, name: string) {
  themeName(name);
  return withStore(target, async (store) => {
    if (!store.lock.themes?.[name]) throw new Error(`Theme ${name} is not installed.`);
    const path = await checkoutPath(store, name);
    if (await exists(join(path, '.git'))) await cleanCheckout(path);
    else if (await exists(path) && (await readdir(path)).length) throw new Error(`Unmanaged files at ${path}; refusing to remove them.`);
    const { [name]: removed, ...remaining } = store.lock.themes;
    if (store.global) {
      const stage = join(store.root, `.theme-remove-${randomUUID()}`);
      const present = await exists(path);
      if (present) await rename(path, stage);
      try { await writePins(store, remaining); } catch (error) { if (present) await rename(stage, path); throw error; }
      await rm(stage, { recursive: true, force: true });
    } else {
      const { repo, gitPath } = await repoInfo(store, path);
      await themeGit(repo, ['submodule', 'deinit', '--', gitPath]);
      await themeGit(repo, ['rm', '--', gitPath]);
      await writePins(store, remaining);
      await removeDetachedObjects(repo, gitPath);
    }
    return { name };
  });
}
