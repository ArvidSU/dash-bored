import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import Ajv from 'ajv';
import { parseDocument } from 'yaml';
import {
  ANIMATION_SCHEMA,
  animationProblems,
  BUILTIN_ANIMATIONS,
  builtinAnimation,
  isAnimationReference,
  type AnimationCatalogItem,
  type AnimationManifest,
} from '../shared/animations';
import { childEdges } from '../shared/child-edges';
import type { ProjectSnapshot, ResolvedComponentNode } from '../shared/contracts';

const MAX_ANIMATION_BYTES = 32 * 1024;

/** Shared by the agent tool and every desktop channel, beside personal themes. */
export function personalAnimationsDirectory(): string { return join(homedir(), '.config', 'dash-bored', 'animations'); }

const validate = new Ajv({ allErrors: true, strict: false }).compile(ANIMATION_SCHEMA);

export function parseAnimation(source: string): AnimationManifest {
  if (Buffer.byteLength(source) > MAX_ANIMATION_BYTES) throw new Error('animation.yaml exceeds 32 KiB.');
  const doc = parseDocument(source, { uniqueKeys: true, strict: true });
  if (doc.errors.length || doc.warnings.length) throw new Error([...doc.errors, ...doc.warnings].map((e) => e.message).join('; '));
  const value: unknown = doc.toJS({ maxAliasCount: 0 });
  if (!validate(value)) throw new Error(`Invalid animation.yaml: ${new Ajv().errorsText(validate.errors)}`);
  const manifest = value as unknown as AnimationManifest;
  const problems = animationProblems(manifest);
  if (problems.length) throw new Error(`Invalid animation.yaml: ${problems.join(' ')}`);
  return manifest;
}

/** Read one package directory; `animation.yaml` must be a contained regular file. */
export async function readAnimation(directory: string): Promise<AnimationManifest> {
  const root = await realpath(directory);
  const file = await realpath(join(root, 'animation.yaml'));
  if (relative(root, file) !== 'animation.yaml') throw new Error('animation.yaml must be contained in its package.');
  const info = await stat(file);
  if (!info.isFile() || info.size > MAX_ANIMATION_BYTES) throw new Error('animation.yaml must be a regular file of at most 32 KiB.');
  return parseAnimation(await readFile(file, 'utf8'));
}

async function readContained(root: string, directory: string): Promise<AnimationManifest> {
  const [canonicalRoot, canonicalDirectory] = await Promise.all([realpath(root), realpath(directory)]);
  const rel = relative(canonicalRoot, canonicalDirectory);
  if (rel === '..' || rel.startsWith(`..${sep}`) || resolve(canonicalRoot, rel) !== canonicalDirectory) {
    throw new Error('Animation directory escapes its installation root.');
  }
  return readAnimation(canonicalDirectory);
}

async function scanAnimations(catalog: AnimationCatalogItem[], root: string, directory: string, prefix: string): Promise<void> {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    catalog.push({ reference: prefix, name: prefix, error: String(error) });
    return;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(entry.name) || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
    const reference = `${prefix}${entry.name}`;
    try {
      const manifest = await readContained(root, join(directory, entry.name));
      catalog.push({ reference, name: manifest.name, manifest });
    } catch (error) {
      catalog.push({ reference, name: reference, error: error instanceof Error ? error.message : String(error) });
    }
  }
}

/** Built-ins, personal `global:` packages, and the bundle's `./animations/<name>` packages. */
export async function loadAnimationCatalog(
  configDirectory?: string,
  globalDirectory = personalAnimationsDirectory(),
): Promise<AnimationCatalogItem[]> {
  const catalog: AnimationCatalogItem[] = [...BUILTIN_ANIMATIONS];
  await scanAnimations(catalog, globalDirectory, globalDirectory, 'global:');
  if (configDirectory) await scanAnimations(catalog, configDirectory, join(configDirectory, 'animations'), './animations/');
  return catalog;
}

/**
 * Resolve one reference from disk, so an animation an agent just wrote plays
 * without waiting for a reload. `./animations/` resolves in `configDirectory`.
 */
export async function resolveAnimation(
  reference: string,
  configDirectory: string | undefined,
  globalDirectory = personalAnimationsDirectory(),
): Promise<AnimationManifest> {
  if (!isAnimationReference(reference)) {
    throw new Error(`${reference} is not an animation reference; use builtin:<id>, global:<name>, or ./animations/<name>.`);
  }
  const builtin = builtinAnimation(reference);
  if (builtin) return builtin;
  if (reference.startsWith('builtin:')) {
    throw new Error(`${reference} is not a built-in animation; built-ins are ${BUILTIN_ANIMATIONS.map((item) => item.reference).join(', ')}.`);
  }
  const [root, name] = reference.startsWith('global:')
    ? [globalDirectory, reference.slice('global:'.length)]
    : [configDirectory === undefined ? undefined : join(configDirectory, 'animations'), reference.slice('./animations/'.length)];
  if (root === undefined) throw new Error(`${reference} needs an open dashboard bundle.`);
  try {
    return await readContained(root, join(root, name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`${reference}: animation not found.`);
    throw new Error(`${reference}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Bundles an attention request may resolve `./animations/` in: the open dashboard and the bundles it links. */
export function snapshotConfigPaths(snapshot: Pick<ProjectSnapshot, 'configPath' | 'tree'>): Set<string> {
  const paths = new Set<string>();
  if (snapshot.configPath) paths.add(snapshot.configPath);
  const visit = (node: ResolvedComponentNode): void => {
    if (node.sourceConfigPath) paths.add(node.sourceConfigPath);
    for (const edge of childEdges(node.children)) visit(edge.node);
  };
  if (snapshot.tree) visit(snapshot.tree);
  return paths;
}
