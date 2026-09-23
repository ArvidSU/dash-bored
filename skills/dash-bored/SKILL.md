---
name: dash-bored
description: Use this skill to build, extend, fix, or check a dash-bored dashboard — a local, project-owned cockpit that shows a project's state at a glance and turns its recurring commands, docs, services, and checks into one-click panels. Use it whenever the user wants a persistent overview of what they are working on (what is running, healthy, changed, or next; how to start, test, release, or operate it), or mentions dash-bored, .dash-bored/, dash-bored.yaml, or a project cockpit or control panel, even if they do not name dash-bored. Also use it to add or repair dashboard components, migrate a dashboard after an app update, or screenshot the running dash-bored app to verify one. Not for building dashboard UIs inside the user's own application code, or for Grafana/BI dashboards.
---

# dash-bored

Your job is to give the user an overview of their project they can trust at a
glance, plus one-click access to the work they repeat. A new user should
understand every panel without a tutorial; a returning user should find the
answer to "where does this stand and what do I do next?" in seconds. The
project may be software, docs, research, ops, or anything with files and
commands: work from what it actually contains, not from a generic template.

The user works in the dash-bored desktop app. You work through this skill's
tools. `dash-bored.yaml` is the only source of truth: there is no hidden
database, and anything you do not write there does not exist.

## Running the tool

`dash-bored` is **not** on `PATH`. Resolve it once per session:

```sh
DB="${DASH_BORED_TOOL:-<this skill's directory>/scripts/dash-bored}"
"$DB" inspect . --summary
```

`DASH_BORED_TOOL` is set when the app launched you; otherwise the launcher
finds the installed app. If it exits 127, ask the user to install and open
dash-bored once. In a checkout of the dash-bored repository itself, use
`bun run dash-bored -- <command>`. Below, `dash-bored` means `"$DB"`.

The commands you need for a build are `inspect`, `validate`, `init`, and
`app`; each step below says when. `dash-bored --help` lists the rest.

Dashboard commands the user runs from the app are different: they must call
the tool as `"$DASH_BORED_TOOL" <command>`, never bare `dash-bored`.

## Workflow

```text
- [ ] 1. Orient: read the project and the existing dashboard
- [ ] 2. Plan the overview: questions → panels
- [ ] 3. Compose the YAML (and local components only where needed)
- [ ] 4. Validate until clean
- [ ] 5. Look at it in the app; fix what looks wrong
- [ ] 6. Report
```

### 1. Orient

- Read the project's agent instructions and README, then the one or two
  files that define how work gets done (`package.json` scripts, `Makefile`,
  `justfile`, compose files, CI workflows, `pyproject.toml`, a runbook).
  Follow further files only to answer a specific question. Do not read the
  dash-bored application's source; the catalog and references are
  authoritative for this version.
