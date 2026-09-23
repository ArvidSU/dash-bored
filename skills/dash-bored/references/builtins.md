<!-- GENERATED FILE — do not edit by hand.
     Regenerate with: bun run generate:components -->

# Built-in component reference

Generated from `BUILTIN_COMPONENTS` in `src/core/builtins.ts`; this file
ships inside the dash-bored skill for this version. Types come from each
component's JSON Schema `propsSchema`.

## @dash-bored/button

Action button — Invokes one action or a compact bar of actions, with availability and invocation feedback.

Props:

| Prop | Type | Required | Notes |
| --- | --- | --- | --- |
| `name` | string | no | non-empty |
| `action` | any | no |  |
| `label` | string | no | non-empty |
| `variant` | `buttons` \| `segmented` \| `tabs` | no |  |
| `items` | array of object | no | 1–12 items; object with keys: `name` (required) string, `action` (required) any |

Children: none (leaf component).

Permissions: none.


## @dash-bored/focus-timer

Focus timer — A focused work session and a breathing break, with pause, resume, and explicit session starts. Session state resets on unmount or duration changes.

Props:

| Prop | Type | Required | Notes |
| --- | --- | --- | --- |
| `title` | string | no |  |
| `focusMinutes` | integer | no | 1–180 |
| `breakMinutes` | integer | no | 1–60 |

Children: none (leaf component).

Permissions: none.


## @dash-bored/setup-agent

Dashboard setup agent — Runs the configured CLI agent to customize this starter dashboard.

Props:

None.

Children: none (leaf component).

Permissions: `process:execute`.


## @dash-bored/tabs

Tabs — Switches between labeled dashboard panels.

Props:

| Prop | Type | Required | Notes |
| --- | --- | --- | --- |
| `defaultTab` | integer | no | >= 0 |

Children: managed presentation, minimum 1.
Edge metadata: object with keys: `label` (required) string.

Permissions: none.


## @dash-bored/group

Group — Provides a neutral composition boundary for tiled dashboard content.

Props:

None.

Children: tiled presentation (axes: `both`), minimum 0.

Permissions: none.


## @dash-bored/conditional

Conditional visibility — Recovery visibility for one tiled child based on a bounded shell check. Starts visible and fails open before trust or on host errors; unsuitable for asserting healthy status.

Props:

| Prop | Type | Required | Notes |
| --- | --- | --- | --- |
| `command` | string | yes | non-empty |
| `cwd` | string | no | non-empty |
| `env` | map of string to string | no |  |
| `invert` | boolean | no |  |
| `pollIntervalMs` | integer | no | 1000–300000 |
| `timeoutMs` | integer | no | 1–30000 |

Children: tiled presentation (axes: `both`), exactly 1.

Permissions: `process:execute`.


## @dash-bored/card

Card — Frames dashboard content with an optional title.

Props:

| Prop | Type | Required | Notes |
| --- | --- | --- | --- |
| `title` | string | no |  |
| `description` | string | no |  |

Children: tiled presentation (axes: `both`), minimum 2.

Permissions: none.


## @dash-bored/markdown

Markdown — Previews safe Markdown from inline content or a project file, with raw editing and bounded source polling.

Props:

| Prop | Type | Required | Notes |
| --- | --- | --- | --- |
| `content` | string | see note |  |
| `path` | string | see note | non-empty |
| `title` | string | no |  |
| `source` | object | see note | object with keys: `shell` string, `file` string, `http` string, `process` string, `inline` any, `every` integer, `timeoutMs` integer, `cwd` string, `env` map of string to string |

Exactly one of `content` or `path` or `source` is required.

Children: none (leaf component).

Permissions: when configured: `path` requires `filesystem:read`, `filesystem:write`; `source.shell` requires `process:execute`; `source.file` requires `filesystem:read`; `source.http` requires `network:http`; `source.process` requires `process:observe`.


Actions:

- `refresh` — Refresh Markdown: Reload the configured Markdown source.

## @dash-bored/status

Status — Displays a labeled state, with optional bounded sources emitting { state, detail? } or a supervised process snapshot.

Props:

| Prop | Type | Required | Notes |
| --- | --- | --- | --- |
| `label` | string | see note | non-empty |
| `state` | `unknown` \| `healthy` \| `warning` \| `error` | see note |  |
| `detail` | string | no |  |
| `source` | object | see note | object with keys: `shell` string, `file` string, `http` string, `process` string, `inline` any, `every` integer, `timeoutMs` integer, `cwd` string, `env` map of string to string |

Exactly one of `label` + `state` or `label` + `source` is required.

