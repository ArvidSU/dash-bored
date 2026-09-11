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
checksum file, and release notes. The DMG, full update archive, metadata, guidance, and checksums become GitHub
Release assets. Electrobun's update archive and metadata are
published with version-matched migration guidance by the unified update pipeline.
Downloads and installation remain user initiated. Direct unsigned replacement
uses the verified native updater with a DMG fallback.

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

- npm, registry, or marketplace component resolution
- marketplace component search, publishing, or shared templates; direct
  in-process component generation without the configured external agent
- Linux, Windows, and Intel Mac distribution; Windows shell-link installation
- Developer ID signing, notarization, and independent update signing
- general project-file editing and a general process viewer
- simultaneously active multi-project views or windows
- embedded model-provider infrastructure or agent-specific SDK integration
- claims of hostile-code or per-component isolation for trusted local components

These can be added only after their contracts are reflected here and remain
consistent with the product principles in [Product vision](../IDEA.md).

## Release onboarding evidence

The opt-in `scripts/release-qa/` harness compiles pinned source revisions into
Linux CLI test images. Fresh non-root containers exercise CLI and skill installs,
the candidate app startup tool-refresh function, project initialization and an
optional external agent using the shipped starter prompt. It records correctness
and timing separately from qualitative review. It does not add Linux distribution
or replace macOS packaging and native checks. See the
[release QA workflow](../release-qa.md) for commands, evidence and the macOS checklist.

## Unified update release contract

`src/shared/app-metadata.ts` owns product identity and version. Executable names,
bundle identifiers and existing paths remain compatible; dashboards keep their
user-defined names. `src/shared/updates.ts` defines the public release and receipt
formats. `src/updates/releases.ts` discovers GitHub HTTPS releases, excludes
drafts and older versions, validates canary/macOS/arm64 identity and cumulative
recipes, and rejects incomplete metadata. Publication adds the native full
archive, native manifest, `dash-bored-release.json`, `MIGRATIONS.md`, and SHA-256
checksums alongside the verified DMG. No independent signing is claimed.

App and CLI share `~/.config/dash-bored/updates/`. Settings contain the selected
channel and startup/24-hour check preference. Canary is available; Beta and
Stable are rejected. Downloads never happen on scheduled checks. A future
channel-enablement package will publish beta/stable, default new installs to
stable, and explicitly define transitions for existing canary users without
silently switching them.

The coordinator serializes mutations with an atomic directory lock. An explicit
recovery action removes a stale lock only after its recorded owner has exited.
Receipts store the selected target, explicit dashboard paths, migration choice,
separate installation and migration outcomes, and recovery paths. Atomic
cancellation markers bypass the operation lock, so cancellation can interrupt a
download or stop an agent. A durable running claim precedes any migration edits;
restart marks it interrupted and never replays it automatically. Only pending,
non-cancelled combined authorization continues in the exact target version.

Installation stages and verifies the DMG fallback. The app offers Restart and
install through the native updater after the user resolves drafts and finishes
running work. The CLI opens the verified DMG without requiring an app window.
Both preserve normal macOS approval. Source
checkouts and independently copied CLI binaries receive manual-install guidance.
A running app blocks CLI installation; app installation rejects active terminals
and agent tasks. A managed shell link follows the bundled CLI when the app is
replaced. App startup refreshes existing owned skills and CLI links.

`native-updater.ts` adapts the existing Electrobun updater to a version-pinned
loopback mirror of SHA-256-verified artifacts. It retains native quit approval,
staging, replacement and recovery. `DIRECT_UNSIGNED_UPDATES_VERIFIED` is enabled after the 2026-09-08 isolated
unsigned 99.0.1-to-99.0.2 replacement, relaunch and bundled-CLI acceptance test.
The repair pipeline emits USTAR without macOS PAX attributes, which the native
extractor rejected in the first real test. Downloaded-DMG Gatekeeper approval
remains a separate manual verification boundary; no security bypass is added.
The gate cannot be changed by remote release metadata. The verified DMG remains
available if native preparation or replacement fails.

## Migration and agent verification

The current dashboard contract is 3, with minimum migratable contract 2.
The embedded v2-to-v3 recipe removes topology wrappers and redundant ratios,
preserving component nodes, edge metadata, binary grouping, and explicit
horizontal widths. Component manifests remain at version 2. Subsequent
contract changes must update the embedded cumulative recipes and minimum
supported contract together with the actual schema implementation.
Unknown/older unsupported schemas stay diagnosable even when the dashboard
cannot load. Migration dispatch requires the target executable and its exact
embedded recipes, existing project trust, a matching CLI, a recoverable copy of
the dashboard bundle and a read-only skill/reference handoff. Skill ownership
receipts refresh existing installs while preserving customizations. Conflicts
are passed to the agent; the target handoff remains usable without an install.

Setup, component edits, component creation, diagnostics repair and migrations
use `DashboardSetupSupervisor.launchRequest`. The shared supervisor validates
with local compilation after agent work, permits at most one corrective attempt
following clean execution and repairable errors, and stops for cancellation,
failed execution, missing tools, session changes or new permissions. Migrations
preserve snapshot paths even if execution fails. Restoration is an explicit
review-and-copy workflow; the application never overwrites a user's current
bundle automatically.