- Run `dash-bored inspect . --summary`. Without a dashboard it exits 1 with
  `FILE_NOT_FOUND` for `dash-bored.yaml` and `dash-bored-lock.yaml` (and lists
  an unavailable `./components` placeholder); that just means run
  `dash-bored init .`. The starter it writes is a tour of dash-bored itself:
  replace its whole `root` tree with the project's dashboard, and keep the
  generated `.env` (it holds the user's agent choice).
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
| What is this and how is it organized? | `@dash-bored/markdown` with `path:` to the README or a runbook |
| Is it running / healthy? | A local component that polls one bounded check, with explicit unknown/healthy/error states |
| What changed recently? | A local component running a bounded `git log`/`git status` (see the worked example in [references/components.md](references/components.md)) |
| How do I start, test, build, or deploy it? | One `@dash-bored/command` per real script or task |
| Where is the local UI or docs site? | `@dash-bored/webview` on its `http(s)://` URL |
| Which settings does it need? | `@dash-bored/env` on the bundle's `.env`, for non-secret values (see Gotchas) |
| What is next? | The repo's own tracking file (`TODO.md`, notes) via `@dash-bored/markdown`; `@dash-bored/todo-list` only for items the user names and nothing else tracks |
| Numbers over time? | `@dash-bored/live-chart` from an HTTP endpoint; `@dash-bored/chart` only for fixed data |

Group panels into tabs by workflow, with an **Overview** tab first that
answers "where does this stand" without scrolling. Put explanations next to
the controls they explain. Skip any panel you cannot back with real data; an
honest small dashboard beats a full one with placeholders. When a documented
command cannot work (a missing script, an uninstalled tool), leave it out or
say so in its label, and list it under **Needs you** in the report.

### 3. Compose

Look up each component's contract before you write it:
`dash-bored inspect . --component <ref>`, or
[references/builtins.md](references/builtins.md) for every built-in. Never
guess props from a component's name.

A complete, valid dashboard in this shape:

```yaml
schemaVersion: 3
name: Example
root:
  id: cockpit
  component: "@dash-bored/group"
  children:
    axis: vertical
    first:
      node:
        id: section-actions
        component: "@dash-bored/button"
        props:
          variant: tabs
          items:
            - { name: Overview, action: "select:sections/overview" }
            - { name: Develop, action: "select:sections/develop" }
    second:
      node:
        id: sections
        component: "@dash-bored/selection"
        props: { defaultChild: overview }
        children:
          - metadata: { label: Overview }
            node:
              id: overview
              component: "@dash-bored/group"
              props: { title: Where things stand }
              children:
                axis: horizontal
                first:
                  node: { id: readme, component: "@dash-bored/markdown", props: { path: README.md } }
                second:
                  node:
                    id: next-up
                    component: "@dash-bored/todo-list"
                    props:
                      todos:
                        - { id: ship-retry-fix, description: Ship the retry fix, done: false, tags: [release] }
          - metadata: { label: Develop }
            node:
              id: develop
              component: "@dash-bored/group"
              props: { title: Run and test }
              children:
                axis: vertical
                first:
                  node: { id: dev-server, component: "@dash-bored/command", props: { label: Start dev server, command: npm run dev } }
                second:
                  node: { id: tests, component: "@dash-bored/command", props: { label: Run tests, command: npm test } }
```

Composition rules:

- Managed-child labels live on the edge (`metadata: { label }`). A
  `select:<container-id>/<child-id>` action switches a selection container.
- Tiled children are one `{ node }` edge or a split: `axis`, `first`,
  `second`. Nest splits for more than two. Horizontal splits may set `ratio`
  (0.1–0.9, default 0.5 — omit it when equal); vertical splits never do.
- Give every node a stable, unique `id`. Anything stateful, actionable, or
  process-backed needs one, and screenshots and actions address nodes by it.
- A card frames two or more related panels; a lone panel needs no card.
- Paths in props (`markdown` `path`, `command` `cwd`, `env` `path`) are
  relative to the project root (the directory containing `.dash-bored/`), not
  to the bundle.
- The starter sets `icon: ./assets/icon.svg` (relative to the bundle) but does
  not create the file, and validation does not check it; a missing icon shows
  a generic glyph. Write a small, simple SVG there for the project.
- Edit the existing YAML in place, or replace the whole file atomically.

When nothing in the catalog answers a question, write a small local component
in `components/<name>/` with `component.yaml` and `index.tsx`, referenced as
`./components/<name>`. That is the expected path for live, project-specific
status, not a last resort. Read [references/components.md](references/components.md)
by section: **Local component layout**, **TSX contract**, and
**HTTP and bounded shell payloads** cover a status or observer panel, and the
worked Git example is a good template to adapt; read **Child projection and
managed tabs** only for containers. Declare only the permissions the code
uses. Leave `renderMode` out (it defaults to `surface`, a panel with its own
height); set `layout` only for a container whose height must follow its
children.

### 4. Validate

1. Run `dash-bored validate .`. It checks YAML, props, references, and
   permissions and compiles local components, but does not type-check TSX or
   run anything, so read your component code once more for runtime mistakes.
2. If it fails, read each diagnostic's file, path, and code, fix the cause,
   and run it again. Do not stop on a failing dashboard: the app keeps showing
   the last valid one, so the user would see your change silently missing.
3. Run `dash-bored inspect . --summary` and compare `permissions` with what you
   meant to add. Each new permission makes the user re-approve trust.

### 5. Look at it

Validation proves the YAML is correct, not that the dashboard is useful.
When the app is running, check what the user will see:

1. `dash-bored app status`: note the open dashboard and `focusedNodeId` so
   you can restore them.
2. If a different bundle is open, `dash-bored app open .` (refused
   while the user has a draft open; then ask them to save or cancel it).
3. `dash-bored app screenshot --focus <node-id>` for each tab or panel you
   changed, then view the PNG path it prints. Check that labels make sense,
   nothing is empty or truncated, and the Overview answers its questions.
4. Fix, validate, and screenshot again until it reads well.
5. Restore the user's view with `dash-bored app run focus:<original-id>`.

`dash-bored app actions` lists the palette actions you may run (`focus:<id>`,
`dashboard:<path>`, component actions). The app refuses trust changes, draft
start/save/cancel, the Add dashboard chooser, and anything that asks for
confirmation. Tell the user which of these they need to do instead.

If the app is not running, or a screenshot fails, say so in the report rather
than implying you checked the result visually.

### 6. Report

End with a short summary in this shape:

```markdown
**Dashboard:** <bundle path> — <one line on what it now shows>
**Tabs:** <tab>: <what it answers>; ...
**Needs you:** <trust approval for new permissions, Screen Recording, a draft to save — or "nothing">
**Not verified:** <what you could not run or see, and why — or "nothing">
```

## Gotchas

- **`@dash-bored/status` is static.** Its `state` is whatever the YAML says.
  For live health, write a local component that performs the check.
- **`@dash-bored/conditional` is for setup and recovery, not health.** It
  shows or hides one child based on a shell check, starts visible, and fails
  open. Never use it (or a pair of inverted ones) as a health indicator.
- **`@dash-bored/markdown` requests file read and write permission**, even for
  inline `content`. Prefer `path:` to a real project file.
- **Commands never auto-start.** A `@dash-bored/command` is a button that
  opens a persistent terminal; it does not run on open, trust, or reload.
  Don't start long-running processes just to take a screenshot.
- **New permissions pause the dashboard.** Until the user re-approves trust,
  the app renders layout and inline content only: no local components,
  commands, file reads, HTTP, or webviews. A screenshot then shows that
  untrusted state, not a broken dashboard.
- **App state is not YAML.** Draft Save/Cancel, collapse, focus selection,
  shortcuts, favorites, and agent tasks belong to the app; don't invent keys
  for them. [references/app-runtime.md](references/app-runtime.md) covers
  them when a request involves one.
- **The bundle `.env` is data, not shell.** The app loads it for commands in
  that bundle; don't `source` it. Never put secrets in YAML. `.env` is not
  git-ignored by default: before pointing an `env` panel at credentials, check
  `.gitignore` covers it, or leave the panel out and tell the user.
- **Screenshots need macOS Screen Recording permission.** If `app screenshot`
  fails with `SCREEN_RECORDING_PERMISSION_REQUIRED`, ask the user to allow it
  and relaunch the app.
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
  dashboard's top-level `theme:` (`builtin:default`, `global:<name>`,
  `./themes/<name>`, or `./themes/external/<name>`); themes are data only, with
  no CSS or code. In local components, use CSS variables or `useTheme()`,
  never hard-coded colors.
- **Migrations** after an app update, or when validation reports an old
  `schemaVersion`: read [references/migrations.md](references/migrations.md)
  and start with `dash-bored migrate inspect <dashboard>`.
