# Attention animations

`attention:<node>` points the user at one component. It reveals the node like
`reveal:<node>`, scrolls it (or one of its items) into view, plays a bounded
animation on it, and shows a notice naming the node and, when given, why.
Animations are data packages, like [themes](themes.md): built-ins ship with the
app, and users and agents write their own.

## Animation contract

`src/shared/animations.ts` owns the v1 manifest, the built-ins, the JSON
Schema, the bounds, and the translation to Web Animations keyframes.
`bun run generate:animations` writes `schemas/animation.schema.json` and the
skill's `references/animations.md`; a drift test checks both.

A package directory contains one `animation.yaml`: `schemaVersion: 1`, `id`,
`name`, optional `description`, `duration` (100–2000 ms per iteration),
optional `iterations` (1–4), `easing` (a fixed keyword set), `color` (`accent`,
`info`, `positive`, `warning`, or `negative`), and 2–24 `keyframes`. A keyframe
has an optional `at` offset (0–1, never decreasing) and the channels `x`/`y`
(±48 px), `rotate` (±30°), `scale` (0.5–1.5), `opacity` (0.25–1), `glow`
(0–1), and an `easing` to the next keyframe. Omitted channels are at rest.
`duration × iterations` stays at most 4 s, so attention cannot become
continuous motion. Unknown keys, aliases, files over 32 KiB, and escaping
symlinks are rejected; there is no CSS, code, or asset loading.

References are `builtin:<id>` (`bounce`, `shake`, `pulse`, `wiggle`, `glow`),
`global:<name>` for `~/.config/dash-bored/animations/<name>`, and
`./animations/<name>` below the owning bundle. The default is
`builtin:bounce`; a dashboard may set the optional top-level
`attentionAnimation` instead.

## Discovery and validation

`src/core/animations.ts` scans built-ins, the personal directory, and the
bundle's `animations/` into a catalog, kept on `ProjectSnapshot` and
`InspectResult` beside the theme catalog and listed by `inspect --summary`.
A broken bundle package is an `ANIMATION_INVALID` warning. Tree validation
treats `attention:` like `reveal:` (node target, linked-bundle remapping) and
checks its `{ animation?, message?, item? }` arguments against
`ATTENTION_ACTION_ARGS_SCHEMA`; item templates are allowed as whole values in
`itemActions`. An animation or `attentionAnimation` that does not resolve on
this machine is an `ANIMATION_UNAVAILABLE` warning, never an error: like a
theme, a personal animation may be missing elsewhere.

## Playing

`src/renderer/lib/attention.ts` builds one `attention:<node>` action per node,
listed under the **Draw attention to component** chooser, whose second choice
previews any valid catalog animation. Running one:

1. Resolves the manifest. Built-ins resolve in the renderer; anything else is
   read fresh by main through the `readAnimation` RPC, so a package written a
   moment ago plays without a reload. `./animations/` resolves in the bundle of
   the invoking node (main accepts only config paths in the open snapshot). An
   explicit animation that does not resolve fails the action with its reason;
   a broken `attentionAnimation` falls back to `builtin:bounce`.
2. Shows the dashboard and reveals the node.
3. Waits for the frame, or the `data-item-id` element named by `item`, to
   mount, scrolls it into view, and waits until it stops moving.
4. Plays the keyframes with `Element.animate` on that element, cancelling any
   earlier attention animation there, marks it `data-attention` (which lifts
   it above neighbours), and shows the notice.

The glow is a two-layer box shadow in the resolved theme color, composed in
front of the element's own shadow and shaped by the corners of the first
descendant surface that fills the frame, since frames are transparent
wrappers. Keyboard focus never moves. Reduced motion drops `x`, `y`,
`rotate`, and `scale`; an animation with nothing left plays `builtin:glow`.

A window that paints no frame within a second (hidden or minimized) would play
unseen. The action then resolves without playing, and the request waits for the
next painted frame; only the latest such request is kept, and its failures are
logged rather than returned. Native webview overlays
are not DOM descendants and do not move with the animation.

## Agent tools

The control channel accepts `animation`, `message` (at most 200 characters),
and `item` only for `attention:` references; the CLI exposes them as
`app run attention:<node-id> --animation <reference> --message <text>
--item <id>`. `dash-bored animation init|validate|list` scaffolds, checks, and
lists packages (`--global` targets the personal directory).
