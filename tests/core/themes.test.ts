import { afterEach, expect, test } from 'bun:test';
import { mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { parseTheme, loadApplicationThemeCatalog, loadThemeCatalog, readTheme } from '../../src/core/themes';
import { DARK_TOKENS, LIGHT_TOKENS, projectThemeReference, resolveTheme, themeTokens } from '../../src/shared/themes';
import { addTheme, updateTheme, removeTheme, syncThemes, statusThemes, themeGit } from '../../src/core/theme-install';
import { parseDashboardLock, serializeDashboardLock } from '../../src/core/yaml';
import { temporaryDirectory, removeTemporaryDirectory } from './helpers';
import { themeArtifacts } from '../../scripts/generate-themes';
const cleanup: string[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(removeTemporaryDirectory)); });
async function temp() { const dir = await temporaryDirectory(); cleanup.push(dir); return dir; }
const manifest = { schemaVersion: 1, id: 'ocean', name: 'Ocean', light: { accent: '#123456' }, dark: { accent: '#abcdef' } };
test('strict token manifest and complete mode defaults', () => {
  const parsed = parseTheme(stringify(manifest));
  expect(themeTokens(parsed, 'light')).toEqual({ ...LIGHT_TOKENS, accent: '#123456' });
  expect(themeTokens(parsed, 'dark')).toEqual({ ...DARK_TOKENS, accent: '#abcdef' });
  for (const change of [
    { script: 'run' }, { light: { unknown: '#123456' } }, { light: { accent: 'url(https://bad)' } },
    { light: { 'font-ui': 'serif;display:none' } }, { light: { radius: '999px' } },
    { light: { shadow: '0 0 url(bad)' } }, { schemaVersion: 2 }, { dark: null },
  ]) expect(() => parseTheme(stringify({ ...manifest, ...change }))).toThrow();
  expect(() => parseTheme(`${stringify(manifest)}name: duplicate\n`)).toThrow();
  expect(() => parseTheme('x'.repeat(65537))).toThrow();
});
test('selection falls through missing dashboard and personal themes to built-in', () => {
  const ocean = { reference: 'global:ocean', name: 'Ocean', manifest: parseTheme(stringify(manifest)) };
  expect(resolveTheme([ocean], './themes/missing', 'global:ocean').item).toEqual(ocean);
  expect(resolveTheme([], './themes/missing', 'global:missing').errors).toHaveLength(2);
  expect(resolveTheme([], undefined).item.reference).toBe('builtin:default');
});
test('catalog reads local themes without executing anything and rejects escaping symlinks', async () => {
  const root = await temp(); const outside = await temp();
  await mkdir(join(root, 'themes', 'ocean'), { recursive: true });
  await writeFile(join(root, 'themes', 'ocean', 'theme.yaml'), stringify(manifest));
  await writeFile(join(outside, 'theme.yaml'), stringify(manifest));
  await symlink(outside, join(root, 'themes', 'escape'));
  const items = await loadThemeCatalog(root, join(root, 'personal'));
  expect(items.find((i) => i.reference === './themes/ocean')?.manifest?.name).toBe('Ocean');
  expect(items.find((i) => i.reference === './themes/escape')?.error).toContain('escapes');
  await rm(join(root, 'themes', 'ocean', 'theme.yaml'));
  await symlink(join(outside, 'theme.yaml'), join(root, 'themes', 'ocean', 'theme.yaml'));
  await expect(readTheme(join(root, 'themes', 'ocean'))).rejects.toThrow('contained');
});
test('application theme catalog aggregates project packages with stable references', async () => {
  const first = await temp(); const second = await temp(); const global = await temp();
  for (const [root, id, name] of [[first, 'retro', 'Retro'], [second, 'retro', 'Retro Other']] as const) {
    await mkdir(join(root, 'themes', id), { recursive: true });
    await writeFile(join(root, 'themes', id, 'theme.yaml'), stringify({ ...manifest, id, name }));
  }
  const firstConfig = join(first, 'dash-bored.yaml');
  const secondConfig = join(second, 'dash-bored.yaml');
  const catalog = await loadApplicationThemeCatalog([
    { configPath: firstConfig, configDirectory: first, label: 'First dashboard' },
    { configPath: secondConfig, configDirectory: second, label: 'Second dashboard' },
  ], global);
  const firstReference = projectThemeReference(firstConfig, './themes/retro');
  const secondReference = projectThemeReference(secondConfig, './themes/retro');
  expect(catalog.find((item) => item.reference === firstReference)).toMatchObject({ name: 'Retro', displayReference: 'First dashboard · ./themes/retro' });
  expect(catalog.find((item) => item.reference === secondReference)).toMatchObject({ name: 'Retro Other', displayReference: 'Second dashboard · ./themes/retro' });
  expect(catalog.filter((item) => item.reference.startsWith('project:'))).toHaveLength(2);
});
test('generated public schema, CSS defaults and token reference are current', async () => {
  for (const [path, expected] of Object.entries(themeArtifacts)) expect(await readFile(path, 'utf8')).toBe(expected);
});
async function repo(path: string) {
  await themeGit(path, ['init']);
  await themeGit(path, ['config', 'user.email', 'test@example.invalid']);
  await themeGit(path, ['config', 'user.name', 'Theme Test']);
}
async function commit(path: string) {
  await themeGit(path, ['add', '.']); await themeGit(path, ['commit', '-m', 'fixture']);
  return themeGit(path, ['rev-parse', 'HEAD']);
}
for (const global of [true, false]) test(`git theme lifecycle, rollback and dirty protection (${global ? 'global' : 'project'})`, async () => {
  const source = await temp(); await repo(source); await writeFile(join(source, 'theme.yaml'), stringify(manifest)); const first = await commit(source);
  const root = await temp(); await repo(root);
  await mkdir(join(root, '.dash-bored'));
  await writeFile(join(root, '.dash-bored', 'dash-bored.yaml'), 'schemaVersion: 3\nname: Test\nroot:\n  component: "@dash-bored/group"\n');
  const component = { url: 'https://example.invalid/component.git', commit: 'a'.repeat(40), path: 'components/external/keep' };
  await writeFile(join(root, '.dash-bored', 'dash-bored-lock.yaml'), serializeDashboardLock({ lockfileVersion: 1, components: { keep: component } }));
  await commit(root);
  const target = { global, project: root, globalDirectory: join(root, 'personal') };
  expect((await addTheme(target, source, { name: 'ocean' })).commit).toBe(first);
  expect((await statusThemes(target))[0]?.inSync).toBe(true);
  const checkout = global ? join(root, 'personal', 'ocean') : join(root, '.dash-bored', 'themes', 'external', 'ocean');
  await writeFile(join(checkout, 'local.txt'), 'unsaved');
  await expect(updateTheme(target, 'ocean')).rejects.toThrow('local changes');
  await expect(syncThemes(target)).rejects.toThrow('local changes');
  await expect(removeTheme(target, 'ocean')).rejects.toThrow('local changes');
  await rm(join(checkout, 'local.txt'));
  await writeFile(join(source, 'theme.yaml'), stringify({ ...manifest, name: 'Ocean Two' })); const second = await commit(source);
  expect((await statusThemes(target))[0]?.commit).toBe(first);
  expect((await updateTheme(target, 'ocean')).commit).toBe(second);
  await themeGit(checkout, ['checkout', '--detach', first]);
  await syncThemes(target);
  expect((await statusThemes(target))[0]?.inSync).toBe(true);
  await writeFile(join(source, 'theme.yaml'), 'invalid: yes'); await commit(source);
  await expect(updateTheme(target, 'ocean')).rejects.toThrow();
  expect((await statusThemes(target))[0]?.checkedOutCommit).toBe(second);
  await expect(addTheme(target, source, { name: 'broken' })).rejects.toThrow();
  expect((await statusThemes(target)).map((i) => i.name)).toEqual(['ocean']);
  if (!global) { expect((await parseDashboardLock(join(root, '.dash-bored', 'dash-bored-lock.yaml'))).value?.components.keep).toEqual(component); await commit(root); }
  if (global) await rm(checkout, { recursive: true });
  else await themeGit(root, ['submodule', 'deinit', '--', '.dash-bored/themes/external/ocean']);
  const missingCatalog = await loadThemeCatalog(join(root, '.dash-bored'), join(root, 'personal'));
  const missing = missingCatalog.find((item) => item.reference === (global ? 'global:ocean' : './themes/external/ocean'));
  expect(missing?.git).toEqual({ name: 'ocean', url: source, commit: second });
  expect(missing?.error).toBeDefined();
  await syncThemes(target);
  expect((await statusThemes(target))[0]?.checkedOutCommit).toBe(second);
  await removeTheme(target, 'ocean');
  expect(await statusThemes(target)).toEqual([]);
  await addTheme(target, source, { name: "ocean", ref: first });
  expect((await statusThemes(target))[0]?.commit).toBe(first);
}, 60_000);

