import { randomUUID } from "node:crypto";
import {
  constants,
  link,
  lstat,
  mkdir,
  open,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { stringify } from "yaml";
import type {
  ComponentChildLayout,
  ComponentNode,
  DashboardConfig,
  DashboardLock,
} from "../shared/contracts";
import { CONFIG_DIRECTORY } from "../shared/contracts";
import {
  assertProjectLocationContained,
  parseConfigName,
  resolveConfigBundleLocation,
  resolveProjectLocation,
  type ProjectLocation,
  type ResolveProjectLocationOptions,
} from "./paths";

export interface ProjectFilesResult {
  location: ProjectLocation;
  environmentPath: string;
  created: {
    config: boolean;
    lock: boolean;
    environment: boolean;
    componentsDirectory: boolean;
  };
}

interface CreateProjectFilesOptions {
  existingFiles: "error" | "preserve";
  inputKind: NonNullable<ResolveProjectLocationOptions["inputKind"]>;
}

export type EnsureProjectFilesOptions = ResolveProjectLocationOptions;

async function requireProjectDirectory(path: string): Promise<void> {
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Project directory does not exist: ${path}`);
    }
    throw error;
  }
  if (!info.isDirectory()) {
    throw new Error(`Project path is not a directory: ${path}`);
  }
}

async function ensureDirectory(path: string, label: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      throw new Error(`${label} must not be a symbolic link: ${path}`);
    }
    if (!info.isDirectory()) {
      throw new Error(`${label} is not a directory: ${path}`);
    }
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(path);
    return true;
  }
}

async function existingFile(path: string, label: string): Promise<boolean> {
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error(`${label} is not a file: ${path}`);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function writeExclusiveAtomic(path: string, contents: string, mode = 0o644): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(
    temporaryPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    mode,
  );
  let closed = false;
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    closed = true;
    // A same-directory hard link publishes the complete file atomically and
    // fails with EEXIST rather than replacing a file created concurrently.
    await link(temporaryPath, path);
  } finally {
    if (!closed) await handle.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
  }
}

export async function replaceDashboardConfigAtomic(
  location: ProjectLocation,
  config: DashboardConfig,
): Promise<void> {
  await assertProjectLocationContained(location);
  const existing = await lstat(location.configPath);
  if (existing.isSymbolicLink() || !existing.isFile()) {
    throw new Error(`dash-bored configuration must be a regular file: ${location.configPath}`);
  }

  const temporaryPath = `${location.configPath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(
    temporaryPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o644,
  );
  let closed = false;
  try {
    await handle.writeFile(stringify(config, { lineWidth: 0 }), "utf8");
    await handle.sync();
    await handle.close();
    closed = true;
    await rename(temporaryPath, location.configPath);
  } finally {
    if (!closed) await handle.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
  }
}

export function starterAgentPrompt(projectName: string, configPath?: string): string {
  return [
    `Set up the dash-bored dashboard for ${projectName}.`,
    ...(configPath ? [`Use ${configPath} as the exact owning configuration.`] : []),
    "Use the installed dash-bored skill for product-specific guidance. Its agent tool is \"$DASH_BORED_TOOL\" (also reachable as the skill's scripts/dash-bored launcher).",
    "Inspect this project before making changes; use \"$DASH_BORED_TOOL\" inspect . --summary, then --component <reference> for selected contracts.",
    "Customize the owning dashboard configuration into a useful project cockpit, preserving unrelated dashboards and files.",
    "Keep the dashboard project-owned and task-focused: every tab should explain what its panels do, demonstrate live status where possible, and expose the repeatable actions.",
    "Prefer built-in components when they fit. When nothing in the catalog fits, build a small project-local component by default — one-off components are a core capability of the product, not a last resort.",
    "The dashboard belongs to the project: never include explanations of the dash-bored app itself, its onboarding, or its concepts in the finished dashboard content.",
    "If the dash-bored skill is not installed for your agent, run \"$DASH_BORED_TOOL\" install-skill . and read it before composing.",
    "Generate a small SVG icon customized for this project: write it to assets/icon.svg inside the owning bundle directory (next to that dash-bored.yaml), creating the directory if needed, and set that file's top-level icon to ./assets/icon.svg. Keep the artwork simple and geometric so it stays readable at sidebar size, with no scripts or external references.",
    "Follow AGENTS.md and the project's own instructions, preserve unrelated changes and validate the finished dashboard, then check it visually with the tool's app screenshot command.",
  ].join(" ");
}

function formatDotenvValue(value: string): string {
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")}"`;
}

// Starter sources run through `/bin/sh -lc` in the project root. They list the
// project's own files (honoring its ignore rules inside a Git work tree) and
// shape the output for the built-in views, so the tour shows real data.
const STARTER_PROJECT_FILES = String.raw`files() { if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then git ls-files -z --cached --others --exclude-standard; else find . -mindepth 1 \( -name '.*' -o -name node_modules \) -prune -o -type f -print0; fi; }`;
const STARTER_JSON_STRING = String.raw`function q(s){gsub(/\\/,"\\\\",s);gsub(/"/,"\\\"",s);gsub(/\t/,"\\t",s);return "\"" s "\""}`;
// Escapes one line for a JSON string: drops ANSI color sequences and other
// control bytes, which JSON forbids, then quotes backslashes and quotes.
const STARTER_SH_JSON_STRING = String.raw`esc() { e=$(printf '\033'); printf '%s' "$1" | tr '\n\t' '  ' | sed "s/$e\[[0-9;]*[A-Za-z]//g" | LC_ALL=C tr -d '\000-\037\177' | sed 's/[\\"]/\\&/g'; }`;

function starterRecentFilesSource(): string {
  return [
    STARTER_PROJECT_FILES,
    String.raw`files | xargs -0 ls -td -- 2>/dev/null | head -n 12 | awk '${STARTER_JSON_STRING} BEGIN{printf "["} {p=$0; sub(/^\.\//,"",p); n=split(p,a,"/"); name=a[n]; dir=(n>1)?substr(p,1,length(p)-length(name)-1):"."; ext="no extension"; if (match(name,/\.[^.]+$/) && RSTART>1) ext=substr(name,RSTART); printf "%s{\"id\":%s,\"title\":%s,\"detail\":%s,\"tags\":[%s],\"path\":%s}", (NR>1?",":""), q(p), q(name), q(dir), q(ext), q(p)} END{print "]"}'`,
  ].join("\n");
}

function starterFileTypesSource(): string {
  return [
    STARTER_PROJECT_FILES,
    String.raw`files | tr '\0' '\n' | awk -F/ '{n=$NF; e="no extension"; if (match(n,/\.[^.]+$/) && RSTART>1) e=substr(n,RSTART); c[e]++} END{for (e in c) print c[e] "\t" e}' | sort -rn | head -n 8 | awk -F'\t' '${STARTER_JSON_STRING} {l=l (NR>1?",":"") q($2); v=v (NR>1?",":"") $1} END{printf "{\"labels\":[%s],\"series\":[{\"label\":\"Files\",\"values\":[%s]}]}\n", l, v}'`,
  ].join("\n");
}

function starterActivitySource(): string {
  return [
    STARTER_PROJECT_FILES,
    String.raw`count() { files | xargs -0 sh -c 'find "$@" -prune -type f '"$1"' -print' sh 2>/dev/null | wc -l | tr -d ' '; }`,
    String.raw`all=$(count ""); day=$(count "-mtime -1"); week=$(($(count "-mtime -7") - day)); older=$((all - day - week))`,
    String.raw`if [ "$all" -eq 0 ]; then echo '{"state":"unknown","detail":"No project files found yet."}'; exit 0; fi`,
    String.raw`if [ $((day + week)) -gt 0 ]; then state=healthy; detail="$day changed today, $week earlier this week, $older older."; else state=warning; detail="No file changes in the last 7 days."; fi`,
    String.raw`printf '{"state":"%s","detail":"%s","segments":[{"label":"Today","value":%s,"state":"healthy"},{"label":"This week","value":%s},{"label":"Older","value":%s,"state":"unknown"}]}\n' "$state" "$detail" "$day" "$week" "$older"`,
  ].join("\n");
}

function starterReadmeSource(): string {
  return String.raw`if [ -f README.md ]; then head -c 60000 README.md; else printf '%s\n\n' '### No README.md yet' 'This panel renders README.md from the project root once it exists. Until then, here are the top-level entries:'; ls -1p | head -n 30 | sed 's/^/- /'; fi`;
}

function starterSkillStatusSource(scope: "global" | "project"): string {
  const target = scope === "global" ? "--global" : ".";
  const installed = scope === "global"
    ? "Installed in ~/.agents/skills/dash-bored, linked from ~/.claude/skills/dash-bored."
    : "Installed in .agents/skills/dash-bored, linked from .claude/skills/dash-bored.";
  return [
    STARTER_SH_JSON_STRING,
    String.raw`if [ -z "$DASH_BORED_TOOL" ]; then echo '{"state":"error","detail":"This app build does not publish its agent tool (DASH_BORED_TOOL is unset)."}'; exit 0; fi`,
    `if out=$(FORCE_COLOR=0 "$DASH_BORED_TOOL" install-skill ${target} --check 2>&1); then echo '{"state":"healthy","detail":"${installed}"}'; else printf '{"state":"warning","detail":"Not installed yet: %s"}\\n' "$(esc "$(printf '%s' "$out" | head -n 1)")"; fi`,
  ].join("\n");
}

function starterAgentStatusSource(): string {
  return [
    STARTER_SH_JSON_STRING,
    String.raw`agent=$DASH_BORED_AGENT; set -- $agent; program=$1`,
    String.raw`if [ -z "$program" ]; then echo '{"state":"warning","detail":"No agent command is set. Choose one in Settings, or set DASH_BORED_AGENT below."}'`,
    String.raw`elif found=$(command -v "$program" 2>/dev/null); then printf '{"state":"healthy","detail":"Runs %s (found at %s)."}\n' "$(esc "$agent")" "$(esc "$found")"`,
    String.raw`else printf '{"state":"error","detail":"%s was not found on PATH. Install it, or choose another agent in Settings."}\n' "$(esc "$program")"; fi`,
  ].join("\n");
}

function defaultConfig(bundleNameSource: string, environmentPath: string): DashboardConfig {
  const projectName = basename(bundleNameSource) || "Project";
  const child = (node: ComponentNode): ComponentChildLayout => ({ node });
  const vertical = (nodes: ComponentNode[]): ComponentChildLayout => {
    if (nodes.length === 1) return child(nodes[0]!);
    const middle = Math.ceil(nodes.length / 2);
    return {
      axis: "vertical",
      first: vertical(nodes.slice(0, middle)),
      second: vertical(nodes.slice(middle)),
    };
  };
  const markdown = (id: string, lines: string[]): ComponentNode => ({
    id,
    component: "@dash-bored/markdown",
    props: { content: `${lines.join("\n")}\n` },
  });
  const status = (id: string, label: string, shell: string, every?: number): ComponentNode => ({
    id,
    component: "@dash-bored/status",
    props: { label, source: { shell, cwd: ".", timeoutMs: 10_000, ...(every ? { every } : {}) } },
  });
  // A guide on the left says what the controls on the right do and what to
  // expect; the live status beside each action reports what actually happened.
  const guided = (id: string, title: string, guide: string[], panel: ComponentNode[]): ComponentNode => ({
    id,
    component: "@dash-bored/group",
    props: { title },
    children: {
      axis: "horizontal",
      ratio: 0.5,
      first: child(markdown(`${id}-guide`, guide)),
      second: vertical(panel),
    },
  });

  const trustStep = guided("step-trust", "1 · Trust this project", [
    "Until you trust it, this dashboard only renders safe content: text, layout, and YAML-backed panels. Checks, commands, and file reads stay off, which is why the statuses on this page read **unknown**.",
    "",
    "**When you press Trust project,** a dialog lists every capability this dashboard requests (running commands, reading and writing project files) before anything is enabled. Nothing is installed.",
    "",
    "**Expect:** *Project trust* turns healthy and the other checks on this page start reporting. Revoke trust at any time from the command palette.",
  ], [
    status("trust-status", "Project trust", String.raw`echo '{"state":"healthy","detail":"Trusted: checks and commands on this dashboard can run."}'`),
    {
      id: "trust-actions",
      component: "@dash-bored/button",
      props: { items: [{ name: "Trust project", action: "project:trust" }, { name: "Open settings", action: "app:show-settings" }] },
    },
  ]);

  const agentStep = guided("step-agent", "2 · Choose your coding agent", [
    "Setup is done by a CLI coding agent you already use, such as Codex, Claude Code, Gemini CLI, Cursor, Copilot CLI, or OpenCode. dash-bored runs it as a command and appends the prompt as its last argument, for example `codex exec` or `claude -p`.",
    "",
    "The command comes from **Settings → General → Dashboard agent** when that field is set; otherwise from `DASH_BORED_AGENT` in this dashboard's `.env`, shown below. Give the CLI whatever permission flags it needs to edit files in this project.",
    "",
    "**Expect:** *Agent CLI* turns healthy once the program is found on your PATH.",
  ], [
    status("agent-cli-status", "Agent CLI", starterAgentStatusSource(), 5_000),
    { id: "dashboard-environment", component: "@dash-bored/env", props: { path: environmentPath } },
  ]);

  const skillStep = guided("step-skill", "3 · Install the dash-bored skill", [
    "The skill teaches your agent how dash-bored dashboards are built and ships the tools it uses to inspect, validate, and screenshot them. Nothing is installed until you run one of the commands. One install is enough.",
    "",
    "- **Globally** writes `~/.agents/skills/dash-bored/` and links `~/.claude/skills/dash-bored`, for every project on this Mac.",
    "- **For this project** writes `.agents/skills/dash-bored/` and links `.claude/skills/dash-bored` in this folder, so you can commit it for your team.",
    "",
    "**Expect:** the terminal prints where it installed, and the matching status turns healthy within a few seconds. The commands stay here so you can reinstall any time. Afterwards the app refreshes installed skills when it updates and keeps your local edits.",
  ], [
    status("skill-global-status", "Skill · global", starterSkillStatusSource("global"), 5_000),
    status("skill-project-status", "Skill · this project", starterSkillStatusSource("project"), 5_000),
    {
      id: "install-dash-bored-global-skill",
      component: "@dash-bored/command",
      props: { label: "Install skill globally", command: '"$DASH_BORED_TOOL" install-skill --global', cwd: "." },
    },
    {
      id: "install-dash-bored-skill",
      component: "@dash-bored/command",
      props: { label: "Install skill for this project", command: '"$DASH_BORED_TOOL" install-skill .', cwd: "." },
    },
  ]);

  const setupStep = guided("step-setup", "4 · Let the agent build your cockpit", [
    "**When you press Set up this dashboard:**",
    "",
    "1. A review dialog shows the exact command and prompt. Nothing runs until you press **Send**.",
    "2. The agent runs under **Agent work** in the header, with its terminal, a diff of `.dash-bored/`, and the full command.",
    "3. It inspects this project and rewrites this dashboard's `dash-bored.yaml` into a project-specific cockpit with a custom sidebar icon. **This starter page is replaced.** Files outside the dashboard bundle are not part of the task.",
    "4. When the agent exits, dash-bored validates the result and, if it finds configuration errors, asks the agent for one repair.",
    "",
    "**Expect** this to take several minutes. Validation proves the YAML is correct, not that the panels are useful, so review the result. If the new dashboard requests more capabilities, trust the project again.",
  ], [
    {
      id: "setup-dashboard-with-agent",
      component: "@dash-bored/button",
      props: {
        name: "Set up this dashboard",
        action: { run: "agent:prompt", with: { prompt: starterAgentPrompt(projectName) } },
      },
    },
  ]);

  const tourPanel = (id: string, label: string, guide: string[], examples: ComponentNode[]) => ({
    metadata: { label },
    node: {
      id,
      component: "@dash-bored/group",
      children: {
        axis: "horizontal",
        ratio: 0.4,
        first: child(markdown(`${id}-guide`, guide)),
        second: vertical(examples),
      },
    } satisfies ComponentNode,
  });
  const tourPanels = [
    tourPanel("tour-status", "Status", [
      "### Status",
      "A labeled state (healthy, warning, error, or unknown) read from a source such as a shell command, file, or URL. Use it for “is it running?” questions.",
      "",
      "The status beside this text counts this project's files by when they last changed. Its detail and bar come from a small shell command that prints `{ state, detail, segments }`.",
      "",
      "**Try it:** save any file in the project and wait about ten seconds: the counts move and the status marks what changed. Open the panel menu and choose **Edit component** to read the command.",
    ], [status("tour-activity-status", "Project activity", starterActivitySource(), 10_000)]),
    tourPanel("tour-list", "List", [
      "### List",
      "Items with stable IDs from a source, with tags to filter and per-item actions. Use it for work queues, recent changes, or runnable scripts.",
      "",
      "This list shows the most recently modified files in this project. Items that appear or change between refreshes are marked.",
      "",
      "**Try it:** press **Details** on a file. The command panel below runs with that file as `$DASH_ITEM_PATH` and prints its size, type, and first lines. Choose a tag to filter by file type.",
    ], [
      {
        id: "tour-recent-files",
        component: "@dash-bored/list",
        props: {
          title: "Recently modified files",
          sort: "source-order",
          source: { shell: starterRecentFilesSource(), cwd: ".", timeoutMs: 10_000, every: 15_000 },
          itemActions: [{ name: "Details", action: { run: "component:tour-file-details:run", with: { path: "${item.path}" } } }],
        },
      },
      {
        id: "tour-file-details",
        component: "@dash-bored/command",
        props: {
          label: "Show the selected file",
          command: 'ls -l -- "$DASH_ITEM_PATH" && file -b -- "$DASH_ITEM_PATH" && case "$(file -b --mime-type -- "$DASH_ITEM_PATH")" in text/*) echo && head -n 40 -- "$DASH_ITEM_PATH";; esac',
          cwd: ".",
        },
      },
    ]),
    tourPanel("tour-chart", "Chart", [
      "### Chart",
      "Line or bar charts from inline YAML or a source that prints `{ labels, series }`. Use it for trends such as build times, test counts, or traffic.",
      "",
      "This chart counts this project's files by extension. Inside a Git work tree it follows your ignore rules; elsewhere it skips hidden folders and `node_modules`.",
      "",
      "**Try it:** hover a bar for its value. Add a few files and press **Refresh** from the command palette.",
    ], [{
      id: "tour-file-types",
      component: "@dash-bored/chart",
      props: { title: "Files by type", type: "bar", source: { shell: starterFileTypesSource(), cwd: ".", timeoutMs: 10_000, every: 60_000 } },
    }]),
    tourPanel("tour-markdown", "Markdown", [
      "### Markdown",
      "Safe Markdown from inline YAML, a project file, or a command's output. Use it for runbooks, READMEs, and generated reports.",
      "",
      "The panel beside this text renders this project's `README.md`, read fresh each time the tab opens.",
      "",
      "**Try it:** edit `README.md` and switch tabs to reload it. A Markdown panel pointed at a file with `path:` can also be edited and saved in place.",
    ], [{
      id: "tour-readme",
      component: "@dash-bored/markdown",
      props: { title: "README.md", source: { shell: starterReadmeSource(), cwd: ".", timeoutMs: 5_000 } },
    }]),
    tourPanel("tour-command", "Command", [
      "### Command",
      "A remembered command with a persistent terminal. Use it for dev servers, tests, builds, and deploys. It keeps running while you switch tabs and dashboards.",
      "",
      "**Try it:** run the command beside this text to list this folder. Run and stop commands from the command palette (**Command-K**, then type the command's name), or bind them to a keyboard shortcut in **Settings → Actions**.",
    ], [{
      id: "tour-list-folder",
      component: "@dash-bored/command",
      props: { label: "List this project folder", command: "ls -la", cwd: "." },
    }]),
    tourPanel("tour-todos", "Todos", [
      "### Todos",
      "A list whose items live in this dashboard's YAML, so they travel with the project and show up in code review.",
      "",
      "**Try it:** tick an item. dash-bored opens a draft; press **Save dashboard** to write the change to `dash-bored.yaml`, or **Cancel** to discard it.",
    ], [{
      id: "tour-ideas",
      component: "@dash-bored/list",
      props: {
        title: "Ideas for this dashboard",
        todos: [
          { id: "idea-dev-server", description: "Add a command that starts the dev server", done: false, tags: ["act"] },
          { id: "idea-tests", description: "Add a status that runs the test suite on demand", done: false, tags: ["observe"] },
          { id: "idea-docs", description: "Link the project's runbook or docs with a Markdown panel", done: false, tags: ["overview"] },
          { id: "idea-local-ui", description: "Embed a local web UI with a webview", done: false, tags: ["observe"] },
        ],
      },
    }]),
    tourPanel("tour-layout", "Layout & editing", [
      "### Layout & editing",
      "Everything on this page is one YAML tree in `.dash-bored/dash-bored.yaml`: groups with titles, horizontal and vertical splits, and switchable panels like this tab bar (an action bar selecting a child of a selection container).",
      "",
      "Four ways to change it, all through the same draft that you Save or Cancel:",
      "",
      "- **Component library**: add, move, and remove components and fill in their props.",
      "- **Panel menu** (right-click a panel): Edit component, Focus, Collapse, Copy component path, or **Change with agent** to describe a change in words.",
      "- **Command-K**: search every app, dashboard, and component action.",
      "- **Your agent**: edit the YAML directly with the skill's tools.",
      "",
      "**Try it:** open the component library, or right-click this panel.",
    ], [{
      id: "tour-layout-actions",
      component: "@dash-bored/button",
      props: { items: [{ name: "Open component library", action: "project:edit" }, { name: "Focus a component", action: "project:focus" }] },
    }]),
  ];

  const rootNodes: ComponentNode[] = [
    markdown("welcome", [
      `# ${projectName}`,
      "",
      "This is a starter dashboard in `.dash-bored/`. Creating it changed nothing else in the project and installed nothing. Work through the four steps below to have your coding agent turn it into a cockpit for this project: its commands, checks, docs, and services one click away.",
      "",
      "Each step says what its button does and shows a live check so you can see what happened. Scroll down for a tour of the components, reading this project's real files.",
    ]),
    {
      id: "get-started",
      component: "@dash-bored/group",
      props: { title: "Get started", description: "Each step explains its action and shows a live check of the result." },
      children: vertical([trustStep, agentStep, skillStep, setupStep]),
    },
    {
      id: "tour",
      component: "@dash-bored/group",
      props: { title: "Tour the components", description: "Each tab explains one component, shows it working on this project, and suggests something to try." },
      children: vertical([
        {
          id: "tour-tabs",
          component: "@dash-bored/button",
          props: {
            variant: "tabs",
            label: "Component tour",
            items: tourPanels.map(({ metadata, node }) => ({ name: metadata.label, action: `select:tour-panels/${node.id}` })),
          },
        },
        {
          id: "tour-panels",
          component: "@dash-bored/selection",
          props: { defaultChild: tourPanels[0]!.node.id, label: "Component tour" },
          children: tourPanels,
        },
      ]),
    },
  ];
  return {
    schemaVersion: 3,
    name: projectName,
    icon: "./assets/icon.svg",
    root: {
      component: "@dash-bored/group",
      children: vertical(rootNodes),
    },
  };
}

