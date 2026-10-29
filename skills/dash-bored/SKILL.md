---
name: dash-bored
description: Use this skill to build, extend, fix, or check a dash-bored dashboard — a local, project-owned cockpit in .dash-bored/dash-bored.yaml that shows a project's live state and turns its recurring commands, docs, and checks into one-click panels. Use it whenever the user wants such a persistent overview or control panel for a project (what is running, healthy, changed, or next; buttons to start, test, or release it), or mentions dash-bored, .dash-bored/, dash-bored.yaml, or a project cockpit, even without naming dash-bored. Also use it to author, type-check or publish standalone components with the versioned component SDK, add panels or source scripts, repair validation errors, migrate a dashboard after an app update, or operate the running app. Not for the project's own work (starting services, deploying, running tests) when no dash-bored component, dashboard, or app is involved, for dashboard UIs in the user's own application code, or for Grafana/BI dashboards.
---

# dash-bored

Your job is to give the user an overview of their project they can trust at a
glance, plus one-click access to the work they repeat. A new user should
understand every panel without a tutorial; a returning user should find "where
does this stand and what do I do next?" in seconds. The project may be
software, docs, research, ops, or anything with files and commands: work from
what it actually contains, not from a generic template.

The user works in the dash-bored desktop app; you work through this skill's
tool. For dashboards, `dash-bored.yaml` is the source of truth. For standalone
components, work in the component's manifest, sources and assets.

## Running the tool