test('theme reload updates token data without changing component revision, trust or terminal PID', async () => {
  const { ProjectRuntime, TrustStore } = await import('../../src/core');
  const { createProject, writeLocalComponent } = await import('./helpers');
  const root = await temp();
  await createProject(root, { schemaVersion: 3, name: 'Themes', theme: './themes/ocean', root: {
          id: 'root', component: '@dash-bored/group', children: { axis: 'vertical',
              first: { node: { id: 'terminal', component: '@dash-bored/command', props: { label: 'Terminal', command: 'sleep 30' } } },
              second: { node: { id: 'local', component: './components/example' } }
          }
      } });
  await writeLocalComponent(root, 'example', "import { defineComponent, useTheme } from '@dash-bored/component'; export default defineComponent(() => <p>{useTheme().appearance}</p>);");
  const dir = join(root, '.dash-bored', 'themes', 'ocean'); await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'theme.yaml'), stringify(manifest));
  const runtime = new ProjectRuntime({ trustStore: new TrustStore(join(root, 'trust.json')) });
  try {
    const restricted = await runtime.load(root);
    expect(restricted.themeCatalog?.find((item) => item.reference === './themes/ocean')?.manifest?.name).toBe('Ocean');
    await runtime.trust();
    await runtime.startProcess('terminal');
    const before = runtime.getSnapshot();
    await writeFile(join(dir, 'theme.yaml'), stringify({ ...manifest, name: 'Changed' }));
    const after = await runtime.reload();
    expect(after.trusted).toBe(true);
    expect(after.processes[0]?.pid).toBe(before.processes[0]?.pid);
    expect(after.components).toEqual(before.components);
    expect(after.themeCatalog?.find((item) => item.reference === './themes/ocean')?.manifest?.name).toBe('Changed');
    await writeFile(join(dir, 'theme.yaml'), 'invalid: true');
    const broken = await runtime.reload();
    expect(broken.tree).not.toBeNull();
    expect(broken.processes[0]?.pid).toBe(before.processes[0]?.pid);
    expect(broken.diagnostics.some((item) => item.code === 'THEME_UNAVAILABLE' && item.severity === 'warning')).toBe(true);
  } finally { await runtime.close(); }
});

