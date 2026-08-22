# dash-bored - Architecture Design

## Overview

dash-bored is a component tree runtime.

The application does not understand individual dashboard features.

It loads a configuration tree and renders components.

Conceptually:

```
dashboard.yaml
      |
      v
Component tree
      |
      v
Component resolver
      |
      v
Component runtime
      |
      +--> UI
      |
      +--> Host capabilities
```

## Dashboard Configuration

The fundamental structure is a recursive component tree.

Example:

```yaml
tabs:
  development:
    component: "@dashboard/split"
    props:
      direction: horizontal

    slots:
      first:
        component: "./components/project-controls"
        props:
          command: npm run dev

      second:
        component: "@dashboard/webview"
        props:
          url: http://localhost:3000
```

Every node has:

```yaml
component:
props:
slots:
```

The host only understands this structure.

## Component Model

A component is a package exposing:

- metadata
- configuration schema
- slots
- rendering logic
- optional actions
- optional data sources

Conceptually:

```typescript
interface Component {
  id: string;

  schema: Schema;

  slots?: SlotDefinition[];

  permissions?: Permission[];

  render(context: ComponentContext): UI;
}
```

## Component Types

Components naturally fall into categories:

### Container components

Examples:

- split panes
- tabs
- cards
- stacks

They primarily arrange child components.

### UI components

Examples:

- buttons
- tables
- graphs
- forms
- status indicators

### Functional components

Examples:

- terminal
- process runner
- file editor
- HTTP client

## Package Resolution

Components can come from:

Local paths:

```yaml
component: "./dashboard/components/service-health"
```

Package manager:

```yaml
component: "@dashboard/service-health"
```

Git repositories:

```yaml
component: "github:user/project"
```

Components should resolve into a local cache and support locking for reproducibility.

Example:

```
dashboard/
├── dashboard.yaml
└── dashboard.lock
```

## Host API

Components should receive controlled capabilities from the host.

Possible capabilities:

```typescript
interface DashboardContext {
  workspace: Workspace;

  filesystem: FilesystemAPI;

  processes: ProcessAPI;

  shell: ShellAPI;

  http: HTTPAPI;

  storage: StorageAPI;

  dashboard: DashboardAPI;
}
```

Capabilities should eventually support permissions.

Example:

```yaml
permissions:
  filesystem:
    - read

  process:
    - execute: docker
```

## Validation

Validation has two levels.

### Generic validation

The host validates:

- YAML structure
- component references
- recursive tree correctness

### Component validation

Components provide schemas for:

- props
- slots
- permissions

Possible schema technologies:

- JSON Schema
- Zod
- TypeBox

## Agent Interface

The application should expose machine-readable introspection.

Examples:

```
dashboard inspect
dashboard component describe @dashboard/split
dashboard component search "docker health"
```

Agents should be able to discover:

- existing components
- component schemas
- current dashboard tree
- available actions

## MVP Component Set

Initial built-in components:

- split
- tabs
- terminal
- command button
- markdown viewer
- webview
- file viewer/editor
- process viewer
- status indicator

Avoid domain-specific integrations initially.
