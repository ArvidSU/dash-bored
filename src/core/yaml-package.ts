import { mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import Ajv, { type ValidateFunction } from 'ajv';
import { parseDocument } from 'yaml';

/** One-file YAML packages (themes, animations): `<directory>/<file>`, size-capped and schema-checked. */
export interface YamlPackageKind {
  /** Package file name, such as `theme.yaml`. */
  file: string;
  maxBytes: number;
  validate: ValidateFunction;
}

export function parsePackageYaml(kind: YamlPackageKind, source: string): unknown {
  if (Buffer.byteLength(source) > kind.maxBytes) throw new Error(`${kind.file} exceeds ${kind.maxBytes / 1024} KiB.`);
  const doc = parseDocument(source, { uniqueKeys: true, strict: true });
  if (doc.errors.length || doc.warnings.length) throw new Error([...doc.errors, ...doc.warnings].map((e) => e.message).join('; '));
  const value: unknown = doc.toJS({ maxAliasCount: 0 });
  if (!kind.validate(value)) throw new Error(`Invalid ${kind.file}: ${new Ajv().errorsText(kind.validate.errors)}`);
  return value;
}

/** The package file's contents; it must be a regular file contained in canonical `root`. */
export async function readPackageFile(kind: YamlPackageKind, root: string): Promise<string> {
  const file = await realpath(join(root, kind.file));
  if (relative(root, file) !== kind.file) throw new Error(`${kind.file} must be contained in its package.`);
  const info = await stat(file);
  if (!info.isFile() || info.size > kind.maxBytes) throw new Error(`${kind.file} must be a regular file of at most ${kind.maxBytes / 1024} KiB.`);
  return readFile(file, 'utf8');
}

/** Canonical `directory`, which must stay inside `root` after resolving links. */
export async function containedPackageDirectory(root: string, directory: string, label: string): Promise<string> {
  const [rootResult, directoryResult] = await Promise.allSettled([realpath(root), realpath(directory)]);
  // Report the root first when both independent paths fail.
  if (rootResult.status === 'rejected') throw rootResult.reason;
  if (directoryResult.status === 'rejected') throw directoryResult.reason;
  const canonicalRoot = rootResult.value;
  const canonicalDirectory = directoryResult.value;
  const rel = relative(canonicalRoot, canonicalDirectory);
  if (rel === '..' || rel.startsWith(`..${sep}`) || resolve(canonicalRoot, rel) !== canonicalDirectory) {
    throw new Error(`${label} directory escapes its installation root.`);
  }
  return canonicalDirectory;
}

/**
 * Create `<root>/<name>/<file>` with `contents`, refusing to overwrite and to
 * leave `boundary` (the bundle or personal directory) through a linked `root`.
 */
export async function createPackage(boundary: string, root: string, name: string, label: string, file: string, contents: string): Promise<string> {
  await mkdir(root, { recursive: true });
  const rel = relative(await realpath(boundary), await realpath(root));
  if (rel === '..' || rel.startsWith(`..${sep}`)) throw new Error(`${label} directory escapes its dashboard bundle.`);
  const directory = join(root, name);
  await mkdir(directory);
  await writeFile(join(directory, file), contents, { flag: 'wx' });
  return directory;
}

/**
 * Visit package-named entries of `directory` in name order. A missing
 * directory has none; an unreadable one is reported as a catalog error.
 */
export async function scanPackageDirectory(
  catalog: { reference: string; name: string; error?: string }[],
  directory: string,
  prefix: string,
  visit: (name: string) => Promise<void>,
): Promise<void> {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    catalog.push({ reference: prefix, name: prefix, error: String(error) });
    return;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(entry.name) || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
    await visit(entry.name);
  }
}
