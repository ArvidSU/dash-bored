# Release onboarding QA

Run this suite for a release candidate, separately from per-change QA. It uses
Docker to test the Linux build of the version-matched embedded CLI and skill,
then evaluates an external agent against a small, fixed service project.
It does not install the macOS application or prove native onboarding behavior.

## Run

Requires Docker, Python 3, Git, and committed candidate/baseline revisions.
The host checkout and home are never mounted into the test containers.

```sh
# Install/update correctness without model calls
bun run qa:release --previous v0.2.2 --candidate HEAD

# Live Codex benchmark: CLI 0.153.3, gpt-5.6-luna, JSONL events
# Supply CODEX_API_KEY (or OPENAI_API_KEY) in the invoking environment.
bun run qa:release --previous v0.2.2 --candidate HEAD --live-codex --repeats 3

# Or reuse an existing ChatGPT Codex login (single read-only auth file)
bun run qa:release --previous v0.2.2 --live-codex --codex-auth-file ~/.codex/auth.json

# Harness-only smoke, explicitly not a version-upgrade result
bun run qa:release --previous HEAD --candidate HEAD --allow-same-version
bun run qa:release:test
```

`HEAD` means committed source by default. For remediation before committing,
pass `--candidate-worktree` with `--candidate HEAD`: the harness snapshots
nonignored working files, records their hashes and marks the candidate as a
working-tree build. This is not a tagged release artifact. The run records both
resolved commit IDs and package versions. Equal versions fail unless explicitly
allowed for a harness smoke check. Old revisions must contain a buildable CLI;
unsupported installer syntax or migration conflicts are failures to investigate.
The old global skill is installed using the portable project-path form.

The image explicitly supplies Bun, Node.js, Git and ripgrep for the agent;
Python runs the evidence collector. Each repetition starts two fresh non-root
containers, limited to 2 CPUs, 4 GiB
RAM and 256 processes. Only the run's evidence directory is mounted writable;
there is no Docker socket, host agent configuration, or host project mount.
The Bun image version is pinned; its resolved image and the final built image
identity are captured by Docker build logs and run metadata. OS package mirrors
are not immutable, so retain the built image for exact reruns.

The new-user scenario installs the candidate CLI and skill, checks the installed
version and skill file hashes through the installer's check mode, initializes
and validates the first project, and optionally runs the agent. The existing-user
scenario first installs the previous version and creates a project with local
skills. Replacement copies the candidate CLI into the same app path, preserving
installed symlink semantics. It calls the candidate's actual `updateInstalledTools` function, checks
that existing project data was preserved, records old-dashboard compatibility separately, verifies
refreshed tools, then initializes a separate new project and runs the same agent.
It exercises app-startup tool refresh, not the app replacement itself.

The agent receives the candidate's actual `starterAgentPrompt`. This is a CLI
benchmark of the initial attempt: desktop PTY handling, trust prompts, reload,
and the setup supervisor's bounded repair remain native checklist items.

## Agents and evidence

`--live-codex` authorizes paid calls on each scenario that passes installation.
It installs a pinned provider CLI into the image and passes only the API key
from the host environment. `--codex-auth-file` instead mounts just an existing
login read-only and copies it into the disposable container home, allowing
container-local token refresh without changing the host login. The auth file is
not exported with evidence. Codex uses the disposable container as its sandbox.
For another provider or configuration, use `--agent-setup`, `--agent-command`,
`--agent-version-command`, and optionally `--env-file`. Pin provider versions,
model and reasoning settings when comparing releases. Do not place credentials
in setup commands, command arguments, or image layers.

Every run writes under `artifacts/release-qa/<timestamp>-<id>/`:

- `run.json`: revisions, versions, image ID, provider command and run parameters.
- `harness/`: the exact harness and fixture sources used by this run.
- `summary.json`: per-scenario pass counts, agent attempt/validation counts and median attempt wall time.
- Per-step stdout/stderr and `steps.json`: duration, exit code, timeout and pass.
- Per-scenario `result.json`, shipped skill version/hash receipt, and exact prompt.
- `before/` and `after/`: initialized and final project, including local components.
- `review.md`: pending qualitative review with an evidence-based scoring rubric.

Codex `--json` writes the raw event stream into the agent stdout log. It contains
command activity and provider-reported usage where available. `result.json` also
extracts reported token usage, completed command count and failed command count;
usage remains null when absent. Do not infer cost
or token counts when the provider did not report them. Logs and generated files
can contain sensitive agent output; inspect them before sharing. Credentials and
host session history are not deliberately copied into evidence.

A zero exit requires successful installation checks, correct versions, runnable
fixture commands, and (for live runs) successful agent execution, a changed
bundle and a valid final dashboard. It is not a release approval. Review workflow
coverage, command correctness, discovery behavior, layout, permissions, retries,
and unnecessary work. Record concrete issues and reproduction steps. Compare
like-for-like repeated runs; a single tiny fixture is not representative of all
projects, and timing includes model/network variability.

## macOS release checklist

Use disposable macOS accounts or VM snapshots on supported Apple Silicon hardware.
Record the release tag, DMG checksum, OS version, screenshots and command logs.

1. Run `bun run build:release` and `bun run release:prepare -- --tag vX.Y.Z`.
   Verify the staged checksum, bundle version, embedded CLI version and signature.
2. New account: install the DMG into Applications, follow the documented unsigned
   first-launch flow, open an uninitialized fixture project and verify its starter.
3. Install global CLI and skill from the visible setup controls. Check their
   versions, reopen the app and confirm the setup controls reflect installation.
4. Choose Codex/luna, run **Set up this dashboard**, retain Agent work output,
   inspect the final dashboard and run its test/build controls. Verify trust
   changes remain explicit. Exercise a controlled invalid configuration to check
   the bounded repair and its output, separately from the timed baseline.
5. Existing account: install the previous DMG, create a dashboard, install CLI
   and both global/project skills. Save hashes of project data. Quit, manually
   replace the application with the candidate, and launch it again.
6. Verify the app/CLI/skill versions, preserved existing dashboard and settings,
   refreshed installer-owned files, and visible conflicts for deliberately edited
   skill files. Never resolve conflicts by silently overwriting local edits.
7. Initialize a new fixture project after updating and repeat the agent workflow.
   Record visual usefulness and failures independently from Docker results.

App auto-update is currently disabled. Manual replacement is the supported update
cycle; a green Docker run cannot establish DMG, Gatekeeper or native UI success.

### Legacy dashboard compatibility

A v0.2.2 project uses schema v1 in `dash-bored/`; refreshing its CLI and skills
does not migrate that dashboard to schema v2. The compatibility check remains a
failed release gate, but the suite continues through new-project initialization
and the agent benchmark so that old-format incompatibility cannot mask those
results. Preserve the legacy bundle and use the README recovery workflow to
rebuild a separate schema-v2 dashboard. Do not change the old config's version
number alone: its component and composition contracts also differ.
