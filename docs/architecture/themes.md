# Themes

Themes are data packages, independent of component mounting, trust grants,
focus, and visibility. `src/shared/themes.ts` owns the typed v1 manifest,
semantic token names, light/dark defaults, schema, and fallback resolver.
`bun run generate:themes` generates the public JSON Schema, initial renderer
CSS defaults, and the shipped token reference; a drift test checks all three.

## Package and selection contract

A directory contains one `theme.yaml`: `schemaVersion: 1`, `id`, `name`, optional
`description`, and required `light`/`dark` override maps. Missing tokens inherit
the corresponding built-in variant. Unknown keys, aliases, invalid value
formats, oversized files, and escaping symlinks are rejected. Colors use hex,
font stacks name installed fonts, radii are bounded, and shadows have a bounded
literal format. No CSS, scripts, assets, downloads, or layout tokens are loaded.

References are `builtin:default`, `global:<name>`, or `./themes/<name>` /
`./themes/external/<name>`. AppSettings stores `theme` and `themeMode`
(`dark|light|system`); old settings retain the built-in dark appearance. The
optional top-level dashboard `theme` overrides the app selection for the entire
window. Only the opened config participates: linked configs and focus do not.
A draft for that config previews its selection and Cancel restores the saved
selection. Appearance mode always remains the user's app setting.

Missing/invalid selections fall through the app default to the built-in theme,
with visible diagnostics. Theme failures do not invalidate the component tree.
Project inspection includes theme catalog metadata. Loading a theme is data
validation and requires no component permissions. Trusted component CSS still
shares the renderer and can override its own presentation; this is not a
hostile-component sandbox.

## Rendering and reload

The main process publishes validated manifests. The renderer applies resolved
values through CSS property assignments and publishes one reactive store.
`useTheme()` is exported through `@dash-bored/component` and returns
`{ reference, appearance, tokens, catalog, errors }`. Existing CSS token names
remain supported. Built-in charts use CSS token references; xterm updates its
options in place, including ANSI colors and font family. Components/processes
are not remounted or restarted by renderer theme selection.

The bundle watcher reloads local themes with the project; unchanged component
revisions retain their mounts. A personal-directory watcher publishes catalog
changes independently of project runtime. App focus and reload also refresh
personal discovery. OS appearance changes only affect System mode. Parent CSS
does not theme embedded websites or change OS-owned window controls.

## Distribution

The theme CLI scaffolds, validates, discovers, and manages packages. It never
selects themes as a side effect of installation. Project git installations are
submodules below the owning bundle's `themes/external/`, pinned in the optional
`themes` section of lockfile version 1. Component commands preserve that
section. Each entry uses `{ url, commit, path }`, with a full SHA and canonical
`themes/external/<name>` path.

Personal packages live in `~/.config/dash-bored/themes/<name>`. This location is
shared by standalone CLI and desktop channels, independent of Electrobun
instance IDs. Personal git installs use managed clones and `pins.yaml`, with
the same lock shape; the entry path is a logical package identifier while the
physical clone is directly under the personal theme directory.

Mutations serialize through a per-store operation lock. Adds validate a staged
checkout before registering a package. Updates validate the target revision,
protect dirty checkouts, and restore the prior checkout if validation or pin
publication fails. Sync restores pinned revisions only; no dashboard load runs
Git fetch/update. Interrupted operation lock directories require explicit
removal after verifying no theme CLI is running. Git-managed package removal
protects local changes; authored local directories are not removed by this CLI.

The Settings Themes tab presents appearance selection and package management in separate, always-visible sections for both personal and current-dashboard scopes,
using the same explicit command-copy workflow as external components. Commands quote
all user arguments and target the canonical config path, including named bundles.
Catalog entries carry validated lock metadata and retain missing pinned packages so
users can discover their source/pin and generate a sync command. Catalog discovery
performs no Git or network operations. Management does not change theme selection.
