import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { stringify } from 'yaml';
import { loadAnimationCatalog, personalAnimationsDirectory, readAnimation } from '../core/animations';
import { resolveProjectLocation } from '../core/paths';
import { ANIMATION_SCHEMA, type AnimationManifest } from '../shared/animations';

export const animationUsage = `dash-bored animation <command>
  init <name> [project] [--global]
  validate <animation-directory> | validate --schema
  list [project] [--global]

Project animations live in animations/<name>/animation.yaml beside dash-bored.yaml.
--global uses ~/.config/dash-bored/animations. Play one with
dash-bored app run attention:<node-id> --animation <reference>.`;

const NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** A starting point that uses every channel once, so authors see the format. */
function starter(name: string): AnimationManifest {
  return {
    schemaVersion: 1, id: name, name, description: 'A custom attention animation.',
    duration: 700, easing: 'ease-in-out', color: 'accent',
    keyframes: [
      { at: 0, x: 0, glow: 0 },
      { at: 0.3, x: -6, rotate: -1, glow: 0.8 },
      { at: 0.6, x: 6, rotate: 1, scale: 1.02, glow: 0.8 },
      { at: 1, x: 0, glow: 0 },
    ],
  };
}

export async function runAnimationCommand(args: string[]): Promise<number> {
  try {
    const [command, ...rest] = args;
    if (!command || ['help', '--help', '-h'].includes(command) || rest.includes('--help')) { console.log(animationUsage); return 0; }
    const positional: string[] = [];
    const flags = new Set<string>();
    for (const arg of rest) {
      if (arg === '--global' || arg === '--schema') { flags.add(arg.slice(2)); continue; }
      if (arg.startsWith('-')) throw new Error(`Unknown option ${arg}.`);
      positional.push(arg);
    }
    const allowed = command === 'validate' ? ['schema'] : ['global'];
    for (const flag of flags) if (!allowed.includes(flag)) throw new Error(`${command} does not accept --${flag}.`);
    const global = flags.has('global');
    let result: unknown;
    switch (command) {
      case 'init': {
        const [name, project = '.', ...extra] = positional;
        if (!name || !NAME.test(name)) throw new Error('animation init requires a name that starts with a letter and uses letters, digits, _ or -.');
        if (extra.length || (global && positional.length > 1)) throw new Error('Use one project target, or --global.');
        const boundary = global ? personalAnimationsDirectory() : (await resolveProjectLocation(project)).configDirectory;
        const root = global ? boundary : join(boundary, 'animations');
        await mkdir(root, { recursive: true });
        const rel = relative(await realpath(boundary), await realpath(root));
        if (rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('Animation directory escapes its dashboard bundle.');
        const directory = join(root, name);
        await mkdir(directory);
        await writeFile(join(directory, 'animation.yaml'), stringify(starter(name)), { flag: 'wx' });
        result = { directory, reference: global ? `global:${name}` : `./animations/${name}` };
        break;
      }
      case 'validate':
        if (flags.has('schema')) {
          if (positional.length) throw new Error('Pass a single animation directory or --schema.');
          result = ANIMATION_SCHEMA;
        } else {
          if (positional.length !== 1) throw new Error('animation validate requires one animation directory.');
          result = await readAnimation(resolve(positional[0]!));
        }
        break;
      case 'list': {
        if (positional.length > 1 || (global && positional.length)) throw new Error('Use one project target, or --global.');
        result = await loadAnimationCatalog(global ? undefined : (await resolveProjectLocation(positional[0] ?? '.')).configDirectory);
        break;
      }
      default: throw new Error(`Unknown animation command: ${command}.\n${animationUsage}`);
    }
    console.log(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); return 1; }
}
