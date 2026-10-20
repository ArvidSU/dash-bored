# Notifications roadmap

Work packages that make dash-bored the hub for attention described in
[IDEA.md](../IDEA.md#watching-and-notifications): the app watches what
dashboards declare, puts a decision in front of the user when something needs
them, and lands them on it, without becoming a source of truth or acting on
its own.

This file is a plan, not a contract. The implemented decisions live in
[Notifications and watches](../architecture/notifications.md); anything a
package defers goes to `props.todos` of node `yaml-todo` in the project
dashboard.

## Implementation status

| Package | Status | Evidence and remaining work |
|---|---|---|
| N1 | Implemented | Runs, agent sessions, app releases, package updates, and `notify:<node>` raise decisions; system notifications in the background, dock badge, Settings switches. Closed `todo-acp-permission-notify`. Clicks on a system notification cannot be routed (`todo-notification-click-routing`). |
| N2 | Implemented | Inbox drawer, decision notice, sidebar marks, per-dashboard levels, `app status` summary. Acting marks a decision read and keeps it open; closed decisions stay listed under Earlier for the session. Cross-dashboard Show lacks UI-test coverage (`todo-notification-cross-dashboard-ui-test`). |
| N3 | Implemented | Node `watch` with the `background:watch` permission; the project dashboard watches CI on main, its own config health, and new open work. A visible view and its watch still poll separately (`todo-watch-shared-observation`). |

## Boundaries

These hold for every package:

- **Every notification is a decision.** It offers Dismiss and at least one
  act: Show, plus at most one declared action. Acting marks it read; it
  closes when the user dismisses it or its condition clears.
- **Events inform and never act.** No event starts a process, an agent, or a
  write; a declared action runs only when the user chooses it, through the
  shared executor.
- **Transitions, not states.** A repeated observation never notifies twice.
- **A closed event set.** Core defines each event kind. A watch selects
  transitions of a view's declared data shape; there is no condition,
  expression, or transform language.
- **The app session is the horizon.** Watching stops when the app quits and
  neither the inbox nor its history is persisted. No daemon, login item, or
  menu-bar agent.
- **Trust shows background work.** Watching is its own permission.

## What changed against the plan

- Trust is a subset check on permissions, so watching is the
  `background:watch` permission: a project's first watch requires approval
  again, but changing a watch does not, like changing a shell source.
- Recovery resolves a status decision instead of raising an inform entry.
- Acting no longer closes a decision. Closing on Show hid whether the problem
  remained and took away Fix with agent, so Show, the declared action, and a
  target already on screen mark it read; it stays open until it is dismissed
  or its condition clears. Unread entries drive the badge, the header count,
  and sidebar marks. Closed decisions move to Earlier in the inbox for the
  session, marked Cleared or Dismissed, so it doubles as a short log.
- `process` sources cannot be watched; failed runs already raise decisions.
- Electrobun's system notifications report no click. Following one brings the
  app forward and the newest pending decision comes to the front; main
  publishes its window focus because the webview's `document.hasFocus()` can
  stay false after such an activation.
- A run's success notifies only after at least 10 seconds; runs that passed
  through `stopping`, stop signals, and runs agents start stay quiet.
- `app:dismiss-notifications` is reserved for the user.

## Deferred

- Event-triggered actions remain deferred with the other
  [atoms roadmap](atoms.md#deferred) triggers.
- Notifications from custom components through a host API
  (`todo-notifications-component-api`).
- Watches over `chart` and `markdown` shapes.
- Persisting the inbox across restarts.

Excluded: delivery to external services (chat, email, webhooks), which would
make dash-bored act on events; a project script can do that itself.
