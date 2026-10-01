# This project's dash-bored dashboard

[dash-bored](https://github.com/ArvidSU/dash-bored) is a local desktop app that
turns a project's commands, checks, docs, and services into a shared dashboard.
This directory is its portable dashboard bundle; it travels with the project.

- `dash-bored.yaml`: dashboard layout, panels, actions, and schema version.
- `dash-bored-lock.yaml`: exact revisions of external components and themes.
- `components/`: project-local and pinned external component code.
- `.env`: dashboard command variables and the coding-agent choice
  (`DASH_BORED_AGENT`); keep credentials out of version control.
- `install-app.sh`: downloads, verifies, and opens a compatible macOS installer.

## Install and open

Requires an Apple Silicon Mac with macOS 14 or newer. No Bun, Node, or coding
agent is needed to view the dashboard. Download manually from
[GitHub Releases](https://github.com/ArvidSU/dash-bored/releases), or run this
from the project root:

```sh
sh '.dash-bored/install-app.sh'
```

The command reads this bundle's `schemaVersion`, selects the newest published
canary release with that exact dashboard contract (no migration), checks the
DMG's SHA-256, and opens it. It stops if no compatible release is published.

1. Drag **dash-bored-canary** from the installer into **Applications** and open it.
   If macOS blocks this unsigned prerelease, try opening it once, then choose
   **System Settings → Privacy & Security → Open Anyway**.
2. Choose **Add dashboard** and select this project's `.dash-bored` directory.
   The app loads this bundle without replacing its configuration.
3. Review the requested capabilities before choosing **Trust project** to enable
   checks, commands, and project-file access. Safe text and layout work before trust.
4. For a starter dashboard, follow **Get started**: choose an installed CLI coding
   agent, install the dash-bored skill globally or for this project, then use
   **Set up this dashboard** and review the command and prompt before **Send**.
   Existing dashboards are ready to use; use the component library or your agent
   to customize them. Save dashboard edits with **Save dashboard**.

Press **Command-K** to find app, dashboard, and component actions. App updates
and schema migrations are available separately in the app.
