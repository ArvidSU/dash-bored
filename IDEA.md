# dash-bored - Product Vision and Principles

## Vision

dash-bored is a local-first, agent-configurable project cockpit.

It provides a way to turn any project, workspace, or environment into a custom operational interface without requiring the core application to understand the project domain.

The user should not need to remember:

- which command starts a service
- which terminal a process is running in
- which browser tab contains a local UI
- how a legacy deployment procedure works
- where configuration files live
- which scripts exist and what arguments they require

Instead, the project should expose its workflows through a persistent, composable dashboard.

## Core Idea

The dashboard is not a collection of built-in integrations.

The dashboard is a runtime for composing interfaces from components.

The application provides:

- a component tree model
- a layout system
- component loading
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
└── dashboard/
    ├── dashboard.yaml
    └── components/
```

The dashboard becomes project memory.

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
- file component
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
- available slots
- capabilities

This allows:

- validation
- autocomplete
- documentation generation
- agent discovery

## Success Criteria

The product succeeds if a developer can:

1. Open an unfamiliar project.
2. Ask an agent to create a dashboard.
3. Immediately understand the project state.
4. Perform common workflows without remembering commands.
5. Extend the dashboard as new friction appears.
