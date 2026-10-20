# dash-bored - Product Vision and Principles

## Vision

dash-bored is a local-first, agent-configurable project cockpit.

It visualizes a project so its health, activity, structure, and next actions can
be understood at a glance. This becomes more valuable as agent-driven work
increases the volume of code, logs, and prose people need to review: visual
understanding comes first, reading supplies the detail.

It provides a way to turn any project, workspace, or environment into a custom operational interface without requiring the core application to understand the project domain.

The user should not need to remember:

- which command starts a service
- the last command they used or where to enter the next one
- which browser tab contains a local UI
- how a legacy deployment procedure works
- where configuration files live
- which scripts exist and what arguments they require

Instead, the project should expose its workflows through a persistent, composable dashboard.

People increasingly work from their dashboards rather than beside them:
monitoring and managing resources, and deciding what to do next from several
perspectives. The app is therefore also where they learn what changed. It
keeps watching what dashboards declare and tells the user when something needs
them, as a hub for attention rather than a source of truth: project data stays
with the project and its scripts, and nothing runs because something changed
(see [Watching and notifications](#watching-and-notifications)).

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

The standard component set lives in the public `ArvidSU/dash-bored-components`
repository. Every new bundle pins it as `core` in its lock file and references
its components through `./components/external/core/<name>`. These are ordinary
external components, inspected before project trust and executed only after
trust; the application does not carry a second core component registry.

## Atoms, not a browser and not a product

dash-bored sits deliberately between two failure modes. It must not reinvent
the browser: no general layout engine, styling system, expression language, or
application framework. It must not become a use-case-specific dashboard either:
no Docker, git, npm, or CI knowledge in the app's panels; a project brings
those through its own scripts and sources. The app's own plumbing (Git-pinned
component and theme packages, package-runner agent installs) is
infrastructure, not a dashboard feature. Diversity comes from a small
set of well-executed atoms that an agent can combine with a little YAML through
the app's contracts.

Every atom serves one of three jobs:

- **Overview** — core tiling, one titled group, and single-child selection for
  switching between panels.
- **Act** — one action model, surfaced through the palette, buttons and action
  bars, per-item actions, and persistent commands.
- **Observe** — sources that produce data, a few views that render
  declared data shapes, and watches that keep observing them while nobody
  looks.

The shell is the integration layer. The app defines data shapes and view
contracts; project knowledge lives in a small command or script the agent
writes whose output matches one of those shapes. Transforming data is the
script's job, never a YAML mini-language.

The test for the atom set is the project's own dashboard: a project-specific
list, fact sheet, or runnable-script catalog should be a few lines of YAML plus
a script. When something still needs a local React component, first ask which
atom is missing before adding one, and never promote a domain-specific
component to a core component.

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
component model, then start the user's chosen agent with a project-specific prompt.

Every initialized bundle also carries a succinct README for teammates who have
never used dash-bored: explain the app and bundle files, link to downloads, and
show how to install a release that opens the bundle's schema and get started.
A project-owned helper may download, verify, and open that installer; installation
and trust still use the normal desktop workflows.

Previously installed skill payloads follow app updates while
preserving local edits and reporting conflicts. Successful maintenance is not a
diagnostic; only an unresolved conflict needs to remain visible. The setup
action owns its agent
task independently of the starter component. After completion the app validates
the saved dashboard and may request one bounded repair of configuration errors;
validation does not replace the user's review of usefulness or permission changes.
Project trust is remembered across app restarts for the approved capability set.
Validation errors do not prevent approval when the app can inspect the complete
requested capability set. A readable tree with a wrong schema marker, invalid
props or action references, or a component compile failure can be trusted and
then repaired with the configured agent. Fatal errors that prevent safe,
complete capability inspection block a new trust decision, but not repair: the
configured agent can run as an untrusted repair that grants no capabilities,
receives no project-controlled environment or agent selection, and leaves the
normal review to follow. Invalid dashboards
still do not execute; after repair, added permissions require another review.
When an installed-tool conflict is shown, the user may explicitly move the
conflicting managed install to the OS Trash and reinstall the current payload.

Every rendered component should make that workflow immediate through a small
context menu. Alongside Focus, users can edit a component's declared props,
collapse or expand it to keep large dashboards compact, copy an exact
config-and-tree locator, or describe a wanted change and send it to the user's
chosen agent. The app enriches that request with dash-bored, project, and
component context; it does not hide which agent command will run.

The cockpit dispatches agents to two kinds of work: changing the dashboard, and
doing work in the project itself (implementing a backlog item, reviewing a
change, fixing a red check). Both are prompt templates. The app ships a
`dashboard` and a `project` template as defaults, and a bundle may add its own
or override the defaults with plain Markdown files, so a project decides how
its agents are briefed. A template is filled from the user's reviewed input,
typed values from the invoking button or list item, declared environment
values, and the app's context. The user sees the complete prompt before
sending it. A template's scope, not its wording, decides what the app reviews
afterwards: dashboard work is validated; project work is reported through the
agent's own account of it and handed off when the user wants to review it.

Direct manipulation complements that primary workflow. The desktop app offers
a right-hand component-library flyout for arranging existing components,
filling their declared props, and adding or removing branches. Opening the
flyout is read-only; the first insertion, move, removal, replacement, metadata
edit, or horizontal ratio resize implicitly starts a draft. Only actual unsaved
changes show Save/Cancel or block agent edits and navigation; inspecting settings,
cancelling an insertion, or reverting every change requires no exit from editing.
Save/Cancel remains the
boundary for publishing or discarding the same project-owned YAML tree, rather
than a second layout model or a hidden application database.

## Agents as first-class clients

The agent has become the primary way to build, change, and fix a dashboard,
and dispatching work from a dashboard that is not primarily about agents has
its own uses. Agents are therefore first-class in the app through one open
standard: dash-bored is an [Agent Client Protocol](https://agentclientprotocol.com)
(ACP) client. It starts the user's chosen ACP agent as a local subprocess in
the owning project, briefs it with the reviewed prompt, and renders the session
the protocol describes: the agent's messages and plan, its tool calls and their
progress, its permission requests, and the model and mode choices it offers.
The user can make those choices before the first prompt and the app remembers
them per agent. The user answers permission requests, sends follow-up messages,
and stops work in the app.

The scope stays an agent-driven dashboard app, not an agent harness, IDE, or
editor. The agent owns its model, credentials, tools, and loop; the app holds
no provider keys and contains no agent-specific code paths. ACP is the only
integrated agent path; any other CLI can still run in a command component's
terminal. The app reviews what an agent did to its own territory, the dashboard
bundle, by validating it. It shows no file diffs of the bundle or the project:
diffs belong to custom components or external apps. When work leaves the app's
scope, the user hands the session off and the app resumes that same session in
the agent's own app; the app then lets go of the session.

Agent setup is a checklist in Settings. Users enable the known ACP agents they
want in the picker and choose a default, or supply a custom launch command.
The app prefers an installed executable on `PATH`; explicitly enabling a
supported package authorizes its package runner to download and cache it on
first use. Setup shows that distinction and missing prerequisites before launch.
Merely opening Settings never downloads or runs an agent. Signing in belongs
to the agent. Disabling an agent removes its picker choice without uninstalling
it or interrupting an existing session; explicit custom and bundle commands
remain available.

Each request is one ACP session. Dashboard work is validated when the agent
finishes a turn; when bundle-fixable errors remain, the single automatic repair
is a follow-up message in the same session, so the agent keeps its context.
Sessions are app-session state: the app keeps them in memory and stops its
agent processes on quit.

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
window. An explicit Bring app to front action lets an agent show and focus the
window when it finishes work or needs the user's attention. Within the window,
a Draw attention action reveals one component, or one item in it, plays a
short attention animation on it, and says why in a notice, so the agent can
point at the result or blocker rather than describe where it is. A Notify
action tells the user the same thing without taking focus from other work and
lands on the component when they follow it, so it is the default for
completion or a blocker; Bring app to front remains for when the user asked to
be shown. Agents use all three sparingly for meaningful completion or blockers,
after making the relevant result visible. The channel never widens what a
palette action may do: trust decisions and actions that require user
confirmation stay with the user.

Development builds are agent-owned proof environments. Each checkout can run
its own native instance, and agents may start, restart, and stop that instance
without asking the user. The actual development channel automatically trusts
dashboard capabilities for that process; installed releases retain the normal
project trust decision. Development instances keep their state separate and do
not maintain the user's global skill installation.

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

Core, other external and project-local components use exactly the same
manifest, render, host, children and capability contract. They differ in
provenance; all require normal project trust before execution.

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

Users should still see when a pinned component or theme package has moved on.
The app's update checks also compare every pin with its repository's default
branch, reading remote refs only, and Settings → Updates lists the packages
that are behind. Updating one, or all, remains an explicit action that passes
the normal trust check.

Dash-bored owns private Git repositories at each bundle's `components/external/`
and `themes/external/`. Generated bundle ignore rules keep these checkouts and
their Git metadata out of the parent project's repository. The parent can
track the dashboard, local code, and lock file. The lock is authoritative:
initialization and opening restore missing packages at their exact pins, even
outside a parent Git project; existing checkouts are never implicitly updated.
Ordinary package operations do not edit the parent's Git metadata. Conversion
of an existing parent-owned submodule is an explicit migration.

An external component uses exactly the same manifest, render, host, children,
and capability contract as a project-local one. It differs only by provenance
(`components/external/<name>`) and trust: like any project code it runs in
the shared renderer after a project trust decision, and changing its pin
re-runs the permission-union trust check. The library flyout surfaces that
trust delta and never bypasses it.

## Versioned component authoring

Component manifests declare both their manifest schema version and the
component API version they target. `schemaVersion: 3` identifies the current
manifest format; every core, external, and project-local component also
declares a required, exact stable-semver `apiVersion`. The application rejects
missing or unsupported API versions before loading component code and gives
authors an actionable diagnostic. Schema-v2 manifests require an explicit
migration; the app never upgrades their meaning silently.

The public authoring SDK has its own stable version line, beginning at
`1.0.0`. Its runtime contracts and offline type definitions ship with the app
and are exposed to component authors through `@dash-bored/component`. Additive
optional APIs may use minor releases, with deprecation notes before removal;
breaking changes require a major release and migration guidance. Host
capabilities remain optional and are checked at the boundary at runtime.
Published components include generated JavaScript runtime and declaration
output, and their source and declarations can be checked semantically before
they are loaded.

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

## Attention animations

Attention animations follow the same model. The app ships a few built-ins
(bounce, shake, pulse, wiggle, glow), and users and agents author their own as
versioned `animation.yaml` packages, personally or in a dashboard bundle. An
animation is bounded keyframe data: small offsets, rotation, scale, opacity,
and a halo in a theme color, finite in length, with no CSS, code, or assets.
A request names an animation or falls back to the dashboard's optional
default. Reduced motion keeps the halo and drops movement.

## Watching and notifications

dash-bored is a hub for attention, not a source of truth. The selected
dashboard is the default way something gets the user's attention: it already
narrows what they need to scan. Notifications go one step further for what
matters even when its component is not rendered, such as a failed GitHub
Actions run in a project whose dashboard is not selected. The app watches and
points; the project's scripts and sources still own the data, and the app keeps
no record of it beyond its notifications for the app session.

Every notification is a decision: the user dismisses it or acts on it. Show
lands on what it is about, and an entry may offer one declared action, such as
Fix with agent, alongside it; app-level entries land in Settings, and agent
entries open their session. Acting marks the decision read but keeps it open,
because looking at a failure does not fix it: the declared action and Dismiss
stay available. An open decision closes when the user dismisses it or when the
condition that raised it clears: a recovered status, an answered permission
request, or a new run of the command that failed. Closed decisions stay listed
for the session and say whether they cleared or were dismissed, so the inbox
doubles as a short log of what needed attention and whether it still does.

An event reports a transition, never a repeated state, and comes from a closed
set the app understands: a run the user started failed, or finished after long
enough that they moved on; an agent session needs permission or sign-in,
finished its turn, or failed; an app release or package update became
available; or a watched view's declared data shape changed, such as a status
turning to warning or error, or a list gaining items. Agents raise the same
kind of event with the Notify action. A watch is composition intent on a node,
not a condition language: it names which transitions of the view's own shape
matter. Deciding what counts as bad, combining sources, and transforming data
stay the script's job.

Watches keep observing while their view is hidden and their dashboard is not
selected, so they run in the background, at a bounded rate, for every
registered and trusted dashboard. Watching is its own permission: trust review
shows that a dashboard watches in the background, and a project's first watch
requires approval again. Watching lasts as long as the app runs and stops when
it quits; there is no daemon, login item, or menu-bar agent. The first
observation after the app starts is a baseline: one that already shows a
notified state is recorded without interrupting.

Events have two levels. Interrupt is for what needs the user soon: a blocked,
finished, or failed agent, a failed or long run, a watched state turning bad,
and a new app release. Inform is for what is worth knowing: package updates,
new list items unless the watch asks for more, and watches that are failing or
paused. An interrupt becomes a system notification while the app is in the
background, and following it brings the app forward with the decision in
front; in the frontmost window it is an in-app notice. Nothing interrupts about
a component the user is already looking at; such a decision is recorded as
read. Open and closed decisions wait in a bounded inbox for the app session,
like agent sessions, and the sidebar marks dashboards with unread ones. Users
can lower or mute notifications per dashboard; that choice is per-user state,
not YAML.

Acting goes through the same executor, confirmation, and trust as any other
invocation, and only when the user chooses it. Events inform and never act: no
event starts a process, an agent, or a write by itself.

The planned work lives in
[docs/roadmap/notifications.md](./roadmap/notifications.md).

## Visual understanding

A dashboard should answer “where does this stand?” before asking the user to
read. Put current state, trends, and a bounded view of open work in the first
scan; move full backlogs, logs, and documentation into detail views. Observed
state must come from real sources, including explicit unknown and failed reads.

Use consistent visual grammar across generic atoms: color plus shape for state,
clear selected navigation, quieter metadata, and grouped related information.
Reserve signal colors for meaning: healthy state reads calm, and only state
that needs attention tints its surface. Chrome recedes so attention falls on
data and available actions: one level of framing, headings rather than nested
boxes, and editing affordances that appear on hover or focus. Light and dark
themes must preserve hierarchy and readable secondary text. A project-specific
visualization belongs in its bundle and uses the same theme and capability
contracts.

Interactions should reveal detail and make the next action clear. Motion explains
arrival, selection, work in progress, or a request for the user's attention; it
should be brief, respect reduced motion, and preserve layout during polling.
Decorative continuous animation competes with the project and should be avoided. Keyboard focus and textual
state remain available alongside every visual cue.

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
    ├── README.md
    ├── install-app.sh
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
├── README.md
├── install-app.sh
├── .env
├── components/
└── arvid/
    ├── dash-bored.yaml
    ├── dash-bored-lock.yaml
    ├── README.md
    ├── install-app.sh
    ├── .env
    └── components/
```

Each bundle is independently loadable and owns its lock file, environment, and
local components. Dashboards compose only by using another config bundle's path as a
component reference. The referenced dashboard receives the same kind of
rectangular space as any other component; configs are not merged and neither
inherits from the other.

### 3. Components over integrations

This guidance is about the component set shipped with dash-bored: keep that
core set small and composable instead of adding a separate integration for
each domain. It does not constrain components created for a particular
dashboard. A purpose-built component is appropriate whenever it best serves
that dashboard's use case; for example, a button that runs `npm run check`
can be exactly the right component.

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
The palette keeps application controls available while limiting dashboard
actions to the selected dashboard. Choosers keep long target lists out of the
main results: one Switch dashboard chooser covers other registered dashboards,
and Focus, Reveal, and Select panel choosers cover the selected dashboard's
components and panels. Searching a target's name still finds it directly under
its chooser, and every choice step uses the same search box and result list. Users can drag sidebar dashboards into their
preferred saved order. With the palette closed, Command reveals number hints on
the first nine dashboard icons, and Command plus 1–9 navigates in that order.
Selecting the already active dashboard by sidebar click or Command number toggles
sidebar expansion; from Settings it returns to the dashboard.
Holding Command while invoking an action
keeps the palette open for successive actions; a user setting decides whether
to clear its search, with clearing as the default. The palette remembers each
dashboard's recent runs, including the options chosen for them, and lists them
in a Recent section above every other result. Searching filters that section
like the rest, so a repeated workflow stays one keystroke or a short search
away; replaying a run keeps the action's normal choices, confirmation,
availability, and trust rules.

Application settings separate general behavior, appearance defaults and
per-dashboard appearance selections from the action catalog. Users
can assign app-local keyboard shortcuts to the command palette and individual
actions, and can favorite actions from either Settings or the palette. Favorites
sort ahead of other matching results without bypassing search, availability,
confirmation, trust, or action lifecycle rules.

The app-wide agent choice is an override, not a replacement for a bundle's
declared `DASH_BORED_AGENT`. Users can clear the Settings choice to return
agent selection to the owning dashboard bundle. A single request in the agent
composer may instead pick the app default, the bundle's agent, a detected
agent, or a custom ACP command, always showing the command that will run.

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
trigger agents; the channel likewise cannot answer an agent's permission requests.

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
7. Step away from their dashboards and be told when something on one needs
   them.

## Application updates and migrations

The app discovers published canary releases and newer commits for pinned
component and theme packages at startup and every 24 hours, with an off switch.
Installation is always user initiated.
Update and migrate authorizes continuation for explicitly selected dashboards
after restart; Update only leaves migration available for later. Persist this
choice outside the app bundle, preserve drafts and running work, and distinguish
installation success from migration success. Interrupted agent work requires
explicit recovery. Refresh owned guidance, preserve customizations, and supply
a read-only version-matched handoff. All dashboard agent edits validate with at
most one repair after a successful execution, without bypassing project trust.
Nonfatal configuration errors permit normal trust approval before diagnostics
repair; fatal capability-inspection failures must be fixed before approval,
through an untrusted repair run of the configured agent in the app or outside
it.
