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

## Agent-First Philosophy

The primary way users customize dashboards should be through natural language.

Example:

> Add a component in the development tab showing the health of all services in the Docker Compose stack.

The agent should:

1. Inspect the project.
2. Search available components.
3. Reuse an existing component if appropriate.
4. Otherwise create a local component.
5. Modify the dashboard configuration.
6. Reload the dashboard.

Creating a dashboard should feel closer to asking an agent to modify code than configuring a traditional dashboard product.

The starter dashboard should make that workflow self-contained: it can install
global or project-local guidance that teaches compatible agents the dash-bored
component model, then launch the user's chosen CLI agent with a project-specific prompt.
The desktop app carries a version-matched dash-bored CLI and skill payload so
the generated dashboard, the agent's discovery commands, and the component
contract do not depend on a separate global dash-bored installation.

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
Complex containers may additionally declare managed child presentation and a
schema for metadata attached to each child. Components receive generic child
handles, read-only descriptors, and a projected render/visibility interface;
tabs, accordions, and similar presentations therefore need no app-level,
component-ID-specific behavior. A tab label is metadata on the parent-child
edge, not a special component prop.

YAML is the only source of truth. It recursively describes both the topology
and component composition; no hidden grid database or parallel coordinate
model exists. Packaged and project-local components use exactly the same
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
updated only by an explicit user action. This keeps reuse reproducible and
reviewable without a second distribution model.

An external component uses exactly the same manifest, render, host, children,
and capability contract as a project-local one. It differs only by provenance
(`components/external/<name>`) and trust: like any project code it runs in
the shared renderer after a project trust decision, and changing its pin
re-runs the permission-union trust check. The library flyout surfaces that
trust delta and never bypasses it.

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

- command component
- process component
- HTTP component
- Markdown component with inline or project-file content
- graph component
- status component

Domain-specific functionality should be composed from primitives.

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

Application settings separate general behavior from the action catalog. Users
can assign app-local keyboard shortcuts to the command palette and individual
actions, and can favorite actions from either Settings or the palette. Favorites
sort ahead of other matching results without bypassing search, availability,
confirmation, trust, or action lifecycle rules.

Components register actions while they are mounted. The palette makes those
actions easier to find; it does not bypass project trust or add capabilities.
Privileged work still flows through the component's declared host APIs.

### 7. Components render within core-owned composition

The application provides the frames, space, and topology in which components
render. Any component may be the root of a dashboard, including a single
button or display, and any rendered component may be focused as a temporary
virtual root. Composition branches are not themselves components, and
components cannot claim app-level layout or persistence special cases.

## Success Criteria

The product succeeds if a developer can:

1. Open an unfamiliar project.
2. Ask an agent to create a dashboard.
3. Immediately understand the project state.
4. Perform common workflows without remembering commands.
5. Extend the dashboard as new friction appears.
6. Find app, project, and component actions from one keyboard-driven palette.
