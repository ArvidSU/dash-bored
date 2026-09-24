# Sources and source scripts

Read this when a panel shows anything that can change: health, Git state,
test results, counts, lists of files or tasks, metrics. The project knowledge
lives in a small command or script whose output matches a view's shape;
never in hand-written YAML values and never in a local component when a view
already fits.

## Shapes

| View | The source must produce | Notes |
| --- | --- | --- |
| `status` | `{"state": "healthy", "detail": "…"}` | `state` is exactly `unknown`, `healthy`, `warning`, or `error`; `detail` is an optional string. |
| `list` | `[{"id": "…", "title": "…"}, …]` | `id` and `title` are non-empty strings; `id` must be unique and stable, derived from the thing rather than its position in the output (a SHA, a path, `path:line` for a marker in a file). Optional `detail` (string), `tags` (string array), `state` (string), `done` (boolean). Extra fields are allowed and feed item actions. |
| `chart` | `{"labels": ["…"], "series": [{"label": "…", "values": [1, null]}]}` | 1–12 series; each `values` array matches `labels`; values are numbers or `null`. |
| `markdown` | text | Rendered as Markdown, so bare lines merge into one paragraph: print bullets or a fenced block. JSON output is shown as a code block. |

A value that does not match shows a "Source shape" message on the panel;
validation cannot catch it because it never runs sources.

## The `source` prop

Exactly one kind, plus optional settings:

| Key | Meaning | Permission |
| --- | --- | --- |
| `shell` | A command run by `/bin/sh -lc` from the project root. On exit 0, stdout is parsed as JSON when it parses, otherwise used as text. A nonzero exit or timeout shows `error` with the last 500 characters of stderr and keeps the last good value. | `process:execute` |
| `file` | A project-relative file, parsed as JSON when it parses. | `filesystem:read` |
| `http` | An absolute `http(s)://` URL. A 2xx body is parsed like stdout; other statuses are errors. The body must already have the view's shape; otherwise fetch it from a `shell` script and transform it there. | `network:http` |
| `process` | A `command` node's ID; reports its process phase and exit code. See the caveat below. | `process:observe` |
| `inline` | A literal value. Use it only for data that really is fixed. | none |
| `every` | Poll interval in milliseconds, 1000–300000. Omitted: read once when shown, plus the panel's Refresh action (`component:<id>:refresh`). Polling pauses while the panel is hidden. | |
| `timeoutMs` | 1–30000; default 10000. | |
| `cwd`, `env` | Project-relative working directory; string environment overrides. | |

Output is limited to 1 MiB per stream. A source runs whenever its panel is
shown, on every poll, and on Refresh, so keep it read-only and finished in
seconds. Tests, builds, installs, and anything that writes belong in a
`command`.

## The app's shell environment

A `shell` source is not run in your terminal. The app starts `/bin/sh -lc`
without your shell's rc files and with its own `PATH`: the login `PATH` plus
`/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, `~/.bun/bin`,
`~/.cargo/bin`, `~/.npm-global/bin`, and pnpm's directory. Interpreters
installed through nvm, pyenv, asdf, or other shims are usually missing and fail
with `Command failed (exit 127)`. The bundle's `.env` values are added.

- Write scripts in POSIX `sh` when `printf` suffices; otherwise in `python3`,
  which on macOS ships with the Command Line Tools alongside `git`. Use
  another runtime only when it resolves on the `PATH` above.
- Test exactly as the app runs it, from the project root:
  `env -i HOME="$HOME" /bin/sh -lc '<the shell string>'`. That is a little
  stricter than the app, which is the safe direction.
- If a tool the project needs is not reachable, do not hard-code a personal
  absolute path into shared YAML; list it under **Needs you**.

## Script conventions

- Keep scripts in `.dash-bored/scripts/` so they travel with the dashboard,
  and reference them from the project root:
  `shell: python3 .dash-bored/scripts/recent-commits.py`.
- Print only the result on stdout. On failure, let the underlying tool's
  message reach stderr (or print one short reason) and exit nonzero; the
  panel shows the end of stderr, so a traceback hides the cause.
- Build JSON with a serializer (`json.dumps`), not string concatenation,
  whenever values come from arbitrary text such as commit subjects or file
  names.
- Never print secrets: the panel shows the output to anyone at the screen.

## Examples

Each snippet is a node to place in a dashboard; the scripts were run as shown.

### Health check without a script

A status for a local service that treats "not running" as a warning:

```yaml
id: api-health
component: "@dash-bored/status"
props:
  label: API on :3000
  source:
    shell: |
      if curl -fsS --max-time 3 http://127.0.0.1:3000/health >/dev/null; then
        echo '{"state":"healthy","detail":"Responding on :3000"}'
      else
        echo '{"state":"warning","detail":"Not responding on :3000"}'
      fi
    every: 15000