`dash-bored` is **not** on `PATH`. Run this skill's launcher by its absolute
path in every command, for example
`~/.agents/skills/dash-bored/scripts/dash-bored inspect . --summary` (use the
directory this SKILL.md is in), written out each time: most agent shells do
not keep variables between commands. Exit 127 means the app is missing: ask
the user to install and open dash-bored once. In a checkout of the dash-bored
repository itself, use `bun run dash-bored -- <command>`. Below, `dash-bored`
means the launcher. Commands inside the dashboard (a `command` prop, a
source's `shell`) run in the app, where the tool is `"$DASH_BORED_TOOL"`.

## Match the request

| Request | What to do |
| --- | --- |
| Author, scaffold, check or publish a standalone component, or work in a component repository | [Standalone component authoring](references/components.md#standalone-component-authoring): API discovery and SDK setup first; preview in a dashboard later |
| Build or set up a dashboard, or replace the starter | The full workflow below |
| Change a node "from its component context menu" (the prompt names a target component) | Change only that node as the request needs; read the owning YAML and the files the request names, not the whole project. Then steps 3–7 |
| Add a component at a YAML insertion path from the structural editor | Make exactly the edit its `Placement:` line states. Prefer a core view fed by a source script (step 4); write a local component only when no view can present it |
| Fix listed diagnostics | Fix each at its file and path, then steps 5–7 |
| After an app update, or an old `schemaVersion` | [references/migrations.md](references/migrations.md), starting with `dash-bored migrate inspect <dashboard>` |
| Use the running app: run a button or command, read a panel, explain why something is red or failed | [references/running-app.md](references/running-app.md); change no YAML |

## Workflow

```text
- [ ] 1. Orient: read the project and the existing dashboard
- [ ] 2. Plan the overview: questions → panels
- [ ] 3. Compose the YAML
- [ ] 4. Back every observed panel with a source, and run each source yourself
- [ ] 5. Validate until clean
- [ ] 6. Look at it in the app; fix what looks wrong
- [ ] 7. Report
```

### 1. Orient

- Read the project's agent instructions and README, then the one or two files
  that define how work gets done (`package.json` scripts, `Makefile`, compose
  files, CI workflows, a runbook); read more only to answer a specific
  question. Never read credential files (`.env`, `.envrc`, secrets configs)
  or run commands that print resolved secrets (`docker compose config`): a
  file's name is enough to plan panels. Do not read the dash-bored
  application's source; this skill and the catalog are authoritative.
- Run `dash-bored inspect . --summary`. Without a dashboard it exits 1 with
  `FILE_NOT_FOUND` for `dash-bored.yaml` and `dash-bored-lock.yaml`; then run
  `dash-bored init .`. The starter is onboarding plus a component tour:
  replace its whole `root` tree rather than adapting it, and keep the
  generated `.env` (it holds the user's agent choice).
- If a dashboard exists, read its `dash-bored.yaml` fully. Keep what the user
  built; change only what the request needs.
- If the app is running, `dash-bored app status` tells you which dashboard is
  open, which node is focused, and whether the user has an unsaved draft.

### 2. Plan the overview

List the questions this user will bring, and answer each with the smallest
panel that answers it from real project data. Keep the ones the project gives
you evidence for:

| Question | Default panel |
| --- | --- |
| What is this and how is it organized? | `markdown` with `path:` to the README or a runbook |
| Is it running / healthy? | `status` whose `source.shell` runs one bounded check |
| What changed recently? | `list` over a script that emits Git items, with an item action to inspect one |
| How do I start, test, build, or deploy it? | One `command` per real script or task; a `button` action bar for the frequent ones |
| Where is the local UI or docs site? | `webview` on its `http(s)://` URL |
| Which settings does it need? | `env` on the bundle's `.env`, for non-secret values (see Gotchas) |
| What is next? | `markdown` on the repo's own tracking file; `list` with `todos` only for items nothing else tracks |
| Numbers over time? | `chart` with a `source` |
| Hand work or a judgment call to the agent? | A button or item action running `agent:prompt`; a `prompts/<name>.md` template when the briefing repeats (`inspect --summary` lists existing `promptTemplates`) |

Group panels into tabs by workflow, with an **Overview** tab first that
answers "where does this stand" without scrolling. Put explanations next to
the controls they explain. Skip any panel you cannot back with real data; an
honest small dashboard beats a full one with placeholders. A documented
command that cannot work (missing script or tool) is left out or labeled as
such, and listed under **Needs you** in the report.

### 3. Compose

Look up each component's contract before you write it:
`dash-bored inspect . --component <ref>`, or
[references/builtins.md](references/builtins.md) for every core component.
Never guess props from a component's name. A valid dashboard in the
recommended shape:

```yaml
schemaVersion: 4
name: Example
icon: ./assets/icon.svg
root:
  id: cockpit
  component: "./components/external/core/group"
  children:
    axis: vertical
    first:
      node:
        id: section-tabs
        component: "./components/external/core/button"
        props:
          variant: tabs
          items:
            - { name: Overview, action: "select:sections/overview" }
            - { name: Develop, action: "select:sections/develop" }
    second:
      node:
        id: sections
        component: "./components/external/core/selection"
        props: { defaultChild: overview }
        children:
          - metadata: { label: Overview }
            node:
              id: overview
              component: "./components/external/core/group"
              props: { title: Where things stand }
              children:
                axis: vertical
                first:
                  node:
                    id: working-tree
                    component: "./components/external/core/status"
                    props:
                      label: Working tree
                      source: { shell: sh .dash-bored/scripts/working-tree.sh, every: 10000 }
                second:
                  axis: horizontal
                  ratio: 0.6
                  first:
                    node:
                      id: recent-commits
                      component: "./components/external/core/list"
                      props:
                        title: Recent commits
                        sort: source-order
                        source: { shell: python3 .dash-bored/scripts/recent-commits.py, every: 30000 }
                        itemActions:
                          - name: Show
                            action: { run: "component:show-commit:run", with: { sha: "${item.sha}" } }
                  second:
                    node:
                      id: show-commit
                      component: "./components/external/core/command"
                      props: { label: Show selected commit, command: 'git --no-pager show --stat "$DASH_ITEM_SHA"' }
          - metadata: { label: Develop }
            node: { id: develop, component: "./components/external/core/command", props: { label: Run tests, command: npm test } }
```

Composition rules:

- An `action` is a reference string, or `{ run: <reference>, with: {...} }`
  for arguments. References name nodes by ID:
  `select:<selection-id>/<child-id>` switches a `selection`; `reveal:<id>`
  expands and selects a node anywhere (`with: { item }` also focuses a list
  item inside it); `attention:<id>` reveals it and animates it
  (`with: { animation?, message?, item? }`); `focus:<id>` makes it the page;
  `process:<command-id>` runs a `command`; `component:<node-id>:<action-id>`
  runs a declared action (a view's `refresh`, a command's `run`);
  `agent:prompt` with `with: { prompt, template?, vars? }` prefills the agent
  composer for the user to send. Without `template` it briefs project work;
  `template: dashboard` briefs a dashboard change. Bundle templates live in
  `prompts/<name>.md` ([references/sources.md](references/sources.md#agent-prompt-templates)).
- Managed-child labels live on the edge (`metadata: { label }`). Tiled
  children are one `{ node }` edge or a split: `axis`, `first`, `second`;
  nest splits for more than two. Horizontal splits may set `ratio`
  (0.1–0.9, default 0.5 — omit it when equal); vertical splits never do.
- Give every node a stable, unique `id`; validation rejects references to
  unknown IDs.
- A `group` with a `title` frames two or more related panels. Never wrap a
  single panel in one: it only adds a frame, and validation does not catch it.
- Don't add components marked `retiring` in `inspect --summary`,
  `inspect --component <ref>`, or
  [references/builtins.md](references/builtins.md); use the replacement named
  there. Leave existing uses alone unless asked.
- Paths in props (`path`, `cwd`, source `file`, script paths) are relative to
  the project root (the directory containing `.dash-bored/`). The top-level
  `icon` resolves from the bundle and is not validated: write a small,
  geometric SVG with no scripts to `.dash-bored/assets/icon.svg`.
- Edit the existing YAML in place, or replace the whole file atomically.

Write a local React component in `components/<name>/` only when no view can
present the answer: input beyond buttons, a custom visualization, or logic
that must run in the panel. Read
[references/components.md](references/components.md) by section (**Local
component layout**, **TSX contract**, **HTTP and bounded shell payloads**;
**Child projection and managed tabs** only for containers). Declare only the
permissions the code uses, and leave `renderMode` out. Manifests need
`schemaVersion: 3` and an exact stable-semver `apiVersion` the app supports
(`dash-bored component api` shows its offline SDK). Scaffold with
`component init`, keep editor configuration with `component setup`, and run
`component check` before dashboard validation.

### 4. Back observed panels with sources

A value typed into YAML goes stale, so anything that can change comes from a
`source` (`shell`, `file`, `http`, `process`, or `inline`, plus `every`,
`timeoutMs`, `cwd`, `env`). For each observed panel:

1. Find the command that answers the question. A source runs whenever its
   panel is shown and on every poll, so it must be a read-only check that
   finishes in seconds; tests, builds, installs, and writes belong in a
   `command`.
2. Pick the view by the shape you can print. `status`:
   `{"state": "unknown|healthy|warning|error", "detail": "..."}`. `list`: an
   array of `{"id", "title", ...}` with unique, stable string IDs. `chart`:
   `{"labels": [...], "series": [{"label", "values"}]}`. `markdown`: text,
   rendered as Markdown (print bullets or a fenced block; bare lines merge).
3. Keep a short check inline. Anything that builds JSON from arbitrary text
   goes in a script under `.dash-bored/scripts/`: POSIX `sh` when `printf`
   suffices, otherwise `python3`. Print only the result on stdout; on
   failure, exit nonzero with a short reason on stderr, which the panel shows.
4. Run the exact `shell` string as the app will, from the project root:
   `env -i HOME="$HOME" /bin/sh -lc '<shell>'`, and check the output against
   the shape. Validation never runs sources; this is your only check before
   the user sees the panel.
5. Set `every` (ms, 1000–300000) for anything that changes; without it the
   view reads once when shown.
6. Only if the user should hear about a change while this dashboard isn't
   open (a red CI run, a new urgent item), add a node-level `watch`. It needs
   the `background:watch` permission, so the user approves trust again.

[references/sources.md](references/sources.md) has the full source contract,
tested example scripts, list item actions, watches, and the app's shell
environment.

### 5. Validate

1. For any local component, run `dash-bored component check <directory>`.
2. Run `dash-bored validate . --json`. It checks YAML, props, IDs, action and
   process references, item templates, and permissions, and compiles local
   components; it never executes sources or components. Use `--json`: the
   text output omits each diagnostic's `path`.
3. Fix each cause and rerun until `"ok": true`. Do not stop on a failing
   dashboard: the app keeps showing the last valid one, so your change would
   be silently missing.
4. Run `dash-bored inspect . --summary` and compare `permissions` with what you
   meant to add. Each new permission makes the user re-approve trust.

### 6. Look at it

Validation proves the YAML is correct, not that the dashboard is useful. When
the app is running:

1. `dash-bored app status`: note the open dashboard, `focusedNodeId`,
   `trust`, and `diagnostics.items` (runtime errors validation cannot see).
2. If a different bundle is open, `dash-bored app open .` (refused while the
   user has unsaved dashboard changes or a save in progress; ask them to save
   or cancel, or wait for the save).
3. `dash-bored app screenshot --node <node-id>` for each panel you changed,
   then view the PNG path it prints. Check that labels make sense, nothing is
   empty or truncated, no panel shows "Source shape" or "Command failed", and
   the Overview answers its questions.
4. Fix, validate, and screenshot again until it reads well.

For running actions, screenshot failures, restoring the user's view, and
handing a result or blocker back with `notify:<node-id>`, read
[references/running-app.md](references/running-app.md). If you could not look,
say so in the report rather than implying you checked visually.

### 7. Report

End with a short summary in this shape:

```markdown
**Dashboard:** <bundle path> — <one line on what it now shows>
**Tabs:** <tab>: <what it answers>; ...
**Needs you:** <trust approval for new permissions, Screen Recording, a draft to save, a tool missing from the app's PATH — or "nothing">
**Not verified:** <what you could not run or see, and why — or "nothing">
```

## Gotchas

- **Protect unsaved dashboard changes.** While `app status` reports
  `editing: true`, ask the user to save or cancel, or wait for their save,
  before writing YAML.
- **The app's shell is not your shell.** Sources run `/bin/sh -lc` without
  your rc files, so nvm, pyenv, or asdf interpreters are missing there and
  fail with `Command failed (exit 127)` (commands, which open the user's
  interactive `$SHELL`, do load them). Never hard-code a personal absolute
  path into shared YAML; report the missing tool instead.
- **One run at a time per `command`.** A `process` source reports its latest
  run's exit code.
- **Item templates are whole values.** `"${item.sha}"` works;
  `"commit ${item.sha}"` is rejected. A `command` receives each argument as
  `DASH_ITEM_<ARG>` (upper-cased): quote it (`"$DASH_ITEM_SHA"`) and never put
  `${item.…}` in command text.
- **`markdown` with `path:` requests file read and write permission**, even
  when used read-only.
- **Commands never auto-start.** Don't start long-running processes just to
  take a screenshot.
- **New permissions pause the dashboard.** Until the user re-approves trust,
  the app renders layout and inline content only, so a screenshot shows that
  untrusted state, not a broken dashboard.
- **App state is not YAML.** Draft Save/Cancel, collapse, focus and selection
  state, shortcuts, favorites, and agent tasks belong to the app; don't invent
  keys for them. [references/app-runtime.md](references/app-runtime.md) covers
  them when a request involves one.
- **The bundle `.env` is data, not shell.** The app loads it for commands and
  sources in that bundle; don't `source` it. Never put secrets in YAML or in a
  source's output, and never point an `env` panel at a file that holds
  credentials: the panel shows its values on screen, and `.env` is not
  git-ignored by default.

## Other tasks

- **Named dashboards** for a person or workflow: `dash-bored init <name>`
  creates a standalone bundle under `.dash-bored/<name>/`. Show it inside
  another dashboard with its path as a component (`component: "./<name>"`);
  bundles never merge or inherit.
- **External components or themes from Git**, only when asked: the
  `component` and `theme` commands pin exact commits (see `--help`).
- **Themes**: `dash-bored theme init <name>` scaffolds
  `themes/<name>/theme.yaml` (`light` and `dark` token maps that inherit
  every default, listed in
  [references/theme-tokens.md](references/theme-tokens.md)); check it with
  `dash-bored theme validate <directory>`. Select a theme with the top-level
  `theme:` (`builtin:default`, `builtin:neon-dusk`, `global:<name>`,
  `./themes/<name>`, or `./themes/external/<name>`). In local components, use
  CSS variables or `useTheme()`, never hard-coded colors.
- **Attention animations**: `dash-bored animation init <name>` scaffolds
  `animations/<name>/animation.yaml`; check it with `dash-bored animation
  validate <directory>` and preview it with `app run attention:<node-id>
  --animation ./animations/<name>`. The top-level `attentionAnimation:` sets
  the default. Format and built-ins:
  [references/animations.md](references/animations.md).
