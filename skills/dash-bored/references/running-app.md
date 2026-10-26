# Operating the running app

Read this when you drive the user's dashboard through `dash-bored app ...`:
running a button or command, reading a panel, explaining a red status or a
failed run, checking your own change visually, or handing a result back to
the user. Read results instead of guessing from pixels, and read the dashboard
YAML and its source scripts freely to learn what a panel shows and why.

## Find and run

1. `dash-bored app status`. `trust.trusted: false` means only layout renders
   and nothing runs: ask the user to trust the project (you cannot).
   `diagnostics.items` holds each error's code, message, file, and path;
   `selections` maps each tab container to its selected child; `editing`
   and `notifications` report unsaved drafts and open decisions.
2. Find the node: its `id` in the YAML, or `dash-bored app actions <word>`,
   which lists what you may run whose id, label, or node contains the word
   (the unfiltered list can run to hundreds of entries), including the
   action for a button, tab, or command (`process:<command-id>`,
   `select:<selection>/<child>`, `component:<node>:refresh`). Several panels
   can share a label; each action's `description` shows where it sits, and
   you should say which one you used.
3. Pass an action's `reference` or `id` to `dash-bored app run` (raw node IDs
   with `::` work too, such as `focus:linked::pulse`); an unknown one returns
   close `suggestions`. Choices show as counts; `--choices` lists options for
   `--select <choice>=<option>`.
4. `app run` returns when the views it touched have finished loading
   (`idle: true`; `idle: false` plus a `warning` after `--timeout`, default
   10 s). A refresh of a panel that is not mounted is `unavailable`:
   `reveal:<node-id>` first, or just `app read` it.
5. The app refuses trust changes, draft start/save/cancel, `agent:*` actions,
   the Add dashboard chooser, and anything that asks for confirmation; tell
   the user which of these they need to do.

## Read results

- `dash-bored app read <node-id>` returns a panel's full rendered text (all
  of it, even below the fold or on another tab) once its sources have loaded,
  and leaves the user's view as it was (`changes.revealed: true` means it
  briefly showed the node's tab, then restored it: `viewRestored: true`). Use
  it to answer "what does it say", count items, or read a status detail.
- `dash-bored app run process:<command-id> --until-exit` runs a command and
  waits for it to finish (default up to 10 minutes, `--timeout <ms>`), then
  returns its `exitCode` and the last lines of output (`--tail <n>`); the
  tool's exit status is nonzero when the command failed or is still running.
  Don't use it for servers that never exit. `app wait <command-id>` does the
  same for a run already in progress, `app processes <command-id>` shows one
  process, and `app logs <command-id> --tail <n>` reads more output.
- Command palette: users reach the same actions by searching a name or node
  ID (rows such as `Focus component › Backlog`). To prove palette changes,
  run `app run app:open-palette --query "<search>"` (at most 200 characters),
  then capture and inspect `app screenshot`. It opens a fresh search and
  leaves result execution to the user.

## Screenshots

- `dash-bored app screenshot --node <node-id>` (`--output <file.png>` picks
  the path) crops to that node, even on another tab, and puts the user's view
  back; view the PNG path it prints. A plain `app screenshot` shows the whole
  window as the user sees it. A node taller than the window comes back
  `truncated: true` with only its top; use `app read` for its content.
- Check that labels make sense, nothing is empty or truncated, no panel shows
  "Source shape" or "Command failed", and the Overview answers its questions.
- Never fall back to a full-screen `screencapture`: it captures whatever else
  is on screen. If the app is not running, the project is untrusted, or a
  screenshot fails, say so in the report rather than implying you checked.
- `SCREEN_RECORDING_PERMISSION_REQUIRED`: ask the user to allow Screen
  Recording and relaunch the app. If access stays denied after an app update,
  direct them to Settings → General → Agent screenshots → Reset Screen
  Recording permission; they confirm, quit and reopen the app, choose Request
  access there, and allow the current build in System Settings. Agents cannot
  reset or grant it.
- The app renders while covered by other windows, so you never need the user
  to switch to it. `APP_WINDOW_NOT_RENDERING` (or a `warning` on `app run`)
  means it is minimized or hidden: ask them to show it.

## Restore the user's view

`app read` and `--node` restore the view (`viewRestored: true`), and so does
`--focus` unless you pass `--keep-focus`. After `app run select:` or `focus:`,
run `select:<selection>/<child>` from the original `selections`, or
`focus:<original focusedNodeId>`; use `project:clear-focus` if the dashboard
was unfocused.

## Retries and versions

- The app reloads after each YAML save; if an `app` command fails right then
  with a closed connection, retry it once.
- When another agent is reading or capturing at the same time, `app read` and
  `--node` fail with "retry in a few seconds"; `--node` also fails with "The
  view changed" when someone switches tabs mid-capture. Retry both.
- Several app instances can run (for example a release and a dev build). If
  `app` commands say the choice is ambiguous, pass `--instance <identifier>`
  from the list they print.
- An unknown `app` command means the installed app is older than this skill:
  say which command is missing and fall back to screenshots and the YAML.

## Hand results back to the user

When work finishes or an actionable blocker needs the user, make the relevant
result visible first, then leave the user a decision with
`dash-bored app run notify:<node-id> --message "<why, one short line>"`
(`--item <id>` targets one list item). It does not take focus: while
dash-bored is in the background it shows a system notification, in front an
in-app notice, and either way the decision waits in the user's notification
inbox until they dismiss it or choose Show, which reveals and animates the
node with your message.

- `dash-bored app run app:focus-window --no-wait` only when the user asked to
  be shown the app; it restores the window and brings dash-bored to the
  foreground with keyboard focus, preserving drafts and the selected view.
- `dash-bored app run attention:<node-id> --message "<why>"` points at a
  component while the user is already looking at the app (`--animation
  builtin:shake` and others are in [animations.md](animations.md)); it
  reveals the node, animates it, and never moves keyboard focus.

Use all three sparingly for meaningful handoffs, not for routine progress,
polling, or every tool call. Runs you start through `app run` never notify
the user; report their results yourself. `app status` lists the user's open
notification decisions across dashboards under `notifications`.
