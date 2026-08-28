[IDEA.md](./IDEA.md) guides implementation, if plans, prompts, code or documentation etc. conflicts, stop and resolve the conflict by either changing IDEA.md to reflect a new or updated direction or adjust the plan, prompt, code or documentation.

[ARCHITECTURE.md](./ARCHITECTURE.md) Should guide, reflect and be kept up to date with actual implementation.

Dog food this project and its features by adding components with sane configurations in the project dashboard.

## Quirks and operational know-how

Keep this section current with verified, repository-specific behavior that is
easy for another agent to miss. Prefer short notes that explain the surprising
behavior, its practical consequence, and the safe way to handle it.

- A directory opened through the desktop chooser is the project root, even
  when that directory itself is named `dash-bored`; app-owned files belong in
  its nested `dash-bored/` directory. CLI `dash-bored open` treats a project
  root as the canonical dashboard and a standalone bundle directory as that
  bundle; an explicit `dash-bored.yaml` path is always unambiguous. It passes
  `DASH_BORED_CONFIG_PATH` alongside the project root; keep both values when
  changing launch or release plumbing.
- The desktop sidebar's **Add dashboard** chooser selects directories. Its
  `auto` resolution opens a nested `dash-bored/` as a project root, or a
  direct `dash-bored.yaml` as that standalone bundle. Each selected config is
  remembered as its own sidebar entry, even when multiple entries share one
  project root.
- The starter dashboard's `install-skill .` action installs the portable skill
  for that project under `.agents/skills/` and links Claude's project path;
  `install-skill --global` targets the current user's `~/.agents/skills/` and
  `~/.claude/skills/` paths instead. Both modes refuse to replace modified
  payloads or conflicting directories.
- Opening a project creates only missing canonical `dash-bored/` artifacts and
  preserves existing configuration and lock files. Plain `dash-bored init`
  remains strict; `dash-bored init <name>` preserves or repairs the canonical
  bundle and strictly creates a self-contained named bundle with its own lock
  and `components/` directory. Multiple positional names are successive bundle
  directories (`init arvid cicd` creates `dash-bored/arvid/cicd/`).
- `bun run qa` starts with `electrobun prepare`. If a desktop development
  process is already running, Electrobun may wait for its project build lock.
  Do not terminate a user-owned dev process just to obtain the lock. With the
  generated Hutch files already present, use `bunx tsc --noEmit`, `bun test`,
  and `bunx vite build` for non-locking checks, and report that substitution.
  macOS does not provide the usual `timeout` command; use a TTY/interruption
  or a compatible timeout, inspect existing `npm run dev`/Electrobun/Vite
  processes before starting another one, and clean up only processes you
  launched.
- In-app dashboard edits are draft-first. Save validates the whole tree,
  compares the source revision, and atomically rewrites canonical YAML; stale,
  invalid, or trusted-local compilation failures must leave the file unchanged.
- Config-link components may use relative or absolute bundle paths. A broken
  target is rendered as a local component error instead of invalidating its
  source dashboard; focusing linked content before editing selects the linked
  bundle's YAML as the single atomic save target.
- Dashboard deletion is registry-first: the renderer previews direct and
  transitive config links before offering file cleanup, and incomplete
  dependency analysis disables cleanup. Only the canonical project-root
  `dash-bored/` directory may be moved to OS Trash; active deletion unloads
  watchers/processes and restores registry, trust, and runtime state if cleanup
  fails.
- The dashboard editor is structural; component-specific content belongs in
  Configure. In particular, `@dash-bored/tabs` stores one `props.labels` entry
  per child in positional order, so insert/remove/reorder operations must move
  labels with their panels and the tab fields/add/remove controls belong in its
  Configure modal.
- At narrow widths the expanded sidebar is a fixed overlay while the app frame
  remains in the grid. Keep the app frame explicitly in grid column 2 and test
  both collapsed and expanded narrow states; otherwise CSS auto-placement can
  put the content in the sidebar column and collapse it to roughly 58px.
- Native `<electrobun-webview>` elements are separate window overlays, not DOM
  descendants. CSS hiding an ancestor does not hide the native surface; the
  built-in tabs renderer must propagate panel visibility so webviews initialize
  only when visible and call `toggleHidden` plus `syncDimensions` when tabs
  change.
- A renderer harness or semantic app-state probe does not prove native desktop
  interaction. If the Mac is locked or modifier-key injection is unreliable,
  verify the native menu path and renderer handler separately, and report the
  missing native coverage instead of presenting it as a completed smoke test.
- `bun run build` is worktree-local and may intentionally inherit
  `.env.worktree`. Use `bun run build:release` for distributable artifacts; it
  strips worktree project, server, port, and instance variables. Then run
  `bun run release:prepare -- --tag v<package.json version>`: it rejects a
  worktree bundle identifier, a mismatched tag/version/CLI, or an invalid DMG.

## Worktree development

- Run `bun run worktree:setup` once in every new worktree. It installs the frozen
  Bun lockfile, prepares missing Hutch/Electrobun files, creates the ignored
  `.env.worktree`, and validates the dashboard.
- `.env.worktree` assigns a deterministic local Vite port, project root, and
  Electrobun development identifier. `bun run dev`, `bun run dev:desktop`, and
  build commands load it automatically; do not copy another worktree's
  `.hutch`, `node_modules`, or `.env.worktree` into this one.
- If `bun run dev` is already serving the worktree, `bun run worktree:setup`
  reuses that session's prepared Hutch files instead of invoking a second
  `electrobun prepare` that would wait on the dev reader lock.
- Use `bun run qa:fast` when Hutch is already prepared but another user-owned
  desktop development process holds Electrobun's build lock. Do not terminate
  that process to make QA proceed; report the substituted checks and any
  missing generated files.
