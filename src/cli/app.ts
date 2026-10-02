import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { listAppInstances, selectAppInstance } from "../core/app-instances";
import { CoreError, resolveProjectLocation } from "../core/index";
import { printJson as print } from "./print-json";
import {
  AGENT_LOG_DEFAULT_TAIL,
  AGENT_LOG_MAX_TAIL,
  type AgentActionDescriptor,
  type AgentNodeMeasurement,
  type AgentNodeText,
  type AgentProcessInfo,
  type AgentProcessLogs,
  type AgentViewState,
  type AppInstanceRecord,
} from "../shared/agent-control";

export const APP_USAGE = `dash-bored app status [--instance <identifier>]
  dash-bored app actions [<filter>] [--all] [--choices] [--instance <identifier>]
  dash-bored app run <action> [--select <choice>=<option> ...] [--timeout <ms>] [--no-wait] [--until-exit] [--instance <identifier>]
  dash-bored app open <dashboard> [--instance <identifier>]
  dash-bored app processes [<command-id>] [--instance <identifier>]
  dash-bored app wait <command-id> [--timeout <ms>] [--tail <n>] [--instance <identifier>]
  dash-bored app logs <command-id> [--tail <n>] [--instance <identifier>]
  dash-bored app read <node-id> [--timeout <ms>] [--instance <identifier>]
  dash-bored app screenshot [--node <node-id>] [--focus <node-id> [--keep-focus]] [--output <file.png>] [--timeout <ms>] [--instance <identifier>]

\`actions\` prints choices as {id, label, optionCount}; \`--choices\` adds their options. \`screenshot\`
captures the window; \`--node\` crops to one node and restores any view change it made;
\`--focus\` focuses a node for the capture and then restores the previous focus unless
\`--keep-focus\` is given.`;

interface AppArguments {
  verb: string | undefined;
  positional: string[];
  instance?: string;
  output?: string;
  focus?: string;
  tail?: number;
  node?: string;
  all: boolean;
  choices: boolean;
  keepFocus: boolean;
  timeout?: number;
  wait: boolean;
  untilExit: boolean;
  selections: Record<string, string>;
}

function parseAppArguments(args: string[]): AppArguments {
  const parsed: AppArguments = {
    verb: undefined, positional: [], all: false, choices: false, keepFocus: false, wait: true, untilExit: false, selections: {},
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    const value = () => {
      const next = args[index + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`Option ${argument} requires a value.`);
      index += 1;
      return next;
    };
    if (argument === "--instance") parsed.instance = value();
    else if (argument === "--output") parsed.output = value();
    else if (argument === "--focus") parsed.focus = value();
    else if (argument === "--node") parsed.node = value();
    else if (argument === "--all") parsed.all = true;
    else if (argument === "--tail") {
      const tail = value();
      if (!/^\d+$/.test(tail) || Number(tail) < 1) throw new Error("--tail expects a positive integer.");
      parsed.tail = Number(tail);
    }
    else if (argument === "--no-wait") parsed.wait = false;
    else if (argument === "--until-exit") parsed.untilExit = true;
    else if (argument === "--timeout") {
      const timeout = Number(value());
      if (!Number.isInteger(timeout) || timeout < 0) throw new Error("--timeout expects a number of milliseconds.");
      parsed.timeout = timeout;
    }
    else if (argument === "--choices" || argument === "--full") parsed.choices = true;
    else if (argument === "--keep-focus") parsed.keepFocus = true;
    else if (argument === "--select") {
      const selection = value();
      const separator = selection.indexOf("=");
      if (separator <= 0) throw new Error("--select expects <choice>=<option>.");
      parsed.selections[selection.slice(0, separator)] = selection.slice(separator + 1);
    } else if (argument.startsWith("-")) throw new Error(`Unknown option for app: ${argument}`);
    else if (parsed.verb === undefined) parsed.verb = argument;
    else parsed.positional.push(argument);
  }
  return parsed;
}

async function selectedInstance(requested: string | undefined): Promise<AppInstanceRecord> {
  return selectAppInstance(await listAppInstances(), requested, process.env.DASH_BORED_APP_INSTANCE || undefined);
}

