# dash-bored - Architecture: Distribution and exclusions

## macOS prerelease distribution

The initial distribution boundary is an unsigned Apple Silicon prerelease for
macOS 14 or newer. Linux, Windows, and Intel Mac artifacts are not produced.
`package.json` is the single source of truth for the application version; the
Electrobun configuration, standalone CLI, release tag check, packaged app, and
update metadata must all agree with it.

Pull requests and pushes to `main` run QA and dashboard validation on GitHub's
`macos-15` Apple Silicon runner. A `v*` tag starts the release workflow, but the
tag must exactly equal `v<package.json version>`. The workflow creates a draft
GitHub prerelease so publishing remains an explicit maintainer decision.

`bun run build:release` uses the Electrobun canary channel, which keeps these
early installs separate from a future stable, signed application. Unlike a
normal worktree build, it strips `DASH_BORED_PROJECT_ROOT`,
`DASH_BORED_CONFIG_PATH`, development-server,
port, and instance variables before packaging. This prevents a local worktree
identifier or project path from becoming part of a release.

The macOS bundle uses the project-owned dashboard artwork in `assets/icon.svg`.
Its committed `assets/icon.iconset/` renditions are converted to
`Contents/Resources/AppIcon.icns` by Electrobun, while `CFBundleIconFile`
references `AppIcon`; that pair is what Finder and the Dock use for the app.

`bun run release:prepare -- --tag <tag>` fails closed unless all of the
following hold:

- the host is Apple Silicon macOS and the tag matches the package version;
- the build app, expanded update app, and DMG app carry the release bundle
  identifier and version, an arm64 launcher, and the expected Finder/Dock icon
  metadata and `.icns` resource;
- Electrobun's update manifest describes the same macOS arm64 canary and names
  the generated full-app archive;
- the expanded application contains a runnable, version-matched standalone
  `dash-bored` CLI; and
- the DMG mounts successfully and contains the app plus its Applications link.

The preparation step stages a versioned `*-macos-arm64-unsigned.dmg`, a SHA-256
checksum file, and release notes. Only the DMG and checksum become GitHub
Release assets. Electrobun's update archive and metadata are validation inputs,
not a public update channel; application auto-update remains disabled.

Because the DMG is neither Developer ID signed nor notarized, first launch may
require the user's explicit **Open Anyway** decision in macOS Privacy & Security.
Release packaging still applies a valid ad-hoc bundle signature and verifies it
on the app, update archive, and DMG copies; this prevents macOS from reporting a
malformed bundle as damaged while retaining the unsigned-prerelease boundary.
Release documentation must state that friction and must not present the build
as a trusted broad-consumer installer. Signing and notarization can later be
inserted into the same build-and-verify boundary without changing the project
or bundled-CLI contracts.

## Deliberate exclusions

The following are not part of this architecture yet:

- npm, Git, registry, or marketplace component resolution
- marketplace component search, publishing, or shared templates; direct
  in-process component generation without the configured external agent
- Linux, Windows, and Intel Mac distribution; Windows shell-link installation
- Developer ID signing, notarization, or application auto-update
- general project-file editing and a general process viewer
- simultaneously active multi-project views or windows
- embedded model-provider infrastructure or agent-specific SDK integration
- claims of hostile-code or per-component isolation for trusted local components

These can be added only after their contracts are reflected here and remain
consistent with the product principles in [Product vision](../IDEA.md).