async function createProjectFiles(
  input: string,
  options: CreateProjectFilesOptions,
): Promise<ProjectFilesResult> {
  const location = await resolveProjectLocation(input, {
    inputKind: options.inputKind,
  });
  return createProjectFilesAtLocation(location, options.existingFiles);
}

async function createProjectFilesAtLocation(
  location: ProjectLocation,
  existingFiles: CreateProjectFilesOptions["existingFiles"],
): Promise<ProjectFilesResult> {
  await requireProjectDirectory(location.projectRoot);

  await ensureDirectory(location.configDirectory, "dash-bored directory");
  const componentsDirectory = await ensureDirectory(
    location.componentsDirectory,
    "dash-bored components directory",
  );
  await assertProjectLocationContained(location);
  const environmentPath = join(location.configDirectory, ".env");
  const relativeEnvironmentPath = relative(location.projectRoot, environmentPath).replaceAll("\\", "/");
  const [configExists, lockExists, environmentExists] = await Promise.all([
    existingFile(location.configPath, "dash-bored configuration"),
    existingFile(location.lockPath, "dash-bored lock file"),
    existingFile(environmentPath, "dash-bored environment file"),
  ]);

  if (existingFiles === "error" && (configExists || lockExists || environmentExists)) {
    throw new Error(
      `dash-bored is already initialized or partially initialized in ${location.configDirectory}; existing files were not overwritten.`,
    );
  }

  const config = defaultConfig(
    location.configDirectory === join(location.projectRoot, CONFIG_DIRECTORY)
      ? location.projectRoot
      : location.configDirectory,
    relativeEnvironmentPath,
  );
  const lock: DashboardLock = { lockfileVersion: 1, components: {} };
  const environment = [
    "# Starter values shown in the dashboard environment editor.",
    "# DASH_BORED_AGENT is also configurable app-wide in Settings.",
    `DASH_BORED_AGENT=${formatDotenvValue("codex exec")}`,
    "",
  ].join("\n");
  let configCreated = false;
  let lockCreated = false;
  let environmentCreated = false;

  try {
    if (!configExists) {
      try {
        await writeExclusiveAtomic(
          location.configPath,
          stringify(config, { lineWidth: 0 }),
        );
        configCreated = true;
      } catch (error) {
        if (
          existingFiles !== "preserve" ||
          (error as NodeJS.ErrnoException).code !== "EEXIST" ||
          !(await existingFile(location.configPath, "dash-bored configuration"))
        ) {
          throw error;
        }
      }
    }

    if (!lockExists) {
      try {
        await writeExclusiveAtomic(
          location.lockPath,
          stringify(lock, { lineWidth: 0 }),
        );
        lockCreated = true;
      } catch (error) {
        if (
          existingFiles !== "preserve" ||
          (error as NodeJS.ErrnoException).code !== "EEXIST" ||
          !(await existingFile(location.lockPath, "dash-bored lock file"))
        ) {
          throw error;
        }
      }
    }

    if (!environmentExists) {
      try {
        await writeExclusiveAtomic(environmentPath, environment, 0o600);
        environmentCreated = true;
      } catch (error) {
        if (
          existingFiles !== "preserve" ||
          (error as NodeJS.ErrnoException).code !== "EEXIST" ||
          !(await existingFile(environmentPath, "dash-bored environment file"))
        ) {
          throw error;
        }
      }
    }
  } catch (error) {
    if (environmentCreated) await unlink(environmentPath).catch(() => undefined);
    if (lockCreated) await unlink(location.lockPath).catch(() => undefined);
    if (configCreated) await unlink(location.configPath).catch(() => undefined);
    throw error;
  }

  return {
    location,
    environmentPath,
    created: {
      config: configCreated,
      lock: lockCreated,
      environment: environmentCreated,
      componentsDirectory,
    },
  };
}