Children: none (leaf component).

Permissions: when configured: `source.shell` requires `process:execute`; `source.file` requires `filesystem:read`; `source.http` requires `network:http`; `source.process` requires `process:observe`.


Actions:

- `refresh` — Refresh status: Reload the configured status source.

## @dash-bored/chart

Chart — Plots line or bar data from YAML or a bounded source emitting { labels: string[], series: [{ label, values }] }.

Props:

| Prop | Type | Required | Notes |
| --- | --- | --- | --- |
| `title` | string | no |  |
| `type` | `line` \| `bar` | no |  |
| `maxPoints` | integer | no | 2–200 |
| `source` | object | see note | object with keys: `shell` string, `file` string, `http` string, `process` string, `inline` any, `every` integer, `timeoutMs` integer, `cwd` string, `env` map of string to string |
| `labels` | array of string | see note | 1–500 items |
| `series` | array of object | see note | 1–12 items; object with keys: `label` (required) string, `values` (required) array of number \| null, `color` string |

Exactly one of `source` or `labels` + `series` is required.

Children: none (leaf component).

Permissions: when configured: `source.shell` requires `process:execute`; `source.file` requires `filesystem:read`; `source.http` requires `network:http`; `source.process` requires `process:observe`.


Actions:

- `refresh` — Refresh chart: Reload the configured chart source.

## @dash-bored/live-chart

Live chart — Polls a JSON endpoint and plots its chart-shaped response.

Props:

| Prop | Type | Required | Notes |
| --- | --- | --- | --- |
| `title` | string | no |  |
| `type` | `line` \| `bar` | no |  |
| `maxPoints` | integer | no | 2–200 |
| `endpoint` | string | yes | must match `^(https?://|/|\./)` |
| `dataPath` | string | no |  |
| `pollIntervalMs` | integer | no | 1000–300000 |

Children: none (leaf component).

Permissions: `network:http`.


Actions:

- `refresh` — Refresh chart: Reload the live chart endpoint.

## @dash-bored/command

Command — Runs a remembered quick action in a persistent interactive terminal.

Props:

| Prop | Type | Required | Notes |
| --- | --- | --- | --- |
| `label` | string | yes | non-empty |
| `command` | string | yes | non-empty |
| `cwd` | string | no | non-empty |
| `env` | map of string to string | no |  |

Children: none (leaf component).

Permissions: `process:execute`.

Resources:

- `process`: command from `command`, working directory from `cwd`, environment from `env`, interactive PTY.

Actions:

- `run` — Run command with item values: Runs this command as a bounded action with DASH_ITEM_* environment values.
  - Arguments: JSON Schema `{"type":"object","additionalProperties":{"type":["string","number","boolean"]}}`.

## @dash-bored/env

Environment editor — Edits a project-local .env file as key-value pairs or raw text.

Props:

| Prop | Type | Required | Notes |
| --- | --- | --- | --- |
| `path` | string | yes | non-empty |

Children: none (leaf component).

Permissions: `filesystem:read`, `filesystem:write`.


## @dash-bored/list

Source list — Renders stable-ID items from a bounded source, with tags, status, and refresh.

Props:

| Prop | Type | Required | Notes |
| --- | --- | --- | --- |
| `title` | string | no |  |
| `source` | object | yes | object with keys: `shell` string, `file` string, `http` string, `process` string, `inline` any, `every` integer, `timeoutMs` integer, `cwd` string, `env` map of string to string |
| `filterByTags` | boolean | no |  |
| `sort` | `open-first` \| `source-order` | no |  |
| `itemActions` | array of object | no | <= 12 items; object with keys: `name` (required) string, `action` (required) any |

Children: none (leaf component).

Permissions: when configured: `source.shell` requires `process:execute`; `source.file` requires `filesystem:read`; `source.http` requires `network:http`; `source.process` requires `process:observe`.


Actions:

- `refresh` — Refresh list

## @dash-bored/todo-list

YAML todo list — Keeps a small todo list in this component's dashboard YAML props.

Props:

| Prop | Type | Required | Notes |
| --- | --- | --- | --- |
| `todos` | array of object | no | <= 500 items; object with keys: `id` string, `description` (required) string, `done` (required) boolean, `tags` (required) array of string |

Children: none (leaf component).

Permissions: none.


## @dash-bored/webview

Webview — Embeds an HTTP or HTTPS application page.

Props:

| Prop | Type | Required | Notes |
| --- | --- | --- | --- |
| `url` | string | yes | must match `^https?://` |

Children: none (leaf component).

Permissions: `webview:embed`.
