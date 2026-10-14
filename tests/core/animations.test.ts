import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { loadAnimationCatalog, parseAnimation, resolveAnimation } from '../../src/core/animations';
import { loadProjectDefinition } from '../../src/core';
import {
  BUILTIN_ANIMATIONS,
  builtinAnimation,
  hexToRgbTriple,
  playableAnimation,
  type AnimationManifest,
} from '../../src/shared/animations';
import type { DashboardConfig } from '../../src/shared/contracts';
import { animationArtifacts } from '../../scripts/generate-animations';
import { createProject, removeTemporaryDirectory, temporaryDirectory } from './helpers';

const cleanup: string[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(removeTemporaryDirectory)); });
async function temp() { const dir = await temporaryDirectory(); cleanup.push(dir); return dir; }

const nudge: AnimationManifest = {
  schemaVersion: 1, id: 'nudge', name: 'Nudge', duration: 600, color: 'warning',
  keyframes: [{ at: 0, x: 0, glow: 0 }, { at: 0.4, x: 8, glow: 1, easing: 'ease-out' }, { at: 1, x: 0, glow: 0 }],
};

async function writeAnimation(directory: string, manifest: unknown): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'animation.yaml'), typeof manifest === 'string' ? manifest : stringify(manifest));
}

describe('animation manifests', () => {
  test('accept bounded keyframe data and reject anything else', () => {
    expect(parseAnimation(stringify(nudge))).toEqual(nudge);
    const invalid: [unknown, string][] = [
      [{ ...nudge, css: 'transform: none' }, 'additional properties'],
      [{ ...nudge, keyframes: [{ x: 0 }] }, 'fewer than 2'],
      [{ ...nudge, keyframes: [{ x: 0 }, { x: 400 }] }, '<= 48'],
      [{ ...nudge, keyframes: [{ x: 0 }, { transform: 'scale(9)' }] }, 'additional properties'],
      [{ ...nudge, duration: 2000, iterations: 3 }, 'at most 4000 ms'],
      [{ ...nudge, keyframes: [{ at: 0.5, x: 1 }, { at: 0.2, x: 0 }] }, 'must not be before'],
      [{ ...nudge, color: '#ff0000' }, 'allowed values'],
    ];
    for (const [manifest, message] of invalid) expect(() => parseAnimation(stringify(manifest))).toThrow(message);
    expect(() => parseAnimation('a: &x 1\nb: *x\n')).toThrow();
  });

  test('every built-in satisfies its own contract', () => {
    for (const item of BUILTIN_ANIMATIONS) expect(parseAnimation(stringify(item.manifest))).toEqual(item.manifest!);
  });

  test('play as Web Animations keyframes that keep the frame shadow', () => {
    const played = playableAnimation(nudge, { reducedMotion: false, glowRgb: '1, 2, 3', baseShadow: '0px 1px 2px rgb(0, 0, 0)', radius: '11px' });
    expect(played.timing).toEqual({ duration: 600, iterations: 1, easing: 'linear' });
    expect(played.keyframes[1]).toEqual({
      easing: 'ease-out', offset: 0.4,
      transform: 'translate(8px, 0px) rotate(0deg) scale(1)',
      boxShadow: '0 0 0 4px rgba(1, 2, 3, 0.8), 0 0 28px 6px rgba(1, 2, 3, 0.5), 0px 1px 2px rgb(0, 0, 0)',
      borderRadius: '11px',
    });
    expect(played.keyframes[0]!.easing).toBe('ease-in-out');
  });

  test('reduced motion keeps glow and opacity, and falls back to the built-in glow', () => {
    const calm = playableAnimation(nudge, { reducedMotion: true, glowRgb: '1, 2, 3' });
    expect(calm.keyframes.some((frame) => 'transform' in frame)).toBeFalse();
    expect(calm.keyframes.every((frame) => typeof frame.boxShadow === 'string')).toBeTrue();
    const motionOnly: AnimationManifest = { ...nudge, keyframes: [{ x: 0 }, { x: 8 }, { x: 0 }] };
    const fallback = playableAnimation(motionOnly, { reducedMotion: true, glowRgb: '1, 2, 3' });
    expect(fallback.timing.duration).toBe(builtinAnimation('builtin:glow')!.duration);
    expect(fallback.keyframes.some((frame) => 'transform' in frame)).toBeFalse();
    expect(hexToRgbTriple('#a8c8ff')).toBe('168, 200, 255');
    expect(hexToRgbTriple('#a8c8ff80')).toBe('168, 200, 255');
    expect(hexToRgbTriple('rgb(1, 2, 3)')).toBeUndefined();
  });

  test('generated public schema and skill reference are current', async () => {
    for (const [path, expected] of Object.entries(animationArtifacts)) expect(await readFile(path, 'utf8')).toBe(expected);
  });
});