async function call(instance: AppInstanceRecord, path: string, body?: unknown): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`http://dash-bored${path}`, {
      method: body === undefined ? "GET" : "POST",
      unix: instance.socketPath,
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
    } as RequestInit);
  } catch (error) {
    throw new CoreError(
      "APP_CONTROL_UNREACHABLE",
      `Could not reach dash-bored ${instance.identifier}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok && response.headers.get("content-type")?.includes("application/json")) {
    const payload = await response.clone().json() as { error?: { code?: string; message?: string } };
    if (payload.error) throw new CoreError(payload.error.code ?? "APP_CONTROL_FAILED", payload.error.message ?? "Request failed.");
  }
  return response;
}

// CSI and OSC sequences, then any other escape (keypad `ESC =`, charset `ESC ( B`).
const ANSI_ESCAPES = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[ -/]*[0-~])/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPES, "");
}

/** What a terminal shows for one line: escapes removed, the last carriage-return overwrite kept. */
function terminalLine(line: string): string {
  return stripAnsi(line).split("\r").filter((segment) => segment !== "").at(-1)?.trimEnd() ?? "";
}

function defaultScreenshotPath(instance: AppInstanceRecord): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(tmpdir(), "dash-bored-screenshots", `${instance.identifier}-${stamp}.png`);
}

/** Choice options can number in the hundreds; list their count and let `--choices` expand them. */
function summarizeChoices({ choices, ...action }: AgentActionDescriptor) {
  return {
    ...action,
    ...(choices ? { choices: choices.map(({ id, label, options }) => ({ id, label, optionCount: Array.isArray(options) ? options.length : 0 })) } : {}),
  };
}

interface RunOutcome {
  result: { status: string; reason?: string; suggestions?: string[] };
  state: unknown;
  idle?: boolean;
  warning?: string;
}

async function runAction(
  instance: AppInstanceRecord,
  reference: string,
  selections: Record<string, string>,
  wait: { wait?: boolean; timeoutMs?: number } = {},
): Promise<RunOutcome> {
  const response = await call(instance, "/v1/actions/run", {
    reference,
    ...(Object.keys(selections).length ? { selections } : {}),
    ...(wait.wait === false ? { wait: false } : {}),
    ...(wait.timeoutMs === undefined ? {} : { timeoutMs: wait.timeoutMs }),
  });
  return await response.json() as RunOutcome;
}

const PROCESS_POLL_MS = 250;
const DEFAULT_EXIT_TIMEOUT_MS = 10 * 60_000;
const EXIT_LOG_TAIL = 20;

async function processInfo(instance: AppInstanceRecord, id: string): Promise<AgentProcessInfo> {
  const { processes } = await (await call(instance, "/v1/processes")).json() as { processes: AgentProcessInfo[] };
  const found = processes.find((process) => process.id === id);
  if (!found) {
    throw new CoreError("AGENT_CONTROL_NOT_FOUND", `No command process has the id ${id}. List them with \`dash-bored app processes\`.`);
  }
  return found;
}

/** The process manager's own end-of-run line (src/core/process-manager.ts). */
const EXIT_MARKER = /^Command exited (?:with code -?\d+|after \w+)\.$/;
/** Room for the interactive shell's prompt, which follows the exit line. */
const PROMPT_LINES = 20;

/**
 * Commands run in the user's interactive shell, so a finished run's output
 * ends with their prompt; drop what follows the latest exit line.
 */
async function processLogs(instance: AppInstanceRecord, id: string, tail: number | undefined): Promise<AgentProcessLogs> {
  const wanted = tail ?? AGENT_LOG_DEFAULT_TAIL;
  const query = `?tail=${Math.min(AGENT_LOG_MAX_TAIL, wanted + PROMPT_LINES)}`;
  const { logs } = await (await call(instance, `/v1/processes/${encodeURIComponent(id)}/logs${query}`)).json() as { logs: AgentProcessLogs };
  let lines = logs.lines.map(terminalLine);
  if (logs.state === "exited") {
    const end = lines.map((line) => EXIT_MARKER.test(line)).lastIndexOf(true);
    if (end >= 0) lines = lines.slice(0, end + 1);
  }
  const kept = lines.slice(-wanted);
  return { ...logs, lines: kept, truncated: logs.truncated || kept.length < lines.length };
}

/**
 * Polls a command process until it is no longer running (and, for a run the
 * agent just started, until that run rather than an earlier one is reported),
 * then returns its final state with the tail of its output.
 */