```

Use `warning` when "not running" is normal, such as a dev server started on
demand, and `error` when the service should always be up: drop the `else`
branch and the outage shows as an `error` carrying curl's own message, such
as "Failed to connect".

### Status from a script

`.dash-bored/scripts/working-tree.sh`:

```sh
#!/bin/sh
# @dash-bored/status source: prints { state, detail } for the working tree.
set -eu
branch=$(git branch --show-current)
changed=$(git status --porcelain | wc -l | tr -d ' ')
if [ "$changed" -eq 0 ]; then
  printf '{"state":"healthy","detail":"%s · clean"}\n' "${branch:-detached}"
else
  printf '{"state":"warning","detail":"%s · %s uncommitted"}\n' "${branch:-detached}" "$changed"
fi
```

```yaml
id: working-tree
component: "@dash-bored/status"
props:
  label: Working tree
  source: { shell: sh .dash-bored/scripts/working-tree.sh, every: 10000 }
```

### List with item actions

`.dash-bored/scripts/recent-commits.py`:

```python
"""@dash-bored/list source: prints recent commits as list items."""
import json
import subprocess
import sys

log = subprocess.run(
    ["git", "log", "-20", "--format=%H%x1f%h%x1f%s%x1f%an%x1f%cr"],
    stdout=subprocess.PIPE, text=True,
)
if log.returncode != 0:
    sys.exit(log.returncode)  # git has already explained why on stderr
items = []
for line in log.stdout.splitlines():
    sha, short, subject, author, when = line.split("\x1f")
    items.append({
        "id": sha,
        "title": subject,
        "detail": f"{short} · {author} · {when}",
        "sha": sha,
        "prompt": f"Review commit {sha} in this repository and list correctness risks. Do not edit files.",
    })
print(json.dumps(items))
```

```yaml
id: recent-commits-panel
component: "@dash-bored/group"
props: { title: Recent commits }
children:
  axis: horizontal
  ratio: 0.6
  first:
    node:
      id: recent-commits
      component: "@dash-bored/list"
      props:
        title: Last 20 commits
        sort: source-order
        source: { shell: python3 .dash-bored/scripts/recent-commits.py, every: 30000 }
        itemActions:
          - name: Show
            action: { run: "component:show-commit:run", with: { sha: "${item.sha}" } }
          - name: Review with agent
            action: { run: agent:prompt, with: { prompt: "${item.prompt}" } }
  second:
    node:
      id: show-commit
      component: "@dash-bored/command"
      props:
        label: Show selected commit
        command: 'git --no-pager show --stat --color=always "$DASH_ITEM_SHA"'
```

How item actions resolve:

- `${item.<field>}` must be an argument's entire value; `"commit ${item.sha}"`
  is rejected. An item that lacks the field shows an error on that action.
  Put composed text, such as a per-item agent prompt, in its own field from
  the script.
- A `command`'s `run` action receives each argument as an environment
  variable named `DASH_ITEM_` plus the upper-cased argument name. Quote it in
  the command text. `${item.…}` inside a `command` string fails validation.
- `agent:prompt` opens the agent composer prefilled; the user reviews and
  sends it. Agents cannot trigger it through `app run`.
- `sort` defaults to `open-first`, which moves items with `done: true` or a
  `state` of done, completed, or closed to the end; `source-order` keeps the
  script's order. A tag filter appears when items have tags;
  `filterByTags: false` hides it.

### A list the user edits

For items only the dashboard tracks, a list keeps its own `todos` in YAML and
edits them through the app's draft Save/Cancel:

```yaml
id: next-up
component: "@dash-bored/list"
props:
  title: Next up
  todos:
    - { id: ship-retry-fix, description: Ship the retry fix, done: false, tags: [release] }
```

Every todo needs `id`, `description`, `done`, and `tags`. `source` and
`todos` are mutually exclusive.

## Caveat: commands stay open

A `command` is a persistent interactive terminal. After its command finishes,
the shell stays open and the process phase stays `running` until the user
presses Stop. Consequently:

- `source: { process: <command-id> }` reports running (a `warning` status)
  instead of the last exit code while the terminal is open.
- A command's `run` action, and so every item action that targets it, is
  disabled after the first use until the user stops that terminal.
- A button with `process:<command-id>` toggles: while the terminal is open,
  pressing it closes the terminal instead of running the command again.

Design around it: use item actions on a command for occasional inspection,
say in the panel description that Stop resets the runner, and do not build a
"last run passed" tile on a command's process.