test('CLI scaffolds and validates themes without altering dashboard selection', async () => {
  const { createProject } = await import('./helpers');
  const root = await temp(); await createProject(root);
  const configPath = join(root, '.dash-bored', 'dash-bored.yaml');
  const before = await readFile(configPath, 'utf8');
  async function cli(...args: string[]) {
    const process = Bun.spawn(['bun', 'src/cli/index.ts', 'theme', ...args], { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
    return { stdout, stderr, code };
  }
  expect((await cli('init', 'sample', root)).code).toBe(0);
  expect((await cli('init', 'sample', root)).code).toBe(1);
  expect((await cli('validate', join(root, '.dash-bored', 'themes', 'sample'))).code).toBe(0);
  expect(JSON.parse((await cli('list', root)).stdout).some((item: { reference: string }) => item.reference === './themes/sample')).toBe(true);
  expect((await cli('validate', '--schema')).code).toBe(0);
  expect((await cli('validate', '--schema', 'unexpected')).code).toBe(1);
  expect((await cli('add', '--bad')).code).toBe(1);
  expect(await readFile(configPath, 'utf8')).toBe(before);
});

test('component git mutations preserve theme pins', async () => {
  const { addComponent, updateComponent, removeComponent } = await import('../../src/core/external-components');
  const { createProject } = await import('./helpers');
  const root = await temp(); await repo(root);
  const pin = { url: 'https://example.invalid/ocean.git', commit: 'b'.repeat(40), path: 'themes/external/ocean' };
  await createProject(root, undefined, { lockfileVersion: 1, components: {}, themes: { ocean: pin } });
  await commit(root);
  const source = await temp(); await repo(source);
  await writeFile(join(source, 'README.md'), 'Component fixture'); await commit(source);
  await addComponent(root, source, { name: 'sample' });
  const lockPath = join(root, '.dash-bored', 'dash-bored-lock.yaml');
  expect((await parseDashboardLock(lockPath)).value?.themes?.ocean).toEqual(pin);
  await writeFile(join(source, 'README.md'), 'Next revision'); await commit(source);
  await updateComponent(root, 'sample');
  expect((await parseDashboardLock(lockPath)).value?.themes?.ocean).toEqual(pin);
  await removeComponent(root, 'sample');
  expect((await parseDashboardLock(lockPath)).value?.themes?.ocean).toEqual(pin);
});
