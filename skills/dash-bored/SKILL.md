---
name: dash-bored
description: Use this skill to build, extend, fix, or check a dash-bored dashboard — a local, project-owned cockpit in .dash-bored/dash-bored.yaml that shows a project's live state and turns its recurring commands, docs, and checks into one-click panels. Use it whenever the user wants such a persistent overview or control panel for a project (what is running, healthy, changed, or next; buttons to start, test, or release it), or mentions dash-bored, .dash-bored/, dash-bored.yaml, or a project cockpit, even if they do not name dash-bored. Also use it to author, scaffold, type-check or publish standalone dash-bored components with the versioned component SDK, add panels or source scripts, repair dashboard validation errors, migrate a dashboard after an app update, or operate the running dash-bored app. Not for the project's own work (starting services, deploying, running tests) when neither dash-bored components nor the dashboard nor the app is involved, for dashboard UIs inside the user's own application code, or for Grafana/BI dashboards.
---

# dash-bored

Your job is to give the user an overview of their project they can trust at a
glance, plus one-click access to the work they repeat. A new user should
understand every panel without a tutorial; a returning user should find the
answer to "where does this stand and what do I do next?" in seconds. The
project may be software, docs, research, ops, or anything with files and
commands: work from what it actually contains, not from a generic template.

The user works in the dash-bored desktop app; you work through this skill's
tool. For dashboards, `dash-bored.yaml` is the source of truth. For standalone
component authoring, work in the component's manifest, sources and assets;
use the separate authoring workflow below.

## Running the tool

`dash-bored` is **not** on `PATH`. Run this skill's launcher by its absolute
path in every command, for example
`~/.agents/skills/dash-bored/scripts/dash-bored inspect . --summary` (use the
directory this SKILL.md is in). Write the path out each time: most agent
shells do not keep variables between commands. The launcher uses
`$DASH_BORED_TOOL` when the app launched you, otherwise the installed app;
exit 127 means the app is missing, so ask the user to install and open
dash-bored once. In a checkout of the dash-bored repository itself, use
`bun run dash-bored -- <command>`. Below, `dash-bored` means the launcher.

