/**
 * Public v1 attention-animation contract. An animation is bounded keyframe
 * data the renderer plays on a component frame; never CSS or code.
 */
export const ANIMATION_COLORS = ['accent', 'info', 'positive', 'warning', 'negative'] as const;
export type AnimationColor = typeof ANIMATION_COLORS[number];
export const ANIMATION_EASINGS = ['linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out'] as const;
export type AnimationEasing = typeof ANIMATION_EASINGS[number];

/** Bounds shared by the schema, the parser, and the renderer. */
export const ANIMATION_LIMITS = {
  translate: 48,
  rotate: 30,
  scale: { min: 0.5, max: 1.5 },
  opacity: { min: 0.25, max: 1 },
  duration: { min: 100, max: 2000 },
  iterations: { min: 1, max: 4 },
  /** One request never animates longer than this, so attention cannot become continuous motion. */
  totalMs: 4000,
  keyframes: { min: 2, max: 24 },
} as const;

/** Channels a keyframe omits are at rest: no offset, no rotation, scale 1, opacity 1, no glow. */
export interface AnimationKeyframe {
  /** Position in one iteration, 0–1; omitted offsets are spaced evenly. */
  at?: number;
  /** Horizontal and vertical offset in CSS pixels. */
  x?: number;
  y?: number;
  /** Degrees. */
  rotate?: number;
  scale?: number;
  opacity?: number;
  /** Halo intensity, 0–1, in the animation's `color` token. */
  glow?: number;
  /** Timing from this keyframe to the next; defaults to the animation's `easing`. */
  easing?: AnimationEasing;
}

export interface AnimationManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  description?: string;
  /** Milliseconds per iteration. */
  duration: number;
  iterations?: number;
  easing?: AnimationEasing;
  /** Theme token the glow uses; defaults to `accent`. */
  color?: AnimationColor;
  keyframes: AnimationKeyframe[];
}

export interface AnimationCatalogItem {
  reference: string;
  name: string;
  manifest?: AnimationManifest;
  error?: string;
}

const NAME = '[A-Za-z][A-Za-z0-9_-]*';
export const ANIMATION_REFERENCE_PATTERN = `^(?:builtin:${NAME}|global:${NAME}|\\./animations/${NAME})$`;
const ANIMATION_REFERENCE = new RegExp(ANIMATION_REFERENCE_PATTERN);
export function isAnimationReference(reference: string): boolean {
  return ANIMATION_REFERENCE.test(reference);
}

/** Played when an attention request names no animation and the dashboard sets no `attentionAnimation`. */
export const DEFAULT_ANIMATION_REFERENCE = 'builtin:bounce';

function builtin(manifest: AnimationManifest): AnimationCatalogItem {
  return { reference: `builtin:${manifest.id}`, name: manifest.name, manifest };
}

/** Animations shipped with the app; every catalog starts with these. */
export const BUILTIN_ANIMATIONS: readonly AnimationCatalogItem[] = [
  builtin({
    schemaVersion: 1, id: 'bounce', name: 'Bounce',
    description: 'Hops twice and settles, like a dock icon asking for attention.',
    duration: 900,
    keyframes: [
      { at: 0, y: 0, glow: 0, easing: 'ease-out' },
      { at: 0.22, y: -14, glow: 0.5, easing: 'ease-in' },
      { at: 0.42, y: 0, glow: 0.6, easing: 'ease-out' },
      { at: 0.58, y: -7, glow: 0.6, easing: 'ease-in' },
      { at: 0.74, y: 0, glow: 0.5, easing: 'ease-out' },
      { at: 0.86, y: -2, glow: 0.4, easing: 'ease-in' },
      { at: 1, y: 0, glow: 0 },
    ],
  }),
  builtin({
    schemaVersion: 1, id: 'shake', name: 'Shake',
    description: 'A short horizontal shake for something that needs a second look.',
    duration: 560,
    keyframes: [
      { x: 0, glow: 0 }, { x: -10, glow: 0.5 }, { x: 9, glow: 0.6 }, { x: -7, glow: 0.6 },
      { x: 5, glow: 0.5 }, { x: -3, glow: 0.4 }, { x: 1, glow: 0.2 }, { x: 0, glow: 0 },
    ],
  }),
  builtin({
    schemaVersion: 1, id: 'pulse', name: 'Pulse',
    description: 'Swells slightly with a halo, twice.',
    duration: 700, iterations: 2,
    keyframes: [{ scale: 1, glow: 0 }, { scale: 1.025, glow: 0.8 }, { scale: 1, glow: 0 }],
  }),
  builtin({
    schemaVersion: 1, id: 'wiggle', name: 'Wiggle',
    description: 'A playful rotation back and forth.',
    duration: 620,
    keyframes: [
      { rotate: 0, glow: 0 }, { rotate: -1.4, glow: 0.5 }, { rotate: 1.2, glow: 0.6 },
      { rotate: -0.8, glow: 0.5 }, { rotate: 0.4, glow: 0.3 }, { rotate: 0, glow: 0 },
    ],
  }),
  builtin({
    schemaVersion: 1, id: 'glow', name: 'Glow',
    description: 'A halo that brightens twice without moving; also the reduced-motion fallback.',
    duration: 1600,
    keyframes: [{ glow: 0 }, { glow: 1 }, { glow: 0.45 }, { glow: 1 }, { glow: 0 }],
  }),
];

export function builtinAnimation(reference: string): AnimationManifest | undefined {
  return BUILTIN_ANIMATIONS.find((item) => item.reference === reference)?.manifest;
}