async function waitForExit(
  instance: AppInstanceRecord,
  id: string,
  options: { timeoutMs: number; tail: number; previousStartedAt?: string },
) {
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    const process = await processInfo(instance, id);
    const current = options.previousStartedAt === undefined || process.startedAt !== options.previousStartedAt;
    if (current && process.state !== "running") {
      return { process, logs: await processLogs(instance, id, options.tail), exited: true };
    }
    if (Date.now() >= deadline) {
      return {
        process,
        logs: await processLogs(instance, id, options.tail),
        exited: false,
        warning: `${id} was still running after ${options.timeoutMs} ms; check again with \`dash-bored app wait ${id}\`.`,
      };
    }
    await Bun.sleep(PROCESS_POLL_MS);
  }
}

const exitStatus = (outcome: { exited: boolean; process: AgentProcessInfo }) =>
  outcome.exited && outcome.process.exitCode === 0 ? 0 : 1;

/**
 * Agent access to the running app: read state, invoke palette actions, open a
 * dashboard, and capture the window. The app enforces what an agent may run.
 */
export async function runAppCommand(args: string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(APP_USAGE);
    return 0;
  }
  const parsed = parseAppArguments(args);

  if (parsed.verb === "status" && parsed.positional.length === 0) {
    const instances = await listAppInstances();
    const instance = selectAppInstance(instances, parsed.instance, process.env.DASH_BORED_APP_INSTANCE || undefined);
    const status = await (await call(instance, "/v1/status")).json();
    print({ ...status as object, running: instances.map(({ identifier, version, pid }) => ({ identifier, version, pid })) });
    return 0;
  }

  if (parsed.verb === "actions" && parsed.positional.length <= 1) {
    const instance = await selectedInstance(parsed.instance);
    const { actions } = await (await call(instance, "/v1/actions")).json() as { actions: AgentActionDescriptor[] };
    // Dashboards with many nodes list hundreds of actions; a filter keeps the
    // agent's context to the ones it is looking for.
    const filter = parsed.positional[0]?.toLowerCase();
    const listed = actions.filter((action) => (parsed.all || (action.enabled && !action.refusal))
      && (!filter || [action.id, action.reference, action.label, action.group, action.source]
        .some((field) => field?.toLowerCase().includes(filter))));
    print(parsed.choices ? listed : listed.map(summarizeChoices));
    return 0;
  }

  if (parsed.verb === "run" && parsed.positional.length === 1) {
    const instance = await selectedInstance(parsed.instance);
    const reference = parsed.positional[0]!;
    const commandId = reference.startsWith("process:") ? decodeURIComponent(reference.slice("process:".length)) : undefined;
    if (parsed.untilExit && commandId === undefined) throw new Error("--until-exit applies only to process:<command-id> actions.");
    const previousStartedAt = parsed.untilExit ? (await processInfo(instance, commandId!)).startedAt : undefined;
    const outcome = await runAction(instance, reference, parsed.selections, {
      wait: parsed.wait,
      ...(parsed.timeout === undefined || parsed.untilExit ? {} : { timeoutMs: parsed.timeout }),
    });
    if (!parsed.untilExit || outcome.result.status !== "completed") {
      print(outcome);
      return outcome.result.status === "completed" ? 0 : 1;
    }
    const exit = await waitForExit(instance, commandId!, {
      timeoutMs: parsed.timeout ?? DEFAULT_EXIT_TIMEOUT_MS,
      tail: parsed.tail ?? EXIT_LOG_TAIL,
      ...(previousStartedAt === undefined ? {} : { previousStartedAt }),
    });
    print({ ...outcome, ...exit });
    return exitStatus(exit);
  }

  if (parsed.verb === "open" && parsed.positional.length === 1) {
    const instance = await selectedInstance(parsed.instance);
    const location = await resolveProjectLocation(parsed.positional[0]!);
    print(await (await call(instance, "/v1/open", { configPath: location.configPath })).json());
    return 0;
  }

  if (parsed.verb === "processes" && parsed.positional.length <= 1) {
    const instance = await selectedInstance(parsed.instance);
    if (parsed.positional.length === 1) {
      print(await processInfo(instance, parsed.positional[0]!));
      return 0;
    }
    const { processes } = await (await call(instance, "/v1/processes")).json() as { processes: AgentProcessInfo[] };
    print(processes);
    return 0;
  }

  if (parsed.verb === "wait" && parsed.positional.length === 1) {
    const instance = await selectedInstance(parsed.instance);
    const exit = await waitForExit(instance, parsed.positional[0]!, {
      timeoutMs: parsed.timeout ?? DEFAULT_EXIT_TIMEOUT_MS,
      tail: parsed.tail ?? EXIT_LOG_TAIL,
    });
    print(exit);
    return exitStatus(exit);
  }

  if (parsed.verb === "read" && parsed.positional.length === 1) {
    const instance = await selectedInstance(parsed.instance);
    const { node } = await (await call(instance, "/v1/read", {
      nodeId: parsed.positional[0]!,
      ...(parsed.timeout === undefined ? {} : { timeoutMs: parsed.timeout }),
    })).json() as { node: AgentNodeText };
    print({
      ...node,
      ...(node.idle ? {} : { warning: "Some of its sources were still loading; retry with a larger --timeout." }),
    });
    return 0;
  }

  if (parsed.verb === "logs" && parsed.positional.length === 1) {
    const instance = await selectedInstance(parsed.instance);
    print(await processLogs(instance, parsed.positional[0]!, parsed.tail));
    return 0;
  }

  if (parsed.verb === "screenshot" && parsed.positional.length === 0) {
    const instance = await selectedInstance(parsed.instance);
    let previousFocusedNodeId: string | null | undefined;
    let focusChanged = false;
    if (parsed.focus !== undefined) {
      const { state } = await (await call(instance, "/v1/status")).json() as { state: AgentViewState };
      previousFocusedNodeId = state.focusedNodeId;
      if (state.focusedNodeId !== parsed.focus) {
        const focused = await runAction(instance, `focus:${encodeURIComponent(parsed.focus)}`, {}, { wait: false });
        if (focused.result.status !== "completed") {
          if (focused.result.status === "unavailable" && focused.result.suggestions !== undefined) {
            const close = focused.result.suggestions.length ? ` Close matches: ${focused.result.suggestions.join(", ")}.` : "";
            focused.result.reason = `Node ${parsed.focus} is not in the active dashboard.${close} Find node ids with \`dash-bored inspect . --summary\` or \`dash-bored app actions focus\`.`;
          }
          print(focused);
          return 1;
        }
        focusChanged = true;
      }
    }
    let png: Uint8Array;
    let node: AgentNodeMeasurement | undefined;
    let idle = true;
    try {
      const response = await call(instance, "/v1/screenshot", {
        ...(parsed.node === undefined ? {} : { nodeId: parsed.node }),
        ...(parsed.timeout === undefined ? {} : { timeoutMs: parsed.timeout }),
      });
      png = new Uint8Array(await response.arrayBuffer());
      idle = response.headers.get("x-dash-bored-idle") !== "false";
      const header = response.headers.get("x-dash-bored-node");
      if (header) node = JSON.parse(header) as AgentNodeMeasurement;
    } finally {
      if (focusChanged && !parsed.keepFocus && previousFocusedNodeId) {
        await runAction(instance, `focus:${encodeURIComponent(previousFocusedNodeId)}`, {}, { wait: false });
      }
    }
    const { state } = await (await call(instance, "/v1/status")).json() as { state: unknown };
    const output = resolve(parsed.output ?? defaultScreenshotPath(instance));
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, png);
    print({
      path: output,
      bytes: png.byteLength,
      // The app undoes any reveal or scroll before replying.
      ...(node ? { node, viewRestored: true } : {}),
      ...(parsed.focus !== undefined ? { previousFocusedNodeId, focusRestored: focusChanged && !parsed.keepFocus } : {}),
      state,
      ...(idle ? {} : { idle: false, warning: "The app was still loading when captured; retry with a larger --timeout." }),
    });
    return 0;
  }

  const verbs = ["status", "actions", "run", "open", "processes", "wait", "logs", "read", "screenshot"];
  const problem = parsed.verb === undefined ? "Missing app command."
    : verbs.includes(parsed.verb) ? `Wrong arguments for app ${parsed.verb}.`
      : `Unknown app command: ${parsed.verb}. This tool supports ${verbs.join(", ")}; if the skill documents more, the installed app is older than the skill.`;
  throw new Error(`${problem}\nUsage: ${APP_USAGE}`);
}
