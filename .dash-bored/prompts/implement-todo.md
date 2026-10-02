---
description: Implement a backlog item from the project dashboard and close it.
scope: project
input: optional
vars:
  id: Backlog item ID in node yaml-todo
---
{{> dash-bored/project}}

This is backlog item `{{vars.id}}` in node `yaml-todo` of {{dashboard.config}}. Implement it in the dash-bored app, its docs, and its skill as AGENTS.md describes: start with the README verification workflow and prove visible changes in the running dev instance. When it is implemented and verified, set `done: true` on that item. Add any deferred follow-ups to the same list instead of leaving them out.
