# dash-bored - Product Vision and Principles

## Vision

dash-bored is a local-first, agent-configurable project cockpit.

It provides a way to turn any project, workspace, or environment into a custom operational interface without requiring the core application to understand the project domain.

The user should not need to remember:

- which command starts a service
- the last command they used or where to enter the next one
- which browser tab contains a local UI
- how a legacy deployment procedure works
- where configuration files live
- which scripts exist and what arguments they require

Instead, the project should expose its workflows through a persistent, composable dashboard.

## Core Idea

The dashboard is not a collection of built-in integrations.

The dashboard is a runtime for composing interfaces from components and a
core-owned tiling topology.

The application provides:

- a recursive composition and tiling model
- drag-and-drop and horizontal/vertical layout manipulation
- component loading
- an action registry and command palette
- configuration handling
- host capabilities

Everything else is user/project/component defined.

## Atoms, not a browser and not a product

dash-bored sits deliberately between two failure modes. It must not reinvent
the browser: no general layout engine, styling system, expression language, or
application framework. It must not become a use-case-specific dashboard either:
no Docker, git, npm, or CI knowledge in the app. Diversity comes from a small
set of well-executed atoms that an agent can combine with a little YAML through
the app's contracts.

Every atom serves one of three jobs:

- **Overview** — core tiling, one titled group, and single-child selection for
  switching between panels.
- **Act** — one action model, surfaced through the palette, buttons and action
  bars, per-item actions, and persistent commands.
- **Observe** — sources that produce data and a few views that render
  declared data shapes.

The shell is the integration layer. The app defines data shapes and view
contracts; project knowledge lives in a small command or script the agent
writes whose output matches one of those shapes. Transforming data is the
script's job, never a YAML mini-language.

The test for the atom set is the project's own dashboard: a project-specific
list, fact sheet, or runnable-script catalog should be a few lines of YAML plus
a script. When something still needs a local React component, first ask which
atom is missing before adding one, and never promote a domain-specific
component to a builtin.

The planned sequence of work toward this atom set lives in
[docs/roadmap/atoms.md](./roadmap/atoms.md).

## Agent-First Philosophy

The primary way users customize dashboards should be through natural language.

Example:

> Add a component in the development tab showing the health of all services in the Docker Compose stack.

The agent should:

1. Inspect the project.
2. Search available components.
3. Reuse an existing component if appropriate, preferring a source script
   feeding an existing view over new component code.
4. Otherwise create a local component.
5. Modify the dashboard configuration.
6. Validate the result and look at it in the running app.

Creating a dashboard should feel closer to asking an agent to modify code than configuring a traditional dashboard product.

The starter dashboard should make that workflow self-contained: it can install
global or project-local guidance that teaches compatible agents the dash-bored
component model, then launch the user's chosen CLI agent with a project-specific prompt.

Previously installed skill payloads follow app updates while
preserving local edits and reporting conflicts. Successful maintenance is not a
diagnostic; only an unresolved conflict needs to remain visible. The setup
action owns its agent
task independently of the starter component. After completion the app validates
the saved dashboard and may request one bounded repair of configuration errors;
validation does not replace the user's review of usefulness or permission changes.
When an installed-tool conflict is shown, the user may explicitly move the
conflicting managed install to the OS Trash and reinstall the current payload.

Every rendered component should make that workflow immediate through a small
context menu. Alongside Focus, users can edit a component's declared props,
collapse or expand it to keep large dashboards compact, copy an exact
config-and-tree locator, or describe a wanted change and send it to the app-wide configured
`DASH_BORED_AGENT`. The app enriches that request with dash-bored, project, and
component context; it does not hide which external CLI command will run.
Dashboard-change requests are first-class in the application through a small
agent-work surface that reports the configured CLI's launch, output, exit, and
observed dashboard changes. This is deliberately a narrow harness around the
user's agent, not a general-purpose agent runtime or provider integration.

Direct manipulation complements that primary workflow. The desktop app offers
a right-hand component-library flyout for arranging existing components,
filling their declared props, and adding or removing branches. Opening the
flyout is read-only; the first insertion, move, removal, replacement, metadata
edit, or horizontal ratio resize implicitly starts a draft. Save/Cancel remains the
boundary for publishing or discarding the same project-owned YAML tree, rather
than a second layout model or a hidden application database.

## User and agent separation

The user works through the desktop app. There is no user-facing dash-bored
command-line tool and nothing is installed on the user's `PATH`: opening,
arranging, trusting, updating, and managing dashboards, external components,
and themes are UI workflows.

