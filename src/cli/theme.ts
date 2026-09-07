import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { stringify } from 'yaml';
import { addTheme, removeTheme, statusThemes, syncThemes, themeName, updateTheme } from '../core/theme-install';
import { loadThemeCatalog, personalThemesDirectory, readTheme } from '../core/themes';
import { resolveProjectLocation } from '../core/paths';
import { THEME_SCHEMA } from '../shared/themes';
export const themeUsage = `dash-bored theme <command>
  init <name> [project] [--global]
  validate <theme-directory> | validate --schema
  list [project] [--global]
  status [project] [--global]
  add <url> [project] [--name <name>] [--ref <ref>] [--global]
  update <name> [project] [--to <ref>] [--global]
  remove <name> [project] [--global]
  sync [project] [--global]

Project themes live beside dash-bored.yaml. --global uses ~/.config/dash-bored/themes.
Git installations pin exact commits and never select or auto-update themes.`;
export async function runThemeCommand(args: string[]): Promise<number> {
  try {
    const [command, ...rest] = args;
    if (!command || ['help', '--help', '-h'].includes(command) || rest.includes('--help')) { console.log(themeUsage); return 0; }
    const positional: string[] = [];
    const flags: Record<string, string | boolean> = {};
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i]!;
      if (arg === '--') { positional.push(...rest.slice(i + 1)); break; }
      if (arg === '--global' || arg === '--schema') { flags[arg.slice(2)] = true; continue; }
      if (['--name', '--ref', '--to'].includes(arg)) {
        const value = rest[++i];
        if (!value || value.startsWith('--') || flags[arg.slice(2)]) throw new Error(`Invalid ${arg}.`);
        flags[arg.slice(2)] = value; continue;
      }
      if (arg.startsWith('-')) throw new Error(`Unknown option ${arg}.`);
      positional.push(arg);
    }
    const allowed = command === 'add' ? ['global', 'name', 'ref'] : command === 'update' ? ['global', 'to'] : command === 'validate' ? ['schema'] : ['global'];
    for (const key of Object.keys(flags)) if (!allowed.includes(key)) throw new Error(`${command} does not accept --${key}.`);
    const takesName = ['init', 'add', 'update', 'remove', 'validate'].includes(command);
    const name = takesName ? positional.shift() : undefined;
    if (positional.length > 1 || (flags.global && positional.length)) throw new Error('Use one project target, or --global.');
    if (command === 'validate' && (positional.length || (flags.schema && name))) throw new Error('Pass a single theme directory or --schema.');
    const project = positional[0] ?? '.';
    const target = { project, global: flags.global === true };
    let result: unknown;
    switch (command) {
      case 'init': {
        if (!name) throw new Error('theme init requires a name.');
        themeName(name);
        if (!target.global && name === 'external') throw new Error('external is reserved for git theme installations.');
        const boundary = target.global ? personalThemesDirectory() : (await resolveProjectLocation(project)).configDirectory;
        const root = target.global ? boundary : join(boundary, 'themes');
        await mkdir(root, { recursive: true });
        const rel = relative(await realpath(boundary), await realpath(root));
        if (rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('Theme directory escapes its dashboard bundle.');
        const directory = join(root, name);
        await mkdir(directory);
        await writeFile(join(directory, 'theme.yaml'), stringify({ schemaVersion: 1, id: name, name, description: 'A custom dash-bored theme.', light: { accent: '#486500' }, dark: { accent: '#d9ff68' } }), { flag: 'wx' });
        result = { directory, reference: target.global ? `global:${name}` : `./themes/${name}` }; break;
      }
      case 'validate':
        if (flags.schema) result = THEME_SCHEMA;
        else { if (!name) throw new Error('theme validate requires a theme directory.'); result = await readTheme(resolve(name)); }
        break;
      case 'list': result = await loadThemeCatalog(target.global ? undefined : (await resolveProjectLocation(project)).configDirectory); break;
      case 'status': result = await statusThemes(target); break;
      case 'add': if (!name) throw new Error('theme add requires a URL.'); result = await addTheme(target, name, { name: flags.name as string | undefined, ref: flags.ref as string | undefined }); break;
      case 'update': if (!name) throw new Error('theme update requires a name.'); result = await updateTheme(target, name, flags.to as string | undefined); break;
      case 'remove': if (!name) throw new Error('theme remove requires a name.'); result = await removeTheme(target, name); break;
      case 'sync': result = await syncThemes(target); break;
      default: throw new Error(`Unknown theme command: ${command}.\n${themeUsage}`);
    }
    console.log(JSON.stringify(result, null, 2)); return 0;
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); return 1; }
}
