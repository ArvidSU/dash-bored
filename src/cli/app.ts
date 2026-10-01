import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { listAppInstances, selectAppInstance } from "../core/app-instances";
import { CoreError, resolveProjectLocation } from "../core/index";
import type { AgentActionDescriptor, AgentNodeMeasurement, AgentViewState, AppInstanceRecord } from "../shared/agent-control";

export const APP_USAGE = `dash-bored app status [--instance <identifier>]
  dash-bored app actions [<filter>] [--all] [--choices] [--instance <identifier>]
  dash-bored app run <action> [--select <choice>=<option> ...] [--instance <identifier>]
  dash-bored app open <dashboard> [--instance <identifier>]
  dash-bored app screenshot [--node <node-id>] [--focus <node-id> [--keep-focus]] [--output <file.png>] [--instance <identifier>]

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
  node?: string;
  all: boolean;
  choices: boolean;
  keepFocus: boolean;
  selections: Record<string, string>;
}

function parseAppArguments(args: string[]): AppArguments {
  const parsed: AppArguments = { verb: undefined, positional: [], all: false, choices: false, keepFocus: false, selections: {} };
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

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, process.stdout.isTTY ? 2 : 0));
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

async function runAction(instance: AppInstanceRecord, reference: string, selections: Record<string, string>) {
  const response = await call(instance, "/v1/actions/run", {
    reference,
    ...(Object.keys(selections).length ? { selections } : {}),
  });
  return await response.json() as { result: { status: string; reason?: string }; state: unknown };
}

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
    const filter = parsed.positional[0]?.toLowerCase();
    const listed = (parsed.all ? actions : actions.filter((action) => action.enabled && !action.refusal))
      .filter((action) => filter === undefined
        || [action.id, action.reference, action.label, action.group].some((field) => field?.toLowerCase().includes(filter)));
    print(parsed.choices ? listed : listed.map(summarizeChoices));
    return 0;
  }

  if (parsed.verb === "run" && parsed.positional.length === 1) {
    const instance = await selectedInstance(parsed.instance);
    const outcome = await runAction(instance, parsed.positional[0]!, parsed.selections);
    print(outcome);
    return outcome.result.status === "completed" ? 0 : 1;
  }

  if (parsed.verb === "open" && parsed.positional.length === 1) {
    const instance = await selectedInstance(parsed.instance);
    const location = await resolveProjectLocation(parsed.positional[0]!);
    print(await (await call(instance, "/v1/open", { configPath: location.configPath })).json());
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
        const focused = await runAction(instance, `focus:${encodeURIComponent(parsed.focus)}`, {});
        if (focused.result.status !== "completed") {
          print(focused);
          return 1;
        }
        focusChanged = true;
      }
    }
    let png: Uint8Array;
    let node: AgentNodeMeasurement | undefined;
    try {
      const response = await call(instance, "/v1/screenshot", parsed.node === undefined ? {} : { nodeId: parsed.node });
      png = new Uint8Array(await response.arrayBuffer());
      const header = response.headers.get("x-dash-bored-node");
      if (header) node = JSON.parse(header) as AgentNodeMeasurement;
    } finally {
      if (focusChanged && !parsed.keepFocus && previousFocusedNodeId) {
        await runAction(instance, `focus:${encodeURIComponent(previousFocusedNodeId)}`, {});
      }
    }
    const { state } = await (await call(instance, "/v1/status")).json() as { state: unknown };
    const output = resolve(parsed.output ?? defaultScreenshotPath(instance));
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, png);
    print({
      path: output,
      bytes: png.byteLength,
      ...(node ? { node } : {}),
      ...(parsed.focus !== undefined ? { previousFocusedNodeId, focusRestored: focusChanged && !parsed.keepFocus } : {}),
      state,
    });
    return 0;
  }

  throw new Error(`Usage: ${APP_USAGE}`);
}