The agent works through tools shipped with the dash-bored skill. The skill is
the single agent-facing distribution unit: its guidance and a small launcher
that resolves the version-matched tool carried inside the installed app. With
those tools an agent can create dashboard bundles, discover and inspect
component contracts, validate its edits, migrate dashboards to a new contract,
and verify its work visually. Visual verification goes through a local,
per-instance control channel of the running app: the agent reads app state,
lists and invokes the same command-palette actions a user can (for example to
open a dashboard or focus a component), and captures a screenshot of the app
window. The channel never widens what a palette action may do: trust
decisions and actions that require user confirmation stay with the user.

Keeping the tools behind the skill means one payload to version and refresh,
and no separately maintained CLI link that can drift from the app.

## Composition direction

The core application owns composition. It owns the recursive tiling topology,
drag-and-drop, horizontal split resizing, visible-surface height caps, component frames, focus and
collapse, draft Save/Cancel, validation, and persistence. A tile branch is
core composition structure, not a component. Components render inside the
frames and may describe how their children are presented, but they do not own
the dashboard's topology or resize semantics.

Visible surfaces start at intrinsic height and may only be compressed; vertical
organizational topology remains normal document flow so the dashboard itself
grows with any amount of content.

Every ordinary component declares one `children` contract: its minimum and
maximum child cardinality and the axes on which children may be arranged.
One group component provides a neutral composition boundary with an optional
title and description; there is no separate card. A standalone component
renders in its own core-owned frame and needs no wrapper.
Complex containers may additionally declare managed child presentation and a
schema for metadata attached to each child. Components receive generic child
handles, read-only descriptors, and a projected render/visibility interface;
tabs, accordions, and similar presentations therefore need no app-level,
component-ID-specific behavior. A panel label is metadata on the parent-child
edge, not a special component prop.

Showing one child at a time is a core contract, not a tabs component. A
container that declares single-child selection gets core-owned selection state,
persisted like collapse, and core-provided select actions. Tabs are that
contract combined with a tab-styled action bar, so any presentation of
switchable panels reuses the same actions, palette entries, and shortcuts.
Visibility conditioned on a source is likewise composition intent on the
parent-child edge rather than a dedicated component.

YAML is the only source of truth. It recursively describes both the topology
and component composition; no hidden grid database or parallel coordinate
model exists. Its structure should express only component nodes, parent-child
metadata, child order, and the splits needed to arrange them. Omit redundant
wrapper records and values that have no effect: equal horizontal widths are
the default, and vertical document flow has no ratio. The saved tree, editor
draft, and runtime use the same representation.

Packaged and project-local components use exactly the same
manifest, render, host, children, and capability contract. They differ only by
provenance and trust: packaged app code is pretrusted, while project code
requires project trust.

Validation, editor behavior, and runtime behavior are generic. No logic is
keyed to a component ID; differences come from declarative schemas, formats,
and capabilities.

## External components direction

Reusable components travel as git submodules, referenced by repository URL
only. There is no marketplace, no registry, and no auto-update: a component
is added from a URL, pinned to an exact commit in `dash-bored-lock.yaml`, and
updated only by an explicit user action in the app, or by an agent the
user asked to do so. This keeps reuse reproducible and
reviewable without a second distribution model.

An external component uses exactly the same manifest, render, host, children,
and capability contract as a project-local one. It differs only by provenance
(`components/external/<name>`) and trust: like any project code it runs in
the shared renderer after a project trust decision, and changing its pin
re-runs the permission-union trust check. The library flyout surfaces that
trust delta and never bypasses it.

## Themes

Themes are first-class, declarative packages outside the component tree. Users
and agents author versioned `theme.yaml` files with light and dark design-token
variants. The app selects a default theme and Light/Dark/System appearance;
Application Settings lists every registered dashboard so each can select a
theme and appearance mode for the whole window. Each dashboard field is
optional and independently inherits the app selection when omitted. Linked
content and focused components never take ownership of the window theme.

Theme packages customize colors, typography, corners, and shadows while core
retains layout, native chrome geometry, focus, and interaction ownership. They
contain no executable code, custom CSS, or downloaded resources. Personal
installations are shared by the agent tools and desktop app; project installations
travel with the dashboard bundle. Git themes use exact commit pins, explicit
installation/update actions, and no marketplace or automatic network updates.

## Design Principles

### 1. Configuration over application logic

The dashboard application should remain small.

A dashboard should be primarily:

- configuration
- components
- composition

Not custom application code.

### 2. Local-first

Dashboards belong with projects.

A project should be able to contain:

```
project/
├── src/
├── package.json
└── .dash-bored/
    ├── dash-bored.yaml
    ├── dash-bored-lock.yaml
    ├── .env
    └── components/
```

The dashboard becomes project memory.

Projects may keep more than one standalone dashboard bundle when different
people or workflows need different cockpits:

```
project/.dash-bored/
├── dash-bored.yaml
├── dash-bored-lock.yaml
├── .env
├── components/
└── arvid/
    ├── dash-bored.yaml
    ├── dash-bored-lock.yaml
    ├── .env
    └── components/
```

