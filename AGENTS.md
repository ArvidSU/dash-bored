[IDEA.md](./IDEA.md) guides implementation, if plans, prompts, code or documentation etc. conflicts, stop and resolve the conflict by either changing IDEA.md to reflect a new or updated direction or adjust the plan, prompt, code or documentation.

[ARCHITECTURE.md](./ARCHITECTURE.md) Should guide, reflect and be kept up to date with actual implementation.

Dog food this project and its features by adding components with sane configurations in the project dashboard.

## Quirks and operational know-how

Keep this section current with verified, repository-specific behavior that is
easy for another agent to miss. Prefer short notes that explain the surprising
behavior, its practical consequence, and the safe way to handle it.

- A directory opened through the desktop chooser or passed to `dash-bored open`
  is the project root, even when that directory itself is named `dash-bored`.
  App-owned files belong in its nested `dash-bored/` directory. An explicit
  `dash-bored.yaml` path is the unambiguous way to open by configuration path.
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
- In-app dashboard edits are draft-first. Save validates the whole tree,
  compares the source revision, and atomically rewrites canonical YAML; stale,
  invalid, or trusted-local compilation failures must leave the file unchanged.
- Config-link components may use relative or absolute bundle paths. A broken
  target is rendered as a local component error instead of invalidating its
  source dashboard; focusing linked content before editing selects the linked
  bundle's YAML as the single atomic save target.
