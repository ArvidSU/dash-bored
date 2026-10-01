import { validateDashboardLockValue } from './yaml';
import type { DashboardLock } from '../shared/contracts';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import Ajv from 'ajv';
import { parseDocument } from 'yaml';
import { BUILTIN_THEME, projectThemeReference, THEME_SCHEMA, type ThemeCatalogItem, type ThemeManifest } from '../shared/themes';

/** Shared by the agent tool and every desktop channel; independent of Electrobun's instance ID. */
export function personalThemesDirectory(): string { return join(homedir(), '.config', 'dash-bored', 'themes'); }
export interface ApplicationThemeSource {
  configPath: string;
  configDirectory: string;
  label?: string | null;
}
const validate = new Ajv({ allErrors: true, strict: false }).compile(THEME_SCHEMA);
export function parseTheme(source: string): ThemeManifest {
  if (Buffer.byteLength(source) > 64 * 1024) throw new Error('theme.yaml exceeds 64 KiB.');
  const doc = parseDocument(source, { uniqueKeys: true, strict: true });
  if (doc.errors.length || doc.warnings.length) throw new Error([...doc.errors, ...doc.warnings].map((e) => e.message).join('; '));
  const value: unknown = doc.toJS({ maxAliasCount: 0 });
  if (!validate(value)) throw new Error(`Invalid theme.yaml: ${new Ajv().errorsText(validate.errors)}`);
  return value as unknown as ThemeManifest;
}
export function parseThemeLock(source: string, file: string): { value: DashboardLock | null; diagnostics: string[]; invalidYaml: boolean } {
  const doc = parseDocument(source, { uniqueKeys: true });
  if (doc.errors.length || doc.warnings.length) return { value: null, diagnostics: [], invalidYaml: true };
  const value = doc.toJS({ maxAliasCount: 0 }) as DashboardLock;
  const diagnostics = validateDashboardLockValue(value, file).map((entry) => entry.message);
  return diagnostics.length ? { value: null, diagnostics, invalidYaml: false } : { value, diagnostics: [], invalidYaml: false };
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
async function scanThemes(catalog: ThemeCatalogItem[], root: string, directory: string, prefix: string): Promise<void> {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; catalog.push({ reference: prefix, name: prefix, error: String(error) }); return; }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(entry.name) || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
    if (entry.name === 'external' && prefix === './themes/') { await scanThemes(catalog, root, join(directory, entry.name), './themes/external/'); continue; }
    catalog.push(await itemAt(root, join(directory, entry.name), `${prefix}${entry.name}`));
  }
}

// Read catalog pins and personal pins through one parser. Callers retain their
// distinct user-facing error wrappers around its diagnostics.
async function attachPins(catalog: ThemeCatalogItem[], root: string, filename: string, prefix: string): Promise<void> {
  let parsed: ReturnType<typeof parseThemeLock>;
  try { parsed = parseThemeLock(await readFile(join(root, filename), 'utf8'), filename); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    catalog.push({ reference: prefix, name: 'Theme pins unavailable', error: String(error) });
    return;
  }
  if (!parsed.value) {
    const message = parsed.invalidYaml ? 'Invalid theme lock file.' : parsed.diagnostics.join('; ');
    catalog.push({ reference: prefix, name: 'Theme pins unavailable', error: `Error: ${message}` });
    return;
  }
  for (const [name, pin] of Object.entries(parsed.value.themes ?? {})) {
    const reference = `${prefix}${name}`;
    let item = catalog.find((candidate) => candidate.reference === reference);
    if (!item) { item = { reference, name, error: 'Theme checkout is missing. Run theme sync to restore the pinned revision.' }; catalog.push(item); }
    item.git = { name, url: pin.url, commit: pin.commit };
  }
}

async function loadProjectThemeCatalog(configDirectory: string): Promise<ThemeCatalogItem[]> {
  const catalog: ThemeCatalogItem[] = [];
  await scanThemes(catalog, configDirectory, join(configDirectory, 'themes'), './themes/');
  await attachPins(catalog, configDirectory, 'dash-bored-lock.yaml', './themes/external/');
  return catalog;
}

export async function loadThemeCatalog(configDirectory?: string, globalDirectory = personalThemesDirectory()): Promise<ThemeCatalogItem[]> {
  const catalog: ThemeCatalogItem[] = [BUILTIN_THEME];
  await scanThemes(catalog, globalDirectory, globalDirectory, 'global:');
  if (configDirectory) await scanThemes(catalog, configDirectory, join(configDirectory, 'themes'), './themes/');
  await attachPins(catalog, globalDirectory, 'pins.yaml', 'global:');
  if (configDirectory) await attachPins(catalog, configDirectory, 'dash-bored-lock.yaml', './themes/external/');
  return catalog;
}

/**
 * Build the app-level catalog without borrowing the currently selected
 * dashboard. Project-local packages receive a stable, qualified reference so
 * their manifests remain usable after dashboard navigation.
 */
export async function loadApplicationThemeCatalog(
  sources: readonly ApplicationThemeSource[],
  globalDirectory = personalThemesDirectory(),
): Promise<ThemeCatalogItem[]> {
  const catalog = await loadThemeCatalog(undefined, globalDirectory);
  const seen = new Set(catalog.map((item) => item.reference));
  for (const source of sources) {
    const localCatalog = await loadProjectThemeCatalog(source.configDirectory);
    for (const item of localCatalog.filter((candidate) => /^\.\/themes(?:\/external)?\/[A-Za-z][A-Za-z0-9_-]*$/.test(candidate.reference))) {
      const reference = projectThemeReference(source.configPath, item.reference);
      if (seen.has(reference)) continue;
      seen.add(reference);
      catalog.push({
        ...item,
        reference,
        displayReference: `${source.label?.trim() || source.configPath} · ${item.reference}`,
      });
    }
  }
  return catalog;
}