Each bundle is independently loadable and owns its lock file, environment, and
local components. Dashboards compose only by using another config bundle's path as a
component reference. The referenced dashboard receives the same kind of
rectangular space as any other component; configs are not merged and neither
inherits from the other.

### 3. Components over integrations

Avoid building special cases:

Bad:

- Docker widget
- GitHub widget
- npm widget
- Kubernetes widget

Better:

- command component with a persistent terminal
- sources: bounded shell, file, HTTP, process-result, or inline data
- views over declared data shapes: status, list, chart, and Markdown with
  inline, project-file, or source content
- buttons and action bars over one action model

Domain-specific functionality should be composed from primitives. A view never
holds hand-written observed state: a status whose state is typed into YAML goes
stale, so observed values always come from a source. A list whose items are
the component's own YAML props (such as a todo list) is still a source, one
the view may edit through the draft boundary.

### 4. Generated code is a feature

A small generated component that solves a specific problem is valuable.

Examples:

- device fixture status viewer
- weird deployment button sequence
- internal API tester
- project-specific migration helper

Not every component needs to become a marketplace package.

### 5. The system should be self-describing

Components should expose:

- name
- description
- configuration schema
- required permissions
- one declared children contract (cardinality and allowed axes)
- optional managed-child presentation and per-child metadata schema
- whether it renders a visible surface or only organizes descendant layout
- capabilities

This allows:

- validation
- autocomplete
- documentation generation
- agent discovery

### 6. Workflows should be discoverable

The application shell should expose its own navigation and lifecycle actions,
configured project commands, and actions contributed by active components
through one searchable command palette.

Application settings separate general behavior, appearance defaults and
per-dashboard appearance selections from the action catalog. Users
can assign app-local keyboard shortcuts to the command palette and individual
actions, and can favorite actions from either Settings or the palette. Favorites
sort ahead of other matching results without bypassing search, availability,
confirmation, trust, or action lifecycle rules.

The app-wide `DASH_BORED_AGENT` choice is an override, not a replacement for a
bundle's declared environment. Users can leave the Settings field empty and
save to return agent selection to the owning dashboard bundle.

Components declare actions in their manifests and register handlers while
mounted. The palette makes those actions easier to find; it does not bypass
project trust or add capabilities. Privileged work still flows through the
component's declared host APIs.

An action is a verb, an optional target, and optional typed arguments. Actions
live in three scopes: navigation (focus and app actions), presentation (select
a child, reveal a node), and domain (component, process, and agent actions).
Buttons, action bars, per-item actions, shortcuts, the palette, and the agent
control channel all invoke actions through the same executor, so there is one
place where availability, confirmation, trust, and running state are decided.

References name their targets by stable node ID, never by tree position, so
rearranging a dashboard cannot silently break a button. Components declare
their actions and argument schemas in the manifest, which lets validation check
every reference at load and lets editors and the palette list actions before
the owning component mounts. Arguments are data: a value templated from a list
item or YAML may reach an agent prompt or a process only as a typed field or
environment variable, never spliced into shell text. Actions that start an
agent are refused from the agent control channel, so agents cannot recursively
trigger agents.

Acting and observing close the loop on the same control: a button reflects the
running state and last result of the action it runs, and a process result is
itself a source that views can observe.

### 7. Components render within core-owned composition

The application provides the frames, space, and topology in which components
render. Any component may be the root of a dashboard, including a single
button or display. Focusing a component projects the configured tree around
that target: explicitly persistent ancestors and sibling navigation rails stay
visible while unrelated branches disappear. The selected target remains
per-user presentation state; the explicit persistence markers are portable
composition intent in YAML. Composition branches are not themselves components.

Focus is global navigation: one target per dashboard, suited to page-like
top-level sections with a persistent navigation rail. Selection is local
presentation: many independent containers may each show one child. Revealing a
node bridges the two by expanding it and selecting it in every switching
ancestor, which gives buttons, the palette, and agents one deep-link verb.

## Success Criteria

The product succeeds if a developer can:

1. Open an unfamiliar project.
2. Ask an agent to create a dashboard.
3. Immediately understand the project state.
4. Perform common workflows without remembering commands.
5. Extend the dashboard as new friction appears.
6. Find app, project, and component actions from one keyboard-driven palette.

## Application updates and migrations

The app discovers published canary releases at startup and
every 24 hours, with an off switch. Installation is always user initiated.
Update and migrate authorizes continuation for explicitly selected dashboards
after restart; Update only leaves migration available for later. Persist this
choice outside the app bundle, preserve drafts and running work, and distinguish
installation success from migration success. Interrupted agent work requires
explicit recovery. Refresh owned guidance, preserve customizations, and supply
a read-only version-matched handoff. All dashboard agent edits validate with at
most one repair after a successful execution, without bypassing project trust.
