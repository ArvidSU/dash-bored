import { lstat, mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  checkComponentDirectory,
  componentApiInfo,
  setupComponentAuthoring,
} from "../core/component-authoring";

import { prepareComponentDependency } from "../core/component-prepare";

const STARTER_FILES: Record<string, string> = {
  "dash-bored.sh": `#!/bin/sh
# Use the app-matched tool without installing anything on PATH.
set -eu
if [ -n "\${DASH_BORED_TOOL:-}" ] && [ -x "$DASH_BORED_TOOL" ]; then
  exec "$DASH_BORED_TOOL" "$@"
fi
for launcher in "$HOME/.agents/skills/dash-bored/scripts/dash-bored" "\${CODEX_HOME:-$HOME/.codex}/skills/dash-bored/scripts/dash-bored"; do
  if [ -x "$launcher" ]; then exec "$launcher" "$@"; fi
done
echo "dash-bored: install and open the desktop app once to install the dash-bored skill, or set DASH_BORED_TOOL to its bundled tool." >&2
exit 127
`,
  "component.yaml": `schemaVersion: 3
apiVersion: 2.0.0
id: __COMPONENT_ID__
name: New component
description: A project-owned component ready to customize.
entry: ./index.tsx
propsSchema:
  type: object
  additionalProperties: false
  properties:
    title:
      type: string
      default: New component
  required: []
children:
  min: 0
  max: 0
  presentation:
    type: tiled
    axes: both
permissions: []
`,
  "index.tsx": `import { defineComponent } from "@dash-bored/component";
import "./styles.css";

export default defineComponent<{ title?: string }>(({ props }) => (
  <section className="__COMPONENT_CLASS__">
    <h2>{props.title ?? "New component"}</h2>
    <p>Ready to customize.</p>
  </section>
));
`,
  "styles.css": `.__COMPONENT_CLASS__ {
  min-width: 0;
  color: var(--text);
}
`,
  "README.md": `# Component

An editable component using the public SDK. Customize its manifest, source,
and styles. No project permissions are requested by the scaffold.

## Develop

Agents: use the installed **dash-bored** skill and its
\`references/components.md#standalone-component-authoring\` workflow. This is
a component repository; dashboard files are only needed later for preview.

The tool is not on PATH. The included \`dash-bored.sh\` uses
\`DASH_BORED_TOOL\` when the app launched you, otherwise the installed skill
launcher in \`~/.agents/skills/dash-bored\` or \`$CODEX_HOME/skills/dash-bored\`
(default \`~/.codex/skills/dash-bored\`). Install and open the desktop app once
if neither is available. Each command works in a fresh shell:

\`\`\`sh
sh ./dash-bored.sh component api --json
sh ./dash-bored.sh component setup .
sh ./dash-bored.sh component check . --json
\`\`\`

Run setup after cloning or updating dash-bored to install matched editor
declarations. It preserves runtime module resolution for tests and builds.
Keep \`.dash-bored-sdk/\` out of version control. Check validates the manifest,
TypeScript and production bundle without running the component. For published
JavaScript, also pass \`--source-project <tsconfig>\` to check original sources.

To see the component in context, add \`./components/__COMPONENT_ID__\` to a dashboard
and open that dashboard in the app. With the component node selected, capture the
real dashboard from its live host:

\`\`\`sh
sh ./dash-bored.sh app screenshot --focus __COMPONENT_ID__ --output /tmp/component.png
\`\`\`

The screenshot uses the app's component host, theme, layout and action registration.
Check default, loading, empty and error states where applicable, light/dark
themes, narrow panes and keyboard controls. Restore any changed focus or tab.
Report the API target, SDK digest, check stages and preview evidence at handoff.
`,
};

type ParsedAuthoringCommand = {
  command: "api" | "init" | "setup" | "check" | "prepare";
  directory?: string;
  apiVersion?: string;
  tsconfig?: string;
  sourceProject?: string;
  dependency?: string;
  output?: string;
  json: boolean;
  help: boolean;
  error?: string;
};

function usage(): string {
  return `dash-bored component <authoring command>

Commands:
  dash-bored component api [--api-version <version>] [--json]
  dash-bored component init <directory>
  dash-bored component setup <directory> [--tsconfig <file>]
  dash-bored component check <directory> [--source-project <file>] [--json]
  dash-bored component prepare <directory> --dependency <package> --output <relative.js>

Create a local component, install the matching editor SDK, and check it against
the component API shipped with this dash-bored CLI.`;
}

