import { validateDashboardLockValue } from './yaml';
import type { DashboardLock } from '../shared/contracts';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import Ajv from 'ajv';
import { parseDocument } from 'yaml';
import { BUILTIN_THEME, THEME_SCHEMA, type ThemeCatalogItem, type ThemeManifest } from '../shared/themes';

/** Shared by the bundled CLI and every desktop channel; independent of Electrobun's instance ID. */
export function personalThemesDirectory(): string { return join(homedir(), '.config', 'dash-bored', 'themes'); }
const validate = new Ajv({ allErrors: true, strict: false }).compile(THEME_SCHEMA);
export function parseTheme(source: string): ThemeManifest {
  if (Buffer.byteLength(source) > 64 * 1024) throw new Error('theme.yaml exceeds 64 KiB.');
  const doc = parseDocument(source, { uniqueKeys: true, strict: true });
  if (doc.errors.length || doc.warnings.length) throw new Error([...doc.errors, ...doc.warnings].map((e) => e.message).join('; '));
  const value: unknown = doc.toJS({ maxAliasCount: 0 });
  if (!validate(value)) throw new Error(`Invalid theme.yaml: ${new Ajv().errorsText(validate.errors)}`);
  return value as unknown as ThemeManifest;
}
export async function readTheme(directory: string): Promise<ThemeManifest> {
  const root = await realpath(directory);
  const file = await realpath(join(directory, 'theme.yaml'));
  if (relative(root, file) !== 'theme.yaml') throw new Error('theme.yaml must be contained in its package.');
  const info = await stat(file);
  if (!info.isFile() || info.size > 64 * 1024) throw new Error('theme.yaml must be a regular file of at most 64 KiB.');
  return parseTheme(await readFile(file, 'utf8'));
}
async function itemAt(root: string, directory: string, reference: string): Promise<ThemeCatalogItem> {
  try {
    const rel = relative(await realpath(root), await realpath(directory));
    if (rel === '..' || rel.startsWith(`..${sep}`) || resolve(await realpath(root), rel) !== await realpath(directory)) throw new Error('Theme directory escapes its installation root.');
    const manifest = await readTheme(directory);
    return { reference, name: manifest.name, manifest };
  } catch (error) { return { reference, name: reference, error: error instanceof Error ? error.message : String(error) }; }
}
export async function loadThemeCatalog(configDirectory?: string, globalDirectory = personalThemesDirectory()): Promise<ThemeCatalogItem[]> {
  const catalog: ThemeCatalogItem[] = [BUILTIN_THEME];
  async function scan(root: string, directory: string, prefix: string): Promise<void> {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; catalog.push({ reference: prefix, name: prefix, error: String(error) }); return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(entry.name) || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
      if (entry.name === 'external' && prefix === './themes/') { await scan(root, join(directory, entry.name), './themes/external/'); continue; }
      catalog.push(await itemAt(root, join(directory, entry.name), `${prefix}${entry.name}`));
    }
  }
  await scan(globalDirectory, globalDirectory, 'global:');
  if (configDirectory) await scan(configDirectory, join(configDirectory, 'themes'), './themes/');
  // Include pins even when their checkout is missing, so the UI can offer sync.
  async function attachPins(root: string, filename: string, prefix: string) {
    try {
      const doc = parseDocument(await readFile(join(root, filename), 'utf8'), { uniqueKeys: true });
      if (doc.errors.length || doc.warnings.length) throw new Error('Invalid theme lock file.');
      const lock = doc.toJS({ maxAliasCount: 0 }) as DashboardLock;
      const errors = validateDashboardLockValue(lock, filename);
      if (errors.length) throw new Error(errors.map((error) => error.message).join('; '));
      for (const [name, pin] of Object.entries(lock.themes ?? {})) {
        const reference = `${prefix}${name}`;
        let item = catalog.find((candidate) => candidate.reference === reference);
        if (!item) { item = { reference, name, error: 'Theme checkout is missing. Run theme sync to restore the pinned revision.' }; catalog.push(item); }
        item.git = { name, url: pin.url, commit: pin.commit };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') catalog.push({ reference: prefix, name: 'Theme pins unavailable', error: String(error) });
    }
  }
  await attachPins(globalDirectory, 'pins.yaml', 'global:');
  if (configDirectory) await attachPins(configDirectory, 'dash-bored-lock.yaml', './themes/external/');
  return catalog;
}