describe('animation catalog', () => {
  test('lists built-ins, personal, and bundle packages, keeping broken ones visible', async () => {
    const bundle = await temp();
    const personal = await temp();
    await writeAnimation(join(personal, 'soft'), { ...nudge, id: 'soft', name: 'Soft' });
    await writeAnimation(join(bundle, 'animations', 'nudge'), nudge);
    await writeAnimation(join(bundle, 'animations', 'broken'), { ...nudge, keyframes: [] });
    const catalog = await loadAnimationCatalog(bundle, personal);
    expect(catalog.slice(0, BUILTIN_ANIMATIONS.length)).toEqual([...BUILTIN_ANIMATIONS]);
    expect(catalog.slice(BUILTIN_ANIMATIONS.length).map(({ reference, name, error }) => [reference, name, Boolean(error)])).toEqual([
      ['global:soft', 'Soft', false],
      ['./animations/broken', './animations/broken', true],
      ['./animations/nudge', 'Nudge', false],
    ]);
  });

  test('resolves references fresh from disk and refuses escapes', async () => {
    const bundle = await temp();
    const personal = await temp();
    const outside = await temp();
    expect(await resolveAnimation('builtin:shake', undefined, personal)).toEqual(builtinAnimation('builtin:shake')!);
    await expect(resolveAnimation('builtin:spin', bundle, personal)).rejects.toThrow('not a built-in animation');
    await expect(resolveAnimation('./animations/nudge', bundle, personal)).rejects.toThrow('animation not found');
    await writeAnimation(join(bundle, 'animations', 'nudge'), nudge);
    expect(await resolveAnimation('./animations/nudge', bundle, personal)).toEqual(nudge);
    await writeAnimation(join(outside, 'escape'), nudge);
    await symlink(join(outside, 'escape'), join(personal, 'escape'));
    await expect(resolveAnimation('global:escape', bundle, personal)).rejects.toThrow('escapes its installation root');
    await expect(resolveAnimation('./animations/../x', bundle, personal)).rejects.toThrow('not an animation reference');
  });
});

describe('attention in dashboards', () => {
  const dashboard = (action: unknown, extra: Partial<DashboardConfig> = {}): DashboardConfig => ({
    schemaVersion: 4, name: 'Attention', ...extra, root: {
      id: 'root', component: './components/external/core/group', children: { axis: 'vertical',
        first: { node: { id: 'ask', component: './components/external/core/button', props: { name: 'Look', action } } },
        second: { node: { id: 'backlog', component: './components/external/core/list', props: { todos: [] } } },
      } },
  });
  const codes = (diagnostics: { code: string; severity: string }[]) =>
    diagnostics.filter((item) => item.code.startsWith('ANIMATION_') || item.code.startsWith('COMPONENT_ACTION_')).map(({ code, severity }) => `${severity}:${code}`);

  test('validates attention targets and arguments, and warns about animations that do not resolve', async () => {
    const root = await temp();
    await createProject(root, dashboard({ run: 'attention:backlog', with: { animation: 'builtin:shake', message: 'Look here', item: 't-1' } }));
    expect(codes((await loadProjectDefinition(root)).diagnostics)).toEqual([]);

    await createProject(root, dashboard('attention:missing'));
    expect(codes((await loadProjectDefinition(root)).diagnostics)).toEqual(['error:COMPONENT_ACTION_REFERENCE_UNKNOWN']);

    await createProject(root, dashboard({ run: 'attention:backlog', with: { animation: 'shake' } }));
    expect(codes((await loadProjectDefinition(root)).diagnostics)).toEqual(['error:COMPONENT_ACTION_ARGUMENTS_INVALID']);

    await createProject(root, dashboard({ run: 'attention:backlog', with: { animation: './animations/nudge' } }));
    const missing = await loadProjectDefinition(root);
    expect(missing.ok).toBeTrue();
    expect(codes(missing.diagnostics)).toEqual(['warning:ANIMATION_UNAVAILABLE']);

    await writeAnimation(join(root, '.dash-bored', 'animations', 'nudge'), nudge);
    await writeAnimation(join(root, '.dash-bored', 'animations', 'broken'), { ...nudge, duration: 10 });
    const installed = await loadProjectDefinition(root);
    expect(codes(installed.diagnostics)).toEqual(['warning:ANIMATION_INVALID']);
    expect(installed.animationCatalog.find((item) => item.reference === './animations/nudge')?.manifest).toEqual(nudge);
  });

  test('accepts a dashboard default animation and warns when it does not resolve', async () => {
    const root = await temp();
    await createProject(root, dashboard('attention:backlog', { attentionAnimation: 'builtin:pulse' }));
    expect(codes((await loadProjectDefinition(root)).diagnostics)).toEqual([]);
    await createProject(root, dashboard('attention:backlog', { attentionAnimation: './animations/gone' }));
    const result = await loadProjectDefinition(root);
    expect(result.ok).toBeTrue();
    expect(result.diagnostics.find((item) => item.code === 'ANIMATION_UNAVAILABLE')?.path).toBe('/attentionAnimation');
  });
});
