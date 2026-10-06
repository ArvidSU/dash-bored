# Focus timer component

A self-contained focus and break timer for a dash-bored dashboard. The default
session is 25 minutes of focus followed by a 5 minute break. Timer state stays
in memory and resets when the component unmounts. No project permissions are
needed.

## Develop

Agents: use the installed **dash-bored** skill and its
`references/components.md#standalone-component-authoring` workflow. This is
a component repository; dashboard files are only needed later for preview.

The tool is not on PATH. The included `dash-bored.sh` uses
`DASH_BORED_TOOL` when the app launched you, otherwise the installed skill
launcher in `~/.agents/skills/dash-bored` or `$CODEX_HOME/skills/dash-bored`
(default `~/.codex/skills/dash-bored`). Install and open the desktop app once
if neither is available. Each command works in a fresh shell:

```sh
sh ./dash-bored.sh component api --json
sh ./dash-bored.sh component setup .
sh ./dash-bored.sh component check . --json
```

Run setup after cloning or updating dash-bored to install matched editor
declarations. It preserves runtime module resolution for tests and builds.
Keep `.dash-bored-sdk/` out of version control. Check validates the manifest,
TypeScript and production bundle without running the component. For published
JavaScript, also pass `--source-project <tsconfig>` to check original sources.

To see the component in context, add `./components/sdk-example` to a dashboard
and open that dashboard in the app. With the timer node selected, capture the
real dashboard from its live host:

```sh
sh ./dash-bored.sh app screenshot --focus sdk-example --output /tmp/focus-timer.png
```

The screenshot uses the app's component host, theme, layout and action registration.
Check default, loading, empty and error states where applicable, light/dark
themes, narrow panes and keyboard controls. Restore any changed focus or tab.
Report the API target, SDK digest, check stages and preview evidence at handoff.
