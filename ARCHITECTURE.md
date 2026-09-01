# dash-bored - Architecture index

The architecture is split into focused documents so each contract can be found
and edited without navigating one monolithic file. These documents are the
source of truth for implementation decisions, contracts, and invariants.

Read the pages in this order for a full system view:

1. [Runtime and boundaries](./docs/architecture/runtime.md) — process layout,
   renderer boundaries, snapshots, and proof surfaces.
2. [Project contract](./docs/architecture/project-contract.md) — bundle
   layout, YAML schema, editing, persistence, and lock files.
3. [Component system](./docs/architecture/components.md) — resolution,
   manifests, local React, and compilation.
4. [Security and capabilities](./docs/architecture/security.md) — trust,
   host APIs, permissions, and supervised processes.
5. [Renderer and shipped examples](./docs/architecture/renderer.md) — built-ins,
   composition UI, dashboard navigation, and the action registry.
6. [Lifecycle and CLI](./docs/architecture/lifecycle-cli.md) — reload,
   failure handling, and command-line behavior.
7. [Distribution and exclusions](./docs/architecture/distribution.md) — macOS
   packaging, release verification, and deferred scope.

Product intent lives in [docs/IDEA.md](./docs/IDEA.md). User-facing setup,
commands, and workflows live in [README.md](./README.md).