const number = (minimum: number, maximum: number) => ({ type: 'number', minimum, maximum });
export const ANIMATION_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object', additionalProperties: false, required: ['schemaVersion', 'id', 'name', 'duration', 'keyframes'],
  properties: {
    schemaVersion: { const: 1 },
    id: { type: 'string', pattern: `^${NAME}$`, maxLength: 80 },
    name: { type: 'string', minLength: 1, maxLength: 100 },
    description: { type: 'string', maxLength: 1000 },
    duration: { type: 'integer', minimum: ANIMATION_LIMITS.duration.min, maximum: ANIMATION_LIMITS.duration.max },
    iterations: { type: 'integer', minimum: ANIMATION_LIMITS.iterations.min, maximum: ANIMATION_LIMITS.iterations.max },
    easing: { enum: [...ANIMATION_EASINGS] },
    color: { enum: [...ANIMATION_COLORS] },
    keyframes: {
      type: 'array', minItems: ANIMATION_LIMITS.keyframes.min, maxItems: ANIMATION_LIMITS.keyframes.max,
      items: {
        type: 'object', additionalProperties: false, minProperties: 1,
        properties: {
          at: number(0, 1),
          x: number(-ANIMATION_LIMITS.translate, ANIMATION_LIMITS.translate),
          y: number(-ANIMATION_LIMITS.translate, ANIMATION_LIMITS.translate),
          rotate: number(-ANIMATION_LIMITS.rotate, ANIMATION_LIMITS.rotate),
          scale: number(ANIMATION_LIMITS.scale.min, ANIMATION_LIMITS.scale.max),
          opacity: number(ANIMATION_LIMITS.opacity.min, ANIMATION_LIMITS.opacity.max),
          glow: number(0, 1),
          easing: { enum: [...ANIMATION_EASINGS] },
        },
      },
    },
  },
};

/** Rules the JSON Schema cannot express. Returns one message per problem. */
export function animationProblems(manifest: AnimationManifest): string[] {
  const problems: string[] = [];
  const total = manifest.duration * (manifest.iterations ?? 1);
  if (total > ANIMATION_LIMITS.totalMs) {
    problems.push(`duration × iterations is ${total} ms; keep it at most ${ANIMATION_LIMITS.totalMs} ms.`);
  }
  let previous = -1;
  manifest.keyframes.forEach((keyframe, index) => {
    if (keyframe.at === undefined) return;
    if (keyframe.at < previous) problems.push(`keyframes[${index}].at must not be before an earlier keyframe.`);
    previous = keyframe.at;
  });
  return problems;
}

export interface PlayableAnimation {
  keyframes: Keyframe[];
  timing: { duration: number; iterations: number; easing: 'linear' };
}

const MOTION_CHANNELS = ['x', 'y', 'rotate', 'scale'] as const;

/**
 * Translate a manifest into Web Animations keyframes. The glow is composed in
 * front of the element's own `baseShadow`, so the frame keeps its shadow, and
 * follows `radius`, the corners of the surface the frame wraps.
 * Reduced motion drops movement; an animation with nothing left plays the
 * built-in glow instead.
 */
export function playableAnimation(
  manifest: AnimationManifest,
  options: { reducedMotion: boolean; glowRgb: string; baseShadow?: string; radius?: string },
): PlayableAnimation {
  const uses = (channel: keyof AnimationKeyframe) => manifest.keyframes.some((keyframe) => keyframe[channel] !== undefined);
  const motion = !options.reducedMotion && MOTION_CHANNELS.some(uses);
  const opacity = uses('opacity');
  const glow = uses('glow');
  if (!motion && !opacity && !glow) {
    return playableAnimation(builtinAnimation('builtin:glow')!, { ...options, reducedMotion: true });
  }
  const base = options.baseShadow && options.baseShadow !== 'none' ? `, ${options.baseShadow}` : '';
  const keyframes = manifest.keyframes.map((keyframe): Keyframe => {
    const frame: Keyframe = { easing: keyframe.easing ?? manifest.easing ?? 'ease-in-out' };
    if (keyframe.at !== undefined) frame.offset = keyframe.at;
    if (motion) {
      frame.transform = `translate(${keyframe.x ?? 0}px, ${keyframe.y ?? 0}px) rotate(${keyframe.rotate ?? 0}deg) scale(${keyframe.scale ?? 1})`;
    }
    if (opacity) frame.opacity = keyframe.opacity ?? 1;
    if (glow) {
      const intensity = keyframe.glow ?? 0;
      const round = (value: number) => Math.round(value * 100) / 100;
      frame.boxShadow = `0 0 0 ${round(2 + 2 * intensity)}px rgba(${options.glowRgb}, ${round(0.8 * intensity)}), `
        + `0 0 ${round(28 * intensity)}px ${round(6 * intensity)}px rgba(${options.glowRgb}, ${round(0.5 * intensity)})${base}`;
      if (options.radius) frame.borderRadius = options.radius;
    }
    return frame;
  });
  return { keyframes, timing: { duration: manifest.duration, iterations: manifest.iterations ?? 1, easing: 'linear' } };
}

/** `#rrggbb` or `#rrggbbaa` (theme color tokens) to an `r, g, b` triple. */
export function hexToRgbTriple(value: string): string | undefined {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})(?:[0-9a-f]{2})?$/i.exec(value.trim());
  if (!match) return undefined;
  return match.slice(1, 4).map((part) => Number.parseInt(part, 16)).join(', ');
}
