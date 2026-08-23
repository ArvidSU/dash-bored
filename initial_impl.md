# dash-bored - Initial Implementation Plan

> **Historical, non-normative document.** This file is preserved as early
> implementation inspiration. [IDEA.md](./IDEA.md) defines product direction
> and [ARCHITECTURE.md](./ARCHITECTURE.md) defines the current implementation;
> where they differ, those documents take precedence.

## Goal

Build the smallest useful version of the component runtime.

The first milestone is not a marketplace or AI generation system.

The first milestone is proving:

> A project can describe its own useful development cockpit through configuration and components.

## Phase 1 - Runtime Prototype

Build:

- desktop application shell
- configuration loader
- recursive component tree renderer
- local component loading
- hot reload

Suggested stack:

- Electrobun
- TypeScript
- React
- YAML configuration

Example:

```
dashboard.yaml
```

loads into:

```
ComponentNode
    |
    +-- Component
         |
         +-- Child slots
```

## Phase 2 - Core Components

Implement only primitives.

Required:

### Layout

- tabs
- horizontal split
- vertical split

### UI

- button
- text
- status
- markdown

### Functional

- command runner
- terminal output
- iframe/webview
- file viewer

## Phase 3 - Component Contract

Define:

- component manifest
- loading mechanism
- props schema
- slot schema
- permissions model

Example:

```
component/
├── manifest.json
├── index.ts
└── schema.json
```

## Phase 4 - CLI

Create a CLI for humans and agents.

Commands:

```
dashboard init
dashboard open .
dashboard validate
dashboard inspect
dashboard component search
dashboard component describe
dashboard component create
```

The CLI is the agent interface.

## Phase 5 - Agent Workflow

Enable:

```
User:
"Create a dashboard for this project"

Agent:
- inspect project
- generate dashboard.yaml
- generate missing components
- reload application
```

Do not build custom AI infrastructure initially.

Make the system easy for existing coding agents to operate.

## Phase 6 - Ecosystem

Only after the runtime is proven:

Add:

- component registry
- component publishing
- component discovery
- shared templates
- project dashboard templates

## First Example Dashboard

Target:

A generic web application project.

Generated dashboard:

```
Development
├── Services
│   ├── API status
│   ├── Frontend status
│   └── Database status
│
├── Commands
│   ├── Start development
│   ├── Run tests
│   └── Build
│
├── Logs
│
└── Application
    └── localhost webview
```

The system should not know this is a web application.

The dashboard should emerge from components and configuration.

## Long-Term Direction

The end state is:

```
Project
   |
   v
Agent understands project
   |
   v
Agent creates/maintains dashboard
   |
   v
Developer works through dashboard
```

The dashboard becomes the persistent operational memory of the project.
