# Evals

Two suites that answer different questions about how dash-bored works for
agents in the wild.

| Suite | Question | Status |
| --- | --- | --- |
| [`release-qa/`](release-qa/) | Does a release candidate install, upgrade, and let an external agent set up a first dashboard? | Working release gate. See [docs/release-qa.md](../../docs/release-qa.md); `bun run qa:release`, `bun run qa:release:test`. |
| [`skill/`](skill/) | Does skill revision B make agents build better dashboards than revision A? | Work in progress: the scripts work, agent orchestration is manual. |

## Skill A/B eval

### Idea

A skill's quality only shows in what agents do with it. Run the same realistic
app prompts against two revisions of `skills/dash-bored`, one fresh agent per
run, then check by code what can be checked (validation, source output shapes,
component choices, collateral edits) and read each agent's trace for the rest.
The agents' "where the skill was unclear or wrong" notes are the refinement
signal. This follows the Agent Skills guidance on
[refining with real execution](https://agentskills.io/skill-creation/best-practices)
and [evaluating skills](https://agentskills.io/skill-creation/evaluating-skills).

### Cases

Each fixture exercises one app entry point with the prompt the app actually
sends, built by the app's own prompt functions (`skill/prompts.ts`).

| Fixture | Entry point | Good looks like | Traps |
| --- | --- | --- | --- |
| `acme-api` (Node service, starter dashboard) | **Set up this dashboard** (`starterAgentPrompt`) | Starter replaced; health, Git, and backlog panels backed by sources that print valid shapes; real commands only; icon written | Uninstalled `eslint`/`knex`/`flyctl`, a credentials `.env`, a slow test suite |
| `ledger-tools` (Python service, existing dashboard) | **Change with agent** on a status with hand-written `state: healthy` | Only the target area changes; live health source; uncommitted-files list with a diff item action; legacy `todo-list` untouched | Temptation to write React for health and Git |
| `field-notes` (MkDocs site) | Structural-editor natural-language insert at an occupied tile | A `list` over a small script with an `agent:prompt` item action, inserted as the prompt's placement states | The prompt historically said "build a project-local component" |

### Run

Use an eval directory outside the repository (fixtures are Git repositories):

```sh
sh scripts/eval/skill/setup.sh /tmp/skill-eval 93c5d71   # baseline revision; candidate = working tree
# For every directory in /tmp/skill-eval/runs, start one fresh agent with
# scripts/eval/skill/brief.md (placeholders filled in) and wait for it.
bun scripts/eval/skill/grade.ts /tmp/skill-eval
```

The eval launcher runs this checkout's agent tool and reports the desktop app
as not running, so agents cannot drive or change a real app instance.

### What the grader checks

`validate --json`; new nodes that use retiring builtins; hand-written status
state; titled single-child frames; nodes without IDs; local components; every
`shell` source run through `env -i HOME="$HOME" /bin/sh -lc` (an approximation
of the app's source shell) and checked with the renderer's own shape parsers;
item actions; files changed outside `.dash-bored/`; fixture nodes removed; the
setup icon; and whether a trace was written.

### First result (2026-09-24)

Claude Sonnet subagents, one run per case. Baseline `93c5d71` (the v0.4.0
skill), candidate `3803b47`.

| Fixture | Baseline skill | Candidate skill |
| --- | --- | --- |
| `acme-api` | 2 local React components, `tabs` + 3 `card`, 1 single-child frame | No React, 5 source-backed panels, all valid shapes (re-run after refinement: 1 justified React API console) |
| `ledger-tools` | 2 local React components, `card`, a new `network:http` permission | Status with a curl source, uncommitted-files list + diff runner, no new permission |
| `field-notes` | React component that types prompts into an agent terminal, bypassing the agent composer | `list` over a Python script + `agent:prompt` item action |

All six dashboards validated. Traces led to four refinements (tests run as a
polling source, credential files read during orientation, insertion into an
occupied tile, severity and ID guidance) before the candidate was committed.

### What works

- `setup.sh`: baseline/candidate skill copies, stubbed launchers, three
  deterministic fixtures, run directories, and prompts.
- `prompts.ts`: app-accurate prompts from `starterAgentPrompt`,
  `buildComponentAgentPrompt`, and `buildComponentCreationAgentPrompt`.
- `grade.ts`: the objective checks above, as a Markdown report per run.
- `brief.md`: the instructions each eval agent receives, including the trace
  it must write.

### Work in progress and limitations

- Agent orchestration is manual; the first result used Claude Code subagents.
- Runs are not isolated: sandbox rules live only in the brief, on the host.
- Agents use the dev CLI through `bun src/cli/index.ts`, not the compiled tool;
  `DASH_BORED_TOOL` is unset and `app` commands are stubbed, so no run takes a
  screenshot or sees trust prompts.
- One run per case: no repeats, variance, token counts, or timings.
- The `field-notes` insertion is hand-built in `prompts.ts` and can drift from
  `resolveDashboardInsertion`; `scripts/` is not type-checked.
- Grader heuristics are coarse. A local component is not always wrong, and
  usefulness, labels, and layout still need human review.

### Future

- Fold into `release-qa`'s Docker harness: pinned agent CLI, repeats, the
  evidence directory, and a `--skill-baseline <rev>` A/B mode whose grader
  output pre-fills `review.md`.
- Trigger evals for the skill description, with near-miss queries (starting
  services, deploying, dashboards inside application code).
- JSON results with per-configuration pass rates, deltas, tokens, and time.
- An isolated app instance so runs can screenshot what the user would see.
- More fixtures: a non-software project, a monorepo, a project without Git, a
  large existing dashboard, and a schema migration.

### Todo

- [ ] Script headless agent runs (fresh context per run) instead of manual orchestration.
- [ ] Isolate runs (container or disposable account) and use the compiled tool with `DASH_BORED_TOOL` set.
- [ ] Record tokens, duration, and command/failure counts per run; support repeats.
- [ ] Emit JSON and a baseline/candidate delta alongside the Markdown report.
- [ ] Derive the `field-notes` insertion from `resolveDashboardInsertion`.
- [ ] Add description trigger evals.

Tracked as `todo-eval-skill-suite` in the project dashboard.
