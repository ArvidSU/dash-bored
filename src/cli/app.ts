import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { listAppInstances, selectAppInstance } from "../core/app-instances";
import { CoreError, resolveProjectLocation } from "../core/index";
import type { AgentActionDescriptor, AgentViewState, AppInstanceRecord } from "../shared/agent-control";

export const APP_USAGE = `dash-bored app status [--instance <identifier>]
  dash-bored app actions [--all] [--instance <identifier>]
  dash-bored app run <action> [--select <choice>=<option> ...] [--instance <identifier>]
  dash-bored app open <dashboard> [--instance <identifier>]
  dash-bored app screenshot [--focus <node-id>] [--output <file.png>] [--instance <identifier>]`;

interface AppArguments {
  verb: string | undefined;
  positional: string[];
  instance?: string;
  output?: string;
  focus?: string;
  all: boolean;
  selections: Record<string, string>;
}

function parseAppArguments(args: string[]): AppArguments {
  const parsed: AppArguments = { verb: undefined, positional: [], all: false, selections: {} };
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
    else if (argument === "--all") parsed.all = true;
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

  if (parsed.verb === "actions" && parsed.positional.length === 0) {
    const instance = await selectedInstance(parsed.instance);
    const { actions } = await (await call(instance, "/v1/actions")).json() as { actions: AgentActionDescriptor[] };
    print(parsed.all ? actions : actions.filter((action) => action.enabled && !action.refusal));
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
    if (parsed.focus !== undefined) {
      const { state } = await (await call(instance, "/v1/status")).json() as { state: AgentViewState };
      if (state.focusedNodeId !== parsed.focus) {
        const focused = await runAction(instance, `focus:${encodeURIComponent(parsed.focus)}`, {});
        if (focused.result.status !== "completed") {
          print(focused);
          return 1;
        }
      }
    }
    const png = new Uint8Array(await (await call(instance, "/v1/screenshot", {})).arrayBuffer());
    const output = resolve(parsed.output ?? defaultScreenshotPath(instance));
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, png);
    const { state } = await (await call(instance, "/v1/status")).json() as { state: unknown };
    print({ path: output, bytes: png.byteLength, state });
    return 0;
  }

  throw new Error(`Usage: ${APP_USAGE}`);
}
