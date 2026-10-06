import { lstat, mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  checkComponentDirectory,
  componentApiInfo,
  setupComponentAuthoring,
} from "../core/component-authoring";

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
apiVersion: 1.0.0
id: __COMPONENT_ID__
name: Focus timer
description: A small work and break timer with clear, local controls.
entry: ./index.tsx
propsSchema:
  type: object
  additionalProperties: false
  properties:
    title:
      type: string
      description: Heading shown above the timer.
      default: One thing at a time
    focusMinutes:
      type: integer
      description: Length of each focus session in minutes.
      minimum: 1
      maximum: 180
      default: 25
    breakMinutes:
      type: integer
      description: Length of each break in minutes.
      minimum: 1
      maximum: 60
      default: 5
  required: []
children:
  min: 0
  max: 0
  presentation:
    type: tiled
    axes: both
permissions: []
actions:
  - id: start
    label: Start timer
    description: Start or continue the current focus or break session.
  - id: pause
    label: Pause timer
    description: Pause the current session and retain its remaining time.
  - id: reset
    label: Reset timer
    description: Return the current work or break session to its configured duration.
`,
  "index.tsx": `import {
  defineComponent,
  useCallback,
  useComponentVisibility,
  useEffect,
  useState,
} from "@dash-bored/component";
import "./styles.css";

interface Props {
  title?: string;
  focusMinutes?: number;
  breakMinutes?: number;
}

export default defineComponent<Props>(function FocusTimer({ props, host }) {
  const focusMinutes = props.focusMinutes ?? 25;
  const breakMinutes = props.breakMinutes ?? 5;
  const visible = useComponentVisibility();
  const [phase, setPhase] = useState<"focus" | "break">("focus");
  const [remainingMs, setRemainingMs] = useState(focusMinutes * 60_000);
  const [deadline, setDeadline] = useState<number | null>(null);
  const [completed, setCompleted] = useState(0);
  const durationMs = (phase === "focus" ? focusMinutes : breakMinutes) * 60_000;
  const finished = remainingMs === 0;

  useEffect(() => {
    setPhase("focus");
    setRemainingMs(focusMinutes * 60_000);
    setDeadline(null);
    setCompleted(0);
  }, [focusMinutes, breakMinutes]);

  useEffect(() => {
    if (deadline === null || !visible) return;
    const tick = () => {
      const remaining = Math.max(0, deadline - Date.now());
      setRemainingMs(remaining);
      if (remaining === 0) setDeadline(null);
    };
    tick();
    const timer = window.setInterval(tick, 250);
    return () => window.clearInterval(timer);
  }, [deadline, visible]);

  const seconds = Math.ceil(remainingMs / 1000);
  const message = finished
    ? phase === "focus" ? "Focus complete. Take a breath." : "Break complete. Ready when you are."
    : deadline !== null ? "Stay with the work in front of you."
    : remainingMs < durationMs ? "Paused. Pick up when you are ready."
    : "A little space for meaningful work.";

  const pause = useCallback(() => {
    if (deadline !== null) {
      setRemainingMs(Math.max(0, deadline - Date.now()));
      setDeadline(null);
    }
  }, [deadline]);

  const startNext = useCallback(() => {
    if (phase === "focus") setCompleted((count) => count + 1);
    const nextPhase = phase === "focus" ? "break" : "focus";
    const nextDuration = (nextPhase === "focus" ? focusMinutes : breakMinutes) * 60_000;
    setPhase(nextPhase);
    setRemainingMs(nextDuration);
    setDeadline(Date.now() + nextDuration);
  }, [breakMinutes, focusMinutes, phase]);

  const start = useCallback(() => {
    if (finished) startNext();
    else setDeadline(Date.now() + remainingMs);
  }, [finished, remainingMs, startNext]);
  const reset = useCallback(() => {
    setDeadline(null);
    setRemainingMs(durationMs);
  }, [durationMs]);
  const toggle = useCallback(() => {
    if (deadline !== null) pause();
    else start();
  }, [deadline, pause, start]);

  useEffect(() => {
    const cleanups = [
      host.actions.register({ id: "start", label: "Start timer", run: start }),
      host.actions.register({ id: "pause", label: "Pause timer", run: pause }),
      host.actions.register({ id: "reset", label: "Reset timer", run: reset }),
    ];
    return () => cleanups.forEach((cleanup) => cleanup());
  }, [host.actions, pause, reset, start]);

  return <section className="__COMPONENT_CLASS__" data-phase={phase} aria-label="Focus timer">
    <p className="__COMPONENT_CLASS____eyebrow">{phase === "focus" ? "FOCUS SESSION" : "ROOM TO BREATHE"}</p>
    <h2>{props.title ?? "One thing at a time"}</h2>
    <div className="__COMPONENT_CLASS____clock" role="timer" aria-label={Math.floor(seconds / 60) + " minutes " + (seconds % 60) + " seconds remaining"}>
      {String(Math.floor(seconds / 60)).padStart(2, "0")}:{String(seconds % 60).padStart(2, "0")}
    </div>
    <p className="__COMPONENT_CLASS____message" role="status">{message}</p>
    <div className="__COMPONENT_CLASS____controls">
      {finished
        ? <button type="button" onClick={startNext}>Start {phase === "focus" ? "break" : "focus"}</button>
        : <button type="button" onClick={toggle}>{deadline !== null ? "Pause" : remainingMs < durationMs ? "Resume" : "Start " + phase}</button>}
      <button type="button" className="__COMPONENT_CLASS____reset" disabled={remainingMs === durationMs && deadline === null} onClick={reset}>Reset</button>
    </div>
    <footer>{completed} focus sessions completed</footer>
  </section>;
});
`,
  "styles.css": `.__COMPONENT_CLASS__ {
  --timer-color: var(--accent);
  container-type: inline-size;
  padding: clamp(18px, 4vw, 36px);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--text);
  background: radial-gradient(ellipse at 50% 35%, color-mix(in srgb, var(--timer-color) 9%, transparent), transparent 70%);
  text-align: center;
}
.__COMPONENT_CLASS__[data-phase="break"] { --timer-color: var(--positive); }
.__COMPONENT_CLASS__ h2 { margin: 18px 0 12px; font-size: clamp(20px, 3vw, 28px); overflow-wrap: anywhere; }
.__COMPONENT_CLASS____eyebrow { color: var(--muted); font: 10px var(--font-mono); letter-spacing: .14em; }
.__COMPONENT_CLASS____clock { color: var(--timer-color); font: clamp(32px, 22cqi, 72px) var(--font-mono); font-variant-numeric: tabular-nums; letter-spacing: -.06em; }
.__COMPONENT_CLASS____message { min-height: 1.5em; color: var(--muted); font-size: 12px; }
.__COMPONENT_CLASS____controls { display: flex; justify-content: center; gap: 8px; flex-wrap: wrap; }
.__COMPONENT_CLASS____controls button { padding: 10px 20px; border: 1px solid var(--timer-color); border-radius: var(--radius-sm); background: var(--timer-color); color: var(--bg); font: inherit; cursor: pointer; }
.__COMPONENT_CLASS____controls .__COMPONENT_CLASS____reset { border-color: var(--border); background: transparent; color: var(--text); }
.__COMPONENT_CLASS____controls button:disabled { opacity: .45; cursor: default; }
.__COMPONENT_CLASS____controls button:focus-visible { outline: 2px solid var(--text); outline-offset: 3px; }
.__COMPONENT_CLASS__ footer { margin-top: 22px; padding-top: 12px; border-top: 1px solid var(--border); color: var(--muted); font-size: 10px; }
`,
  "README.md": `# Focus timer component

