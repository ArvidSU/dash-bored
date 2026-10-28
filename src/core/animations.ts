import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import Ajv from 'ajv';
import { containedPackageDirectory, parsePackageYaml, readPackageFile, scanPackageDirectory, type YamlPackageKind } from './yaml-package';
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

/** Shared by the agent tool and every desktop channel, beside personal themes. */
export function personalAnimationsDirectory(): string { return join(homedir(), '.config', 'dash-bored', 'animations'); }

const ANIMATION_PACKAGE: YamlPackageKind = { file: 'animation.yaml', maxBytes: 32 * 1024, validate: new Ajv({ allErrors: true, strict: false }).compile(ANIMATION_SCHEMA) };

export function parseAnimation(source: string): AnimationManifest {
  const manifest = parsePackageYaml(ANIMATION_PACKAGE, source) as AnimationManifest;
  const problems = animationProblems(manifest);
  if (problems.length) throw new Error(`Invalid animation.yaml: ${problems.join(' ')}`);
  return manifest;
}

/** Read one package directory; `animation.yaml` must be a contained regular file. */
export async function readAnimation(directory: string): Promise<AnimationManifest> {
  return parseAnimation(await readPackageFile(ANIMATION_PACKAGE, await realpath(directory)));
}

async function readContained(root: string, directory: string): Promise<AnimationManifest> {
  return readAnimation(await containedPackageDirectory(root, directory, 'Animation'));
}

async function scanAnimations(catalog: AnimationCatalogItem[], root: string, directory: string, prefix: string): Promise<void> {
  await scanPackageDirectory(catalog, directory, prefix, async (name) => {
    const reference = `${prefix}${name}`;
    try {
      const manifest = await readContained(root, join(directory, name));
      catalog.push({ reference, name: manifest.name, manifest });
    } catch (error) {
      catalog.push({ reference, name: reference, error: error instanceof Error ? error.message : String(error) });
    }
  });
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
