# Attention animations

Generated from the v1 contract by `bun run generate:animations`.

`attention:<node-id>` reveals a node and plays an animation on its frame, or on
one item with `item`. Use it when the user should look at something: a result
you finished, a blocker, a failing check. It is not progress feedback.

## Built-ins

| Reference | Length | Motion |
| --- | --- | --- |
| `builtin:bounce` (default) | 900 ms | Hops twice and settles, like a dock icon asking for attention. |
| `builtin:shake` | 560 ms | A short horizontal shake for something that needs a second look. |
| `builtin:pulse` | 1400 ms | Swells slightly with a halo, twice. |
| `builtin:wiggle` | 620 ms | A playful rotation back and forth. |
| `builtin:glow` | 1600 ms | A halo that brightens twice without moving; also the reduced-motion fallback. |

## Writing one

`dash-bored animation init <name>` writes `animations/<name>/animation.yaml` in the
bundle (`--global` writes `~/.config/dash-bored/animations/<name>`, referenced as
`global:<name>`). Check it with `dash-bored animation validate <directory>`, list
what resolves with `dash-bored animation list`, and preview it with
`dash-bored app run attention:<node-id> --animation ./animations/<name>`.

```yaml
schemaVersion: 1
id: nudge
name: Nudge
description: A small sideways nudge with a warning halo.
duration: 600          # ms per iteration, 100–2000
iterations: 1          # 1–4; duration × iterations ≤ 4000 ms
easing: ease-in-out    # default for every keyframe
color: warning         # glow token
keyframes:             # 2–24
  - { at: 0, x: 0, glow: 0 }
  - { at: 0.4, x: 8, glow: 1, easing: ease-out }
  - { at: 1, x: 0, glow: 0 }
```

| Keyframe field | Range | At rest |
| --- | --- | --- |
| `at` | 0–1, never decreasing; omitted offsets are spaced evenly | — |
| `x`, `y` | ±48 px | 0 |
| `rotate` | ±30 degrees | 0 |
| `scale` | 0.5–1.5 | 1 |
| `opacity` | 0.25–1 | 1 |
| `glow` | 0–1 halo in `color` | 0 |
| `easing` | `linear`, `ease`, `ease-in`, `ease-out`, `ease-in-out` | the animation's `easing` |

`color` is one of `accent`, `info`, `positive`, `warning`, `negative`, read from the current
theme. A keyframe's omitted channels are at rest, so end on a keyframe at rest.
With reduced motion the app drops `x`, `y`, `rotate`, and `scale` and keeps
`opacity` and `glow`; an animation with nothing left plays `builtin:glow`.
Animations are data: no CSS, scripts, or assets.