function parseAuthoringArguments(args: string[]): ParsedAuthoringCommand | null {
  const command = args[0];
  if (command !== "api" && command !== "init" && command !== "setup" && command !== "check" && command !== "prepare") return null;
  const parsed: ParsedAuthoringCommand = { command, json: false, help: false };
  const positional: string[] = [];
  const seenOptions = new Set<string>();
  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--help" || arg === "-h") { parsed.help = true; continue; }
    if (arg === "--json") { parsed.json = true; continue; }
    const option = arg.startsWith("--") ? arg.split("=", 1)[0] : null;
    if (option && ["--api-version", "--tsconfig", "--source-project", "--dependency", "--output"].includes(option)) {
      if (seenOptions.has(option)) { parsed.error = `Option ${option} may be specified only once.`; return parsed; }
      seenOptions.add(option);
      const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[++i];
      if (!value || value.startsWith("--")) { parsed.error = `Option ${option} requires a value.`; return parsed; }
      if (option === "--api-version") parsed.apiVersion = value;
      if (option === "--tsconfig") parsed.tsconfig = value;
      if (option === "--source-project") parsed.sourceProject = value;
      if (option === "--dependency") parsed.dependency = value;
      if (option === "--output") parsed.output = value;
      continue;
    }
    if (arg.startsWith("-")) { parsed.error = `Unknown option for component ${command}: ${arg}`; return parsed; }
    positional.push(arg);
  }
  if (parsed.help) return parsed;
  if (command === "api") {
    if (positional.length) parsed.error = "component api does not accept a directory.";
  } else if (positional.length !== 1) {
    parsed.error = `component ${command} requires exactly one directory.`;
  } else parsed.directory = positional[0]!;
  if (command !== "api" && parsed.apiVersion !== undefined) parsed.error = `component ${command} does not accept --api-version.`;
  if (command !== "setup" && parsed.tsconfig !== undefined) parsed.error = `component ${command} does not accept --tsconfig.`;
  if (command !== "check" && parsed.sourceProject !== undefined) parsed.error = `component ${command} does not accept --source-project.`;
  if (command !== "api" && parsed.json && command !== "check") parsed.error = `component ${command} does not accept --json.`;
  if (command === "prepare" && (!parsed.dependency || !parsed.output)) parsed.error = "component prepare requires --dependency and --output.";
  if (command !== "prepare" && (parsed.dependency || parsed.output)) parsed.error = `component ${command} does not accept --dependency or --output.`;
  return parsed;
}

function componentIdForDirectory(directory: string): string {
  let slug = basename(resolve(directory)).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64).replace(/-+$/g, "");
  if (!slug) slug = "component";
  if (!/^[a-z]/.test(slug)) slug = `component-${slug}`.slice(0, 64).replace(/-+$/g, "");
  return slug;
}

async function scaffold(directory: string): Promise<string[]> {
  const root = resolve(directory);
  const componentId = componentIdForDirectory(root);
  const componentClass = `${componentId}-component`;
  await mkdir(root, { recursive: true });
  for (const relative of Object.keys(STARTER_FILES)) {
    const path = join(root, relative);
    try {
      await lstat(path);
      throw new Error(`Refusing to overwrite existing file: ${path}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const created: string[] = [];
  for (const [relative, template] of Object.entries(STARTER_FILES)) {
    const contents = template.replaceAll("__COMPONENT_ID__", componentId).replaceAll("__COMPONENT_CLASS__", componentClass);
    const path = join(root, relative);
    await mkdir(dirname(path), { recursive: true });
    try {
      await writeFile(path, contents, { encoding: "utf8", flag: "wx" });
      created.push(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`Refusing to overwrite existing file: ${path}`);
      }
      throw error;
    }
  }
  return created;
}

export async function runComponentAuthoringCommand(args: string[]): Promise<number | null> {
  const parsed = parseAuthoringArguments(args);
  if (!parsed) return null;
  if (parsed.help) { console.log(usage()); return 0; }
  if (parsed.error) { console.error(`${parsed.error}\n\n${usage()}`); return 2; }
  try {
    if (parsed.command === "api") {
      const result = componentApiInfo(parsed.apiVersion);
      console.log(JSON.stringify(result, null, 2));
      return 0;
    }
    const directory = parsed.directory!;
    if (parsed.command === "prepare") {
      const result = await prepareComponentDependency(directory, { dependency: parsed.dependency!, output: parsed.output! });
      console.log(JSON.stringify({ ok: true, ...result }, null, 2));
      return 0;
    }
    if (parsed.command === "init") {
      const files = await scaffold(directory);
      const setup = await setupComponentAuthoring(directory);
      console.log(JSON.stringify({ ok: true, directory: resolve(directory), files, setup }, null, 2));
      return 0;
    }
    if (parsed.command === "setup") {
      const result = await setupComponentAuthoring(directory, parsed.tsconfig ? { tsconfig: parsed.tsconfig } : undefined);
      console.log(JSON.stringify({ ok: true, directory: resolve(directory), setup: result }, null, 2));
      return 0;
    }
    const result = await checkComponentDirectory(directory, parsed.sourceProject ? { sourceProject: parsed.sourceProject } : undefined);
    if (parsed.json) console.log(JSON.stringify(result, null, 2));
    else {
      for (const stage of result.stages) {
        const record = stage as unknown as Record<string, unknown>;
        const label = String(record.name ?? record.id ?? record.stage ?? "check");
        const status = record.status;
        const outcome = status === "not-run" ? "SKIP" : Boolean(record.ok ?? record.success) ? "PASS" : "FAIL";
        console.log(`${outcome} ${label}`);
      }
      for (const diagnostic of result.diagnostics) {
        const where = diagnostic.file ? `${diagnostic.file}${diagnostic.line ? `:${diagnostic.line}${diagnostic.column ? `:${diagnostic.column}` : ""}` : ""}` : "component";
        const stream = diagnostic.severity === "error" ? console.error : console.warn;
        stream(`${where} [${diagnostic.code}] ${diagnostic.message}`);
      }
      if (result.ok) console.log(`Component is compatible with API ${result.apiVersion}.`);
    }
    return result.ok ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (parsed.json) console.error(JSON.stringify({ ok: false, command: parsed.command, error: message }, null, 2));
    else console.error(message);
    return 1;
  }
}

export { usage as componentAuthoringUsage };
