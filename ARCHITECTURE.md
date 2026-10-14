# dash-bored - Architecture index

The architecture is split into focused documents so each contract can be found
and edited without navigating one monolithic file. These documents are the
source of truth for implementation decisions, contracts, and invariants.

For a scoped change, read only the page that owns the code you touch; read the
pages in this order only when a full system view is needed:

| Page | Owns | Read it when you change |
| --- | --- | --- |
| 1. [Runtime and boundaries](./docs/architecture/runtime.md) | Process layout, renderer boundaries, push-only RPC state, dev-instance isolation | `src/main/` wiring, RPC contracts, `scripts/dev*.ts`, anything crossing main/renderer |
| 2. [Project contract](./docs/architecture/project-contract.md) | Bundle layout, YAML schema, prompt templates, in-app editing, lock files, legacy migrations | `src/core/` config, tree, and project files; `src/migrations/`; dashboard YAML semantics |
| 3. [Component system](./docs/architecture/components.md) | Resolution, manifests, package store, SDK, local React compilation | `src/core/` component and package code, `src/component-api/`, the SDK generators |
| 4. [Security and capabilities](./docs/architecture/security.md) | Trust, host APIs, permissions, agent-control channel, supervised processes | Trust, permissions, host capability handlers, `src/main/agent-control-*.ts`, process supervision |
| 5. [Renderer and shipped examples](./docs/architecture/renderer.md) | Renderer module map, shell, navigation, composition UI, action store and palette, visuals | `src/renderer/` (start with its module map) |
| 6. [Lifecycle and agent tools](./docs/architecture/lifecycle-cli.md) | Reload and failure model, the agent tool CLI, app control channel | `src/cli/`, `app` subcommands, the skill launcher |
| 7. [ACP client](./docs/architecture/acp-client.md) | Agent selection and detection, ACP sessions, permissions, validation and repair, hand-off | `src/main/acp-connection.ts`, `agent-sessions.ts`, `agent-launch.ts`, `agent-detection.ts`, `agent-preflight.ts`, `agent-handoff.ts`; the Agent work UI |
| 8. [Distribution and exclusions](./docs/architecture/distribution.md) | macOS packaging, updates and migrations, deliberate exclusions | `src/updates/`, release scripts, `electrobun.config.ts` |
| [Themes](./docs/architecture/themes.md) | Theme packages, selection, rendering, distribution | `src/shared/themes.ts`, theme CLI and settings |
| [Attention animations](./docs/architecture/attention.md) | `attention:<node>`, animation packages, playback | `src/shared/animations.ts`, `src/core/animations.ts`, `src/renderer/lib/attention.ts`, animation CLI |

Product intent lives in [docs/IDEA.md](./docs/IDEA.md). User-facing setup,
commands, and workflows live in [README.md](./README.md). Releases and release
QA live in [docs/release-qa.md](./docs/release-qa.md); planned work packages in
[docs/roadmap/](./docs/roadmap/atoms.md).
