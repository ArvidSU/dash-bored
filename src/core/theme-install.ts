import { readdir, rename, rm, lstat, realpath } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import {
  git,
  hasLocalChanges,
  installPackage,
  readPackageStore,
  removeSubmodule,
  resolveRemoteCommit,
  restoreClone,
  submoduleLocation,
  packageWorkPath,
  withPackageStore,
  writePackageLock,
  type PackageStore,
  type PackageStrategy,
} from './package-store';
import { resolveProjectLocation } from './paths';
import { parseTheme, personalThemesDirectory, readTheme } from './themes';

/**
 * Theme packages: submodules below a bundle's `themes/external/` (project
 * scope) or clones in the personal themes directory (global scope), pinned in
 * the `themes` lock section. Git, lock I/O, the operation guard, and staged
 * installs come from the package store; every checkout is validated as a theme.
 */

async function resolveThemeCommit(url: string, ref?: string): Promise<string> {
  if (!url || url.startsWith('-')) throw new Error('Invalid theme repository URL.');
  // A full object ID may be in remote history without being an advertised ref.
  // The staged checkout/fetch below verifies that it actually exists.
  return ref && /^[0-9a-fA-F]{40}$/.test(ref) ? ref.toLowerCase() : resolveRemoteCommit(url, ref);
}
export interface ThemeInstallTarget { project?: string; global?: boolean; globalDirectory?: string }
export function themeName(name: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) throw new Error('Theme names start with a letter and contain letters, numbers, underscores or hyphens.');
  return name;
}
async function storeRoot(target: ThemeInstallTarget): Promise<{ root: string; strategy: PackageStrategy }> {
  return target.global === true
    ? { root: target.globalDirectory ?? personalThemesDirectory(), strategy: 'clone' }
    : { root: (await resolveProjectLocation(target.project ?? '.')).configDirectory, strategy: 'submodule' };
}
async function withThemeStore<T>(target: ThemeInstallTarget, operation: (store: PackageStore) => Promise<T>): Promise<T> {
  const { root, strategy } = await storeRoot(target);
  return withPackageStore(root, strategy, operation);
}
async function exists(path: string): Promise<boolean> { try { await lstat(path); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; } }
async function writePins(store: PackageStore, themes: NonNullable<PackageStore['lock']['themes']>): Promise<void> {
  await writePackageLock(store, { ...store.lock, themes });
}
async function checkoutPath(store: PackageStore, name: string): Promise<string> {
  const path = join(store.root, store.strategy === 'clone' ? '' : 'themes/external', themeName(name));
  // Check existing parents as well as the target; never follow a symlink outside the store.
  let ancestor = path;
  while (!await exists(ancestor)) ancestor = dirname(ancestor);
  const rel = relative(await realpath(store.root), await realpath(ancestor));
  if (rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('Theme checkout escapes its installation root.');
  if (await exists(path) && (await lstat(path)).isSymbolicLink()) throw new Error('Managed theme checkouts cannot be symlinks.');
  return path;
}
async function cleanCheckout(path: string): Promise<void> {
  if (await hasLocalChanges(path)) throw new Error(`Theme has local changes: ${path}. Commit or save them before updating, syncing, or removing it.`);
}
export async function addTheme(target: ThemeInstallTarget, url: string, options: { name?: string; ref?: string } = {}) {
  if (!url || url.startsWith('-')) throw new Error('A git repository URL is required.');
  const name = themeName(options.name ?? url.replace(/\/+$/, '').split('/').pop()!.replace(/\.git$/, ''));
  return withThemeStore(target, async (store) => {
    const path = await checkoutPath(store, name);
    if (store.lock.themes?.[name] || await exists(path)) throw new Error(`Theme ${name} already exists.`);
    const commit = await resolveThemeCommit(url, options.ref);
    // Validate the exact revision before touching the project submodule/index.
    await installPackage(store, {
      url,
      commit,
      checkout: path,
      validate: readTheme,
      commitLock: () => writePins(store, { ...store.lock.themes, [name]: { url, commit, path: `themes/external/${name}` } }),
    });
    return { name, commit };
  });
}
export async function statusThemes(target: ThemeInstallTarget) {
  const { root, strategy } = await storeRoot(target);
  const store = await readPackageStore(root, strategy);
  return Promise.all(Object.entries(store.lock.themes ?? {}).map(async ([name, entry]) => {
    const path = await checkoutPath(store, name);
    let commit: string | null = null;
    let dirty = false;
    if (await exists(join(path, '.git'))) {
      commit = await git(path, ['rev-parse', 'HEAD']);
      dirty = await hasLocalChanges(path);
    }
    return { name, ...entry, checkedOutCommit: commit, initialized: commit !== null, dirty, inSync: commit === entry.commit };
  }));
}
export async function updateTheme(target: ThemeInstallTarget, name: string, ref?: string) {
  themeName(name);
  return withThemeStore(target, async (store) => {
    const entry = store.lock.themes?.[name];
    if (!entry) throw new Error(`Theme ${name} is not installed.`);
    const path = await checkoutPath(store, name);
    if (!await exists(join(path, '.git'))) throw new Error('Theme checkout is uninitialized; run theme sync first.');
    await cleanCheckout(path);
    const previous = await git(path, ['rev-parse', 'HEAD']);
    const commit = await resolveThemeCommit(entry.url, ref);
    await git(path, ['fetch', 'origin']);
    parseTheme(await git(path, ['show', `${commit}:theme.yaml`]));
    try {
      await git(path, ['checkout', '--detach', commit]);
      await readTheme(path);
      await writePins(store, { ...store.lock.themes, [name]: { ...entry, commit } });
    } catch (error) { await git(path, ['checkout', '--detach', previous]); throw error; }
    return { name, commit, changed: previous !== commit };
  });
}
export async function syncThemes(target: ThemeInstallTarget) {
  return withThemeStore(target, async (store) => {
    const global = store.strategy === 'clone';
    for (const [name, entry] of Object.entries(store.lock.themes ?? {})) {
      const path = await checkoutPath(store, name);
      const initialized = await exists(join(path, '.git'));
      if (initialized) await cleanCheckout(path);
      else if (global && await exists(path)) throw new Error(`Unmanaged directory at ${path}; refusing to overwrite it.`);
      if (global) {
        if (!await exists(path)) {
          await restoreClone(store, entry.url, entry.commit, path, readTheme);
          continue;
        }
        await git(path, ['fetch', 'origin']);
      } else {
        const { repo, gitPath } = await submoduleLocation(store, path);
        if (!initialized) await git(repo, ['submodule', 'update', '--init', '--', gitPath]);
        await git(path, ['fetch', 'origin']);
      }
      const previous = await git(path, ['rev-parse', 'HEAD']);
      try { await git(path, ['checkout', '--detach', entry.commit]); await readTheme(path); }
      catch (error) { await git(path, ['checkout', '--detach', previous]); throw error; }
    }
    return Object.keys(store.lock.themes ?? {});
  });
}
export async function removeTheme(target: ThemeInstallTarget, name: string) {
  themeName(name);
  return withThemeStore(target, async (store) => {
    if (!store.lock.themes?.[name]) throw new Error(`Theme ${name} is not installed.`);
    const path = await checkoutPath(store, name);
    if (await exists(join(path, '.git'))) await cleanCheckout(path);
    else if (await exists(path) && (await readdir(path)).length) throw new Error(`Unmanaged files at ${path}; refusing to remove them.`);
    const { [name]: removed, ...remaining } = store.lock.themes;
    if (store.strategy === 'clone') {
      const stage = packageWorkPath(store, 'remove');
      const present = await exists(path);
      if (present) await rename(path, stage);
      try { await writePins(store, remaining); } catch (error) { if (present) await rename(stage, path); throw error; }
      await rm(stage, { recursive: true, force: true });
    } else {
      await removeSubmodule(store, path);
      await writePins(store, remaining);
    }
    return { name };
  });
}