A self-contained focus and break timer for a dash-bored dashboard. The default
session is 25 minutes of focus followed by a 5 minute break. Timer state stays
in memory and resets when the component unmounts. No project permissions are
needed.

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
and open that dashboard in the app. With the timer node selected, capture the
real dashboard from its live host:

\`\`\`sh
sh ./dash-bored.sh app screenshot --focus __COMPONENT_ID__ --output /tmp/focus-timer.png
\`\`\`

The screenshot uses the app's component host, theme, layout and action registration.
Check default, loading, empty and error states where applicable, light/dark
themes, narrow panes and keyboard controls. Restore any changed focus or tab.
Report the API target, SDK digest, check stages and preview evidence at handoff.
`,
};

type ParsedAuthoringCommand = {
  command: "api" | "init" | "setup" | "check";
  directory?: string;
  apiVersion?: string;
  tsconfig?: string;
  sourceProject?: string;
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

Create a local component, install the matching editor SDK, and check it against
the component API shipped with this dash-bored CLI.`;
}

function parseAuthoringArguments(args: string[]): ParsedAuthoringCommand | null {
  const command = args[0];
  if (command !== "api" && command !== "init" && command !== "setup" && command !== "check") return null;
  const parsed: ParsedAuthoringCommand = { command, json: false, help: false };
  const positional: string[] = [];
  const seenOptions = new Set<string>();
  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--help" || arg === "-h") { parsed.help = true; continue; }
    if (arg === "--json") { parsed.json = true; continue; }
    const option = arg.startsWith("--") ? arg.split("=", 1)[0] : null;
    if (option && ["--api-version", "--tsconfig", "--source-project"].includes(option)) {
      if (seenOptions.has(option)) { parsed.error = `Option ${option} may be specified only once.`; return parsed; }
      seenOptions.add(option);
      const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[++i];
      if (!value || value.startsWith("--")) { parsed.error = `Option ${option} requires a value.`; return parsed; }
      if (option === "--api-version") parsed.apiVersion = value;
      if (option === "--tsconfig") parsed.tsconfig = value;
      if (option === "--source-project") parsed.sourceProject = value;
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
  const componentClass = `${componentId}-timer`;
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