/** Create only missing dash-bored project artifacts, preserving existing files. */
export function ensureProjectFiles(
  input = ".",
  options: EnsureProjectFilesOptions = {},
): Promise<ProjectFilesResult> {
  return createProjectFiles(input, {
    existingFiles: "preserve",
    inputKind: options.inputKind ?? "auto",
  });
}

/** Initialize a project and fail rather than accepting an existing bundle artifact. */
export function initializeProjectFiles(input = "."): Promise<ProjectFilesResult> {
  return createProjectFiles(input, {
    existingFiles: "error",
    inputKind: "project-root",
  });
}

/**
 * Initialize a standalone named configuration bundle. The base bundle is
 * repaired first so every named config lives inside a complete project layout.
 */
export async function initializeNamedProjectFiles(
  projectInput = ".",
  name: string,
): Promise<ProjectFilesResult> {
  const segments = parseConfigName(name);
  if (segments.length === 0) return initializeProjectFiles(projectInput);

  const base = await ensureProjectFiles(projectInput, { inputKind: "project-root" });
  let directory = base.location.configDirectory;
  for (const segment of segments) {
    directory = join(directory, segment);
    await ensureDirectory(directory, "named dash-bored config directory");
  }

  const location = await resolveConfigBundleLocation(projectInput, name);
  return createProjectFilesAtLocation(location, "error");
}
