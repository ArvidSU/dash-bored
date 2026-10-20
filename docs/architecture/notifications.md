# Notifications and watches

A notification is a decision about something outside the user's current view
([product intent](../IDEA.md#watching-and-notifications)). Every entry offers
Dismiss and at least one act. Acting marks it read; it stays open until the
user dismisses it or the condition that raised it clears, and then moves to
the session's history. Main owns the inbox, the history, the producers,
delivery, and background watches; the renderer presents decisions and carries
out the user's choice through the shared action executor.

## Contract

`src/shared/notifications.ts` owns the app-internal types (deliberately outside
`contracts.ts`, whose declarations ship in the SDK): `NotificationEntry` with
its `read` flag, its closed `NotificationKind` set, `NotificationTarget` (a
node with an optional item, an agent session, Settings › Updates, or a whole
dashboard), the optional declared `NotificationAction`,
`ClosedNotificationEntry` (an entry plus `closedAt` and `closedBy`, `cleared`
or `dismissed`), and `NotificationCommand`. Titles are bounded to 120
characters and messages to 200, with whitespace collapsed.

`AppSettings.notifications` holds the per-user preferences: `native` (system
notifications while the app is in the background), `watches` (background
watching), and `dashboards`, a level per canonical config path (`all`, the
default, `inform`, or `off`). Levels are never written to YAML.

Host state reaches the renderer as the `notifications` push: the whole open
inbox newest first, the history most recently closed first, and main's
`windowFocused` (the Electrobun window's key state; the webview's
`document.hasFocus()` can stay false after the app is activated by a system
notification); `getNotifications` reads it once on mount. A focus change
pushes the inbox again. `notificationCommand` marks entries read (`read`:
Show, the declared action, or a target already on screen), closes dismissed
ones (`dismiss`), dismisses all entries or one dashboard's (`dismiss-all`),
empties the history (`clear-history`), or raises `notify:<node>`.

## The center

`src/main/notification-center.ts` holds the open decisions and the history.
Producers call `raise` with a coalescing key and `resolve`/`resolvePrefix`
when a condition clears. A raise:

1. Applies the dashboard's level: `off` drops it, `inform` downgrades an
   interrupt.
2. Coalesces into the open entry with the same key, keeping its ID, counting
   raises, and replacing title, message, target, and action. A coalesced
   raise never downgrades an open interrupt. A new entry is unread; a read
   one becomes unread again when the raise changes its title or message or
   presents it, so a repeated observation stays read.
3. Presents an interrupt unless the raise is `quiet` or the same key (or, for
   `notify`, the same dashboard) was presented within 30 seconds. Presenting
   assigns the next value of a global `presentation` sequence; the renderer
   presents entries whose value it has not handled. When the window is not
   focused (Electrobun `focus`/`blur`), main also shows a system notification
   through `Utils.showNotification` unless `native` is off, and marks the
   entry `deliveredNatively`.
4. Keeps at most 50 open entries per dashboard (and 50 app-level entries),
   dropping the oldest inform entries before interrupts and read ones before
   unread ones. Dropped entries do not enter the history.

A resolved key moves its entry to the history as `cleared`, and a dismissal as
`dismissed`, both with `closedAt`. The history keeps the 100 most recently
closed entries across dashboards and lasts for the app session; a raise with
the key of a closed entry opens a new entry with a new ID. Every change
pushes the whole inbox and sets the dock badge to the number of unread open
interrupts (`src/main/dock-badge.ts`, `NSDockTile setBadgeLabel:` through the
Objective-C runtime on the AppKit main thread; best effort). Deleting a
dashboard forgets its open and closed entries (`retainDashboards`).

Electrobun's system notifications report no click. Clicking one only
activates the app; the renderer then puts the newest unhandled decision in
front (see [Presentation](#presentation)).

## Producers

`src/main/notification-producers.ts` derives events from state main already
publishes; `src/main/notification-wiring.ts` connects them in `index.ts`.

| Kind | Source | Level | Key; cleared by | Target and act |
| --- | --- | --- | --- | --- |
| `run-failed` | a run of the active dashboard ends unsuccessfully | interrupt | `run:<config>:<node>`; the node's next run | node; Fix with agent (`agent:prompt`) |
| `run-finished` | a run ends with exit 0 after at least 10 s | interrupt | same | node |
| `agent-needs-you` | a session enters `waiting` or `auth-required` | interrupt | `agent:<task>:needs`; leaving that state | agent session |
| `agent-finished` | busy work ends idle, after validation | interrupt | `agent:<task>:outcome`; new work | agent session |
| `agent-failed` | the session fails or validation still fails | interrupt | same | agent session |
| `app-release` | a newer release than the running app | interrupt once per version | `app-release`; running that version | Settings › Updates |
| `package-updates` | a finished package check finds updatable packages | inform | `package-updates`; none left | Settings › Updates |
| `notify` | `notify:<node>` | interrupt | `notify:<config>:<node>:<item>` | node or item |

Runs are quiet when they passed through `stopping` (the process manager
reports every requested stop that way: Stop, a dashboard switch, a trust
change, quit), when they ended by SIGHUP, SIGINT, SIGKILL, or SIGTERM or the
shell's 128+n code for them, and when an agent-control action started them:
`processCommand` start and quick-action record whether an agent action was in
flight. Cancelled and handed-off agent work is quiet, and closing a session
clears its entries. The last release that interrupted is remembered in
`notifications-v1.json` beside the other user data, so a restart does not
interrupt again for the same version.

## Presentation

`src/renderer/app/use-notifications.ts` keeps the inbox current from the push
(a push that beats the initial read wins) and applies each command locally
(`applyNotificationCommand`) before the host confirms.
`src/renderer/lib/notifications.ts` holds the pure rules;
`src/renderer/panels/Notifications.tsx` the decision notice, the inbox
drawer, and the Settings card.

`decidePresentation` runs after each render that shows a new inbox, on window
`focus`, and on `visibilitychange`, never while the document is hidden. It
takes unread interrupts whose `presentation` exceeds the value already
handled for that entry (tracked per entry, so a deferred system notification
is not skipped when a newer in-app one is handled; read entries are skipped,
so a reloaded window does not present them again). An entry that went out as
a system notification waits until `document.hasFocus()`; an in-app one does
not, because focus may sit in a native webview. Then each pending entry whose
target is on screen is marked read, and the newest other one becomes the
decision notice; the rest stay in the inbox and the notice counts them. The
notice goes away once its entry is read or closed, and only a new
presentation brings it back.

On screen means: for a node, the dashboard view is active with no dialog or
palette open, the entry belongs to the active dashboard, and the node's frame
(or its `data-item-id` element) is inside `.workspace` with at least 24 px
showing each way within the page scroller; for Settings › Updates, that tab
is open; for an agent session, the Agent work drawer lists it or its modal is
open; for a dashboard target, that dashboard is shown. A target the user
reaches later does not mark its decision read.

The decision notice sits in the page flow under the header, so native
webviews cannot cover it. It offers Show, the declared action, and Dismiss,
announces politely, stays while hovered or focused, hides after 15 seconds
otherwise, and Escape hides it without deciding (focus returns to the bell).
The bell counts unread interrupts (or, without any, unread entries) and names
open read entries in its accessible name. It opens the inbox drawer (the
shared right drawer, exclusive with Agent work and the component library):
open rows newest first with a level glyph, title, message, source dashboard,
relative time, and `×N` for coalesced raises, plus Dismiss all. Unread rows
are tinted, carry a dot, and say "unread" to assistive technology. Below them,
Earlier lists the history: a muted row per closed entry naming how it ended
(Cleared with a check, Dismissed with a cross), when, and from where, with
Show only, plus Clear. Sidebar dashboard icons carry a mark for unread entries
whose shape distinguishes interrupts from informs, described in the link's
accessible name.

Show and the declared action mark the entry read and leave it open, so the
other act and Dismiss stay available; a declared action whose confirmation
the user cancels leaves its decision open. Show on a closed entry from
Earlier lands the same way. Show on a node target of another dashboard opens
it through the normal navigation (a dirty draft still asks), then, once the
snapshot's `configPath` matches within 30 seconds, runs `attention:<node>`
with the entry's message and item through the shared `ActionStore`; a missing
item falls back to the node, and a missing node lands on the dashboard with a
notice. Agent-session targets open the session modal; update targets open
Settings › Updates. The declared action switches dashboards the same way and
runs through the same request path as a button, so confirmation, palette
choices, and the reviewed agent composer still apply.
`app:toggle-notifications` and `app:dismiss-notifications` are palette
actions; the latter is reserved for the user. `notify:<node>` actions exist
for every node of the active dashboard as sub-actions that palette search
does not list, because they need a message.

## Watches

A node's `watch` (contract in [Project contract](./project-contract.md))
keeps its own `props.source` under observation in the main process.
`src/shared/watches.ts` holds the Node-free parts: the event families, the
source and shape parsers (mirroring the core status and list views), item
templates, limits, and the summaries that trust review and
`inspect --summary` (`watches`) show. `src/main/watch-evaluation.ts` is the
pure state machine; `src/main/watches.ts` the `WatchRunner`.

Planning loads every registered dashboard plus the active one with
`loadProjectDefinition` (no compilation), one at a time: about 10 seconds
after start, then every 10 minutes, and, debounced by a second, whenever the
active snapshot's config path, revision, or trust changes, the notification
settings change, or a dashboard is removed. Only nodes owned by that config
run; a linked bundle's watches run when that bundle is registered itself. A
dashboard muted to Off is held silently. A dashboard that declares watches but
is not runnable (untrusted, configuration errors, or past the cap of 40 watches
app-wide) gets one inform `watch-paused:<config>` entry naming why, resolved
once it runs or no longer declares watches. Unchanged watches keep their
baseline and timer across plans; a changed or removed one resolves its keys.

Each watch has its own timer chain: the first read 3 seconds plus a
1.5-second stagger after planning, each next read `every` after the previous
one completes, so one read is in flight and a sleeping machine wakes to one
read rather than a burst. Before every read the runner rechecks that the
dashboard is still registered and trusted. `notifications.watches: false`
stops every watch and clears its state.

Evaluation:

- **Status** (`unknown`, `warning`, `error`). The first successful read after
  start or a change is the baseline: a state in `on` is raised quietly, as an
  open decision that does not interrupt. Later, entering a state in `on`, or
  moving to another one, raises `watch:<config>:<node>` (`watch-state`,
  interrupt unless `level` says otherwise) with the node's label, a message
  like `Error: <detail>`, and the declared action. Leaving the `on` set
  resolves it: recovery closes the decision rather than raising another.
- **List** (`added`). The first read records the item IDs. Each new ID raises
  `watch:<config>:<node>:item:<id>` (`watch-item`, inform by default) targeting
  that item, with the action's `${item.<field>}` templates resolved; at most
  five per read, the rest coalesce into `…:more`. An item that disappears
  resolves its entry.
- **Failure** (nonzero exit, timeout, HTTP error, or a value that does not
  match the shape) raises one inform `watch-error:<config>:<node>` per failing
  streak, leaves the baseline alone, and the next good read resolves it.

A visible view and its watch currently poll independently (yaml-todo
`todo-watch-shared-observation`).