Commands inside the dashboard (a `command` prop, a source's `shell`) run in the
app, where the tool is `"$DASH_BORED_TOOL"`.

## Match the request

| Request | What to do |
| --- | --- |
| Author, scaffold, check or publish a standalone component or work in a component repository | [Standalone component authoring](references/components.md#standalone-component-authoring); start with API discovery and SDK setup, and use a dashboard later for preview |
| Build or set up a dashboard, or replace the starter | The full workflow below |
| Change a node "from its component context menu" (the prompt names a target component) | Change that node and only what the request needs; read the owning YAML and the files the request mentions, not the whole project. Then steps 3–7 |
| Add a component at a YAML insertion path from the structural editor | Make exactly the edit its `Placement:` line states. Prefer a core view fed by a source script (step 4), and say so in the report; write a local component only when no view can present it |
| Fix listed diagnostics | Fix each at its file and path, then steps 5–7 |
| After an app update, or an old `schemaVersion` | [references/migrations.md](references/migrations.md) |
| Use the running app: run a dashboard button or command, read a panel, explain why something is red or failed | [Use the running app](#use-the-running-app); change no YAML |

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

- Read the project's agent instructions and README, then the one or two
  files that define how work gets done (`package.json` scripts, `Makefile`,
  `justfile`, compose files, CI workflows, `pyproject.toml`, a runbook).
  Follow further files only to answer a specific question. Leave credential
  files (`.env`, `*.env`, `.envrc`, secrets configs) out of every `cat` or
  read, and skip commands that print resolved secrets, such as
  `docker compose config`: a file's name is enough to plan panels. Do not read
  the dash-bored application's source; this skill and the catalog are
  authoritative for this version.
- Run `dash-bored inspect . --summary`. Without a dashboard it exits 1 with
  `FILE_NOT_FOUND` for `dash-bored.yaml` and `dash-bored-lock.yaml` (and lists
  an unavailable `./components` placeholder); then run `dash-bored init .`.
  The starter is dash-bored onboarding plus a component tour: replace its
  whole `root` tree rather than adapting it, and keep the generated `.env`
  (it holds the user's agent choice).
- If a dashboard exists, read its `dash-bored.yaml` fully. Keep what the user
  built; change only what the request needs.
- If the app is running, `dash-bored app status` tells you which dashboard is
  open, which node is focused, and whether the user has an unsaved draft.

### 2. Plan the overview

Write down the questions this user will bring to the dashboard, and answer
each with the smallest panel that answers it from real project data. Start
with these and keep the ones the project gives you evidence for:

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
| Hand work or a judgment call to the agent? | A button or item action running `agent:prompt`; a `prompts/<name>.md` template when the briefing repeats |

Group panels into tabs by workflow, with an **Overview** tab first that
answers "where does this stand" without scrolling. Put explanations next to
the controls they explain. Skip any panel you cannot back with real data; an
honest small dashboard beats a full one with placeholders. When a documented
command cannot work (a missing script, an uninstalled tool), leave it out or
say so in its label, and list it under **Needs you** in the report.

### 3. Compose

Look up each component's contract before you write it:
`dash-bored inspect . --component <ref>`, or
[references/builtins.md](references/builtins.md) for every core component. Never
guess props from a component's name. A valid dashboard in the recommended
shape:

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
            node:
              id: develop
              component: "./components/external/core/group"
              props: { title: Run and test }
              children:
                axis: vertical
                first:
                  node: { id: dev-server, component: "./components/external/core/command", props: { label: Start dev server, command: npm run dev } }
                second:
                  node: { id: tests, component: "./components/external/core/command", props: { label: Run tests, command: npm test } }
```

Composition rules:

- An `action` is a reference string, or `{ run: <reference>, with: {...} }`
  for arguments. References name nodes by ID: `select:<selection-id>/<child-id>`
  switches a `selection`; `reveal:<id>` expands and selects a node anywhere
  (`with: { item: ${item.id} }` also focuses that item of a list inside it);
  `focus:<id>` makes it the page; `process:<command-id>` runs a `command`;
  `component:<node-id>:<action-id>` runs a declared action (a view's
  `refresh`, a command's `run`); `agent:prompt` with
  `with: { prompt, template?, vars? }` prefills the agent composer for the
  user to send. Without `template` it briefs project work (`project`);
  `template: dashboard` briefs a dashboard change. A bundle's own
  `prompts/<name>.md` templates declare their `vars`, `env`, and `scope` (see
  [references/sources.md](references/sources.md#agent-prompt-templates)).
- Managed-child labels live on the edge (`metadata: { label }`). Tiled
  children are one `{ node }` edge or a split: `axis`, `first`, `second`;
  nest splits for more than two. Horizontal splits may set `ratio`
  (0.1–0.9, default 0.5 — omit it when equal); vertical splits never do.
- Give every node a stable, unique `id`; validation rejects references to
  unknown IDs.
- A `group` with a `title` frames two or more related panels. Never wrap a
  single panel in one: it only adds a frame, and validation does not catch it.
- The catalog still lists `card`, `tabs`, `todo-list`, `live-chart`,
  `conditional`, `setup-agent`, and `focus-timer` for older dashboards until
  a migration retires them. Don't add new ones: use a titled `group`, a
  `selection` with a `variant: tabs` button, a `list` with `todos`, and a
  `chart` with `source`. Leave existing uses alone unless asked.
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
permissions the code uses, and leave `renderMode` out. Every manifest needs
`schemaVersion: 3` and a supported exact stable-semver `apiVersion`; use
`dash-bored component api` to inspect the app's offline SDK. Scaffold with
`component init`, preserve editor configuration with `component setup`, and
run `component check` for semantic source and declaration checks before
dashboard validation. Schema-v2 manifests require an explicit migration.

### 4. Back observed panels with sources

A value typed into YAML goes stale, so anything that can change comes from a
`source` (`shell`, `file`, `http`, `process`, or `inline`, plus `every`,
`timeoutMs`, `cwd`, `env`). For each observed panel:

1. Find the command that answers the question and run it yourself. A source
   runs every time its panel is shown and on every poll, so it must be a
   read-only check that finishes in seconds; tests, builds, installs, and
   anything that writes belong in a `command` instead.
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

[references/sources.md](references/sources.md) has the full source contract,
tested example scripts, list item actions, and the app's shell environment.

### 5. Validate

1. For any local component, run `dash-bored component check <directory>`.
   Then run `dash-bored validate . --json`. It checks YAML, props, IDs, action and
   process references, item templates, and permissions, and compiles local
   components. The text output omits each diagnostic's `path`, which you
   need to find the failing prop.
2. Fix each cause and rerun until `"ok": true`. Do not stop on a failing
   dashboard: the app keeps showing the last valid one, so your change would
   be silently missing.
3. Validation semantically checks local TSX and published declaration interfaces,
   but never executes sources or components; step 4 and app preview cover those.
4. Run `dash-bored inspect . --summary` and compare `permissions` with what you
   meant to add. Each new permission makes the user re-approve trust.

### 6. Look at it

Validation proves the YAML is correct, not that the dashboard is useful.
When the app is running, check what the user will see:

1. `dash-bored app status`: note the open dashboard, `focusedNodeId`,
   `trust`, and `diagnostics.items` (runtime errors validation cannot see).
2. If a different bundle is open, `dash-bored app open .` (refused while the
   user has a draft open; then ask them to save or cancel it).
3. `dash-bored app screenshot --node <node-id>` for each panel you changed
   (`--output <file.png>` picks the path), then view the PNG path it prints. It crops to that node, even on another
   tab, and puts the user's view back. Check that labels make sense, nothing
   is empty or truncated, no panel shows "Source shape" or "Command failed",
   and the Overview answers its questions. A plain `app screenshot` shows the
   whole window as the user sees it.
4. Fix, validate, and screenshot again until it reads well.

`dash-bored app actions <filter>` lists what you may run whose id, label, or
node contains the filter (the unfiltered list can run to hundreds of entries);
pass the `reference` or `id` to `app run`. The app refuses trust
changes, draft start/save/cancel, `agent:*` actions, the Add dashboard
chooser, and anything that asks for confirmation; tell the user which of
these they need to do. The app reloads after each YAML save, so if an `app`
command fails right then with a closed connection, retry it once. Never fall
back to a full-screen `screencapture`: it captures whatever else is on screen.
If the app is not running, the project is untrusted, or a screenshot fails,
say so in the report rather than implying you checked the result visually.

### 7. Report

End with a short summary in this shape:

```markdown
**Dashboard:** <bundle path> — <one line on what it now shows>
**Tabs:** <tab>: <what it answers>; ...
**Needs you:** <trust approval for new permissions, Screen Recording, a draft to save, a tool missing from the app's PATH — or "nothing">
**Not verified:** <what you could not run or see, and why — or "nothing">
```

## Use the running app

The user may ask you to drive their dashboard rather than change it. Read
results instead of guessing from pixels, and read the dashboard YAML and its
source scripts freely to learn what a panel shows and why; only writing them
is out of scope here.

1. `dash-bored app status`. `trust.trusted: false` means only layout renders
   and nothing runs: ask the user to trust the project (you cannot).
   `diagnostics.items` holds each error's code, message, file, and path;
   `selections` maps each tab container to its selected child.
2. Find the node: its `id` in the YAML, or `dash-bored app actions <word>`,
   which also finds the action for a button, tab, or command
   (`process:<command-id>`, `select:<selection>/<child>`,
   `component:<node>:refresh`). Several panels can share a label; each
   action's `description` shows where it sits, and you should say which one
   you used. Pass an action's `reference` to `dash-bored app run`; an unknown
   one returns close `suggestions`. Choices show as counts; `--choices` lists
   options for `--select <choice>=<option>`. In the desktop command palette,
   users reach the same options by searching a name or node ID, which lists
   rows such as `Focus component › Backlog`.
3. `dash-bored app read <node-id>` returns a panel's full rendered text (all of
   it, even below the fold or on another tab) once its sources have loaded,
   and leaves the user's view as it was (`changes.revealed: true` means it
   briefly showed the node's tab and then restored it: `viewRestored: true`). Use it to answer "what does it say",
   count items, or read a status detail.
4. `app run` returns when the views it touched have finished loading
   (`idle: true`; `idle: false` plus a `warning` after `--timeout`, default
   10 s). A refresh of a panel that is not mounted is `unavailable`:
   `reveal:<node-id>` first, or just `app read` it.
5. To run a command and get its result in one call:
   `dash-bored app run process:<command-id> --until-exit` waits for that run
   to finish (default up to 10 minutes, `--timeout <ms>`) and returns its
   `exitCode` and the last lines of output (`--tail <n>`); the tool's exit
   status is nonzero when the command failed or is still running. Don't use it
   for servers that never exit. `dash-bored app wait <command-id>` does the
   same for a run already in progress, `app processes <command-id>` shows one
   process, and `app logs <command-id> --tail <n>` reads more output.
6. Show what you found with `app screenshot --node <id> --output <file.png>`
   when a picture helps. A node taller than the window comes back
   `truncated: true` with only its top; use `app read` for its content.

Leave the user's view as you found it: `app read` and `--node` restore it
(`viewRestored: true`), and so does `--focus` unless you pass `--keep-focus`.
After `app run select:` or `focus:`, run `select:<selection>/<child>` from the
original `selections`, or `focus:<original focusedNodeId>`. When another
agent is reading or capturing at the same time, `app read` and `--node` fail
with "retry in a few seconds"; `--node` also fails with "The view changed"
when someone switches tabs mid-capture. Retry both. An unknown `app` command
means the installed app is older than this skill: say which command is
missing and fall back to screenshots and the YAML.

## Gotchas

- **Never write the YAML while the user edits a draft.** When `app status`
  shows `editing: true`, their Save would be rejected as stale and their
  changes lost. Ask them to save or cancel first, and only then edit.

- **The app's shell is not your shell.** Sources run `/bin/sh -lc` without
  your rc files, so nvm, pyenv, or asdf interpreters are missing there and
  fail with `Command failed (exit 127)` (commands, which open the user's
  interactive `$SHELL`, do load them). Never hard-code a personal absolute
  path into shared YAML; report the missing tool instead.
- **One run at a time per `command`.** A `process` source reports its latest
  run's exit code; its `run` action is disabled only while a run is active.
- **Item templates are whole values.** `"${item.sha}"` works;
  `"commit ${item.sha}"` is rejected. A `command` receives each argument as
  `DASH_ITEM_<ARG>` (upper-cased): quote it (`"$DASH_ITEM_SHA"`) and never put
  `${item.…}` in command text, which fails as `COMPONENT_PROPS_INVALID`
  "must NOT be valid".
- **`markdown` with `path:` requests file read and write permission**, even
  when used read-only.
- **Commands never auto-start.** A `command` runs only when the user clicks it
  or an action starts it. Don't start long-running processes just to take a
  screenshot.
- **New permissions pause the dashboard.** Until the user re-approves trust,
  the app renders layout and inline content only: no sources, local
  components, commands, file reads, HTTP, or webviews. A screenshot then shows
  that untrusted state, not a broken dashboard.
- **App state is not YAML.** Draft Save/Cancel, collapse, focus and selection
  state, shortcuts, favorites, and agent tasks belong to the app; don't invent
  keys for them. [references/app-runtime.md](references/app-runtime.md) covers
  them when a request involves one.
- **The bundle `.env` is data, not shell.** The app loads it for commands and
  sources in that bundle; don't `source` it. Never put secrets in YAML or in
  a source's output, and never point an `env` panel at a file that holds
  credentials: the panel shows its values on screen, and `.env` is not
  git-ignored by default.
- **Screenshots need macOS Screen Recording permission.** If `app screenshot`
  fails with `SCREEN_RECORDING_PERMISSION_REQUIRED`, ask the user to allow it
  and relaunch the app. The app renders while covered by other windows, so you
  never need the user to switch to it; `APP_WINDOW_NOT_RENDERING` (or a
  `warning` on `app run`) means it is minimized or hidden: ask them to show it.
- **Several app instances can run** (for example a release and a dev build).
  If `app` commands say the choice is ambiguous, pass
  `--instance <identifier>` from the list they print.

## Other tasks

- **Named dashboards** for a person or workflow: `dash-bored init <name>`
  creates a standalone bundle under `.dash-bored/<name>/`. Show it inside
  another dashboard by using its path as a component (`component: "./<name>"`);
  bundles never merge or inherit.
- **External components or themes from Git**, only when the user asks: the
  `component` and `theme` commands pin exact commits (`--help` shows usage).
  The user can do the same from the app's component library and Settings.
- **Themes**: `dash-bored theme init <name>` scaffolds `themes/<name>/theme.yaml`
  with `light` and `dark` token maps that inherit every default; check it with
  `dash-bored theme validate <directory>`. Token names and defaults are in
  [references/theme-tokens.md](references/theme-tokens.md). Select it with the
  dashboard's top-level `theme:` (`builtin:default`, `builtin:neon-dusk`, `global:<name>`,
  `./themes/<name>`, or `./themes/external/<name>`); themes are data only. In
  local components, use CSS variables or `useTheme()`, never hard-coded colors.
- **Migrations** after an app update, or when validation reports an old
  `schemaVersion`: read [references/migrations.md](references/migrations.md)
  and start with `dash-bored migrate inspect <dashboard>`.
