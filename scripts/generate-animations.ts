import { mkdir, writeFile } from 'node:fs/promises';
import { ANIMATION_COLORS, ANIMATION_EASINGS, ANIMATION_LIMITS, ANIMATION_SCHEMA, BUILTIN_ANIMATIONS, DEFAULT_ANIMATION_REFERENCE } from '../src/shared/animations';

const builtins = BUILTIN_ANIMATIONS.map(({ reference, manifest }) => {
  const total = manifest!.duration * (manifest!.iterations ?? 1);
  return `| \`${reference}\`${reference === DEFAULT_ANIMATION_REFERENCE ? ' (default)' : ''} | ${total} ms | ${manifest!.description} |`;
}).join('\n');

export const animationArtifacts = {
  'schemas/animation.schema.json': `${JSON.stringify(ANIMATION_SCHEMA, null, 2)}\n`,
  'skills/dash-bored/references/animations.md': `# Attention animations

Generated from the v1 contract by \`bun run generate:animations\`.

\`attention:<node-id>\` reveals a node and plays an animation on its frame, or on
one item with \`item\`. Use it when the user should look at something: a result
you finished, a blocker, a failing check. It is not progress feedback.

## Built-ins

| Reference | Length | Motion |
| --- | --- | --- |
${builtins}

## Writing one

\`dash-bored animation init <name>\` writes \`animations/<name>/animation.yaml\` in the
bundle (\`--global\` writes \`~/.config/dash-bored/animations/<name>\`, referenced as
\`global:<name>\`). Check it with \`dash-bored animation validate <directory>\`, list
what resolves with \`dash-bored animation list\`, and preview it with
\`dash-bored app run attention:<node-id> --animation ./animations/<name>\`.

\`\`\`yaml
schemaVersion: 1
id: nudge
name: Nudge
description: A small sideways nudge with a warning halo.
duration: 600          # ms per iteration, ${ANIMATION_LIMITS.duration.min}–${ANIMATION_LIMITS.duration.max}
iterations: 1          # ${ANIMATION_LIMITS.iterations.min}–${ANIMATION_LIMITS.iterations.max}; duration × iterations ≤ ${ANIMATION_LIMITS.totalMs} ms
easing: ease-in-out    # default for every keyframe
color: warning         # glow token
keyframes:             # ${ANIMATION_LIMITS.keyframes.min}–${ANIMATION_LIMITS.keyframes.max}
  - { at: 0, x: 0, glow: 0 }
  - { at: 0.4, x: 8, glow: 1, easing: ease-out }
  - { at: 1, x: 0, glow: 0 }
\`\`\`

| Keyframe field | Range | At rest |
| --- | --- | --- |
| \`at\` | 0–1, never decreasing; omitted offsets are spaced evenly | — |
| \`x\`, \`y\` | ±${ANIMATION_LIMITS.translate} px | 0 |
| \`rotate\` | ±${ANIMATION_LIMITS.rotate} degrees | 0 |
| \`scale\` | ${ANIMATION_LIMITS.scale.min}–${ANIMATION_LIMITS.scale.max} | 1 |
| \`opacity\` | ${ANIMATION_LIMITS.opacity.min}–${ANIMATION_LIMITS.opacity.max} | 1 |
| \`glow\` | 0–1 halo in \`color\` | 0 |
| \`easing\` | ${ANIMATION_EASINGS.map((easing) => `\`${easing}\``).join(', ')} | the animation's \`easing\` |

\`color\` is one of ${ANIMATION_COLORS.map((color) => `\`${color}\``).join(', ')}, read from the current
theme. A keyframe's omitted channels are at rest, so end on a keyframe at rest.
With reduced motion the app drops \`x\`, \`y\`, \`rotate\`, and \`scale\` and keeps
\`opacity\` and \`glow\`; an animation with nothing left plays \`builtin:glow\`.
Animations are data: no CSS, scripts, or assets.
`,
};

if (import.meta.main) {
  await mkdir('schemas', { recursive: true });
  for (const [file, content] of Object.entries(animationArtifacts)) await writeFile(file, content);
}
