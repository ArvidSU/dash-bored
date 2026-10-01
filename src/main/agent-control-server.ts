import { chmod, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  AgentActionDescriptor,
  AgentNodeMeasurement,
  AgentRunActionRequest,
  AgentRunActionResult,
  AgentViewState,
  AppInstanceRecord,
} from "../shared/agent-control";
import { CoreError } from "../core/index";
import { cropNodeCapture } from "./png-crop";
import { publishAppInstance, withdrawAppInstance } from "../core/app-instances";

export interface AgentControlBridge {
  viewState(): Promise<AgentViewState>;
  listActions(): Promise<AgentActionDescriptor[]>;
  runAction(request: AgentRunActionRequest): Promise<AgentRunActionResult>;
  /** Resolves after the renderer has painted pending updates. */
  settle(): Promise<void>;
  capture(): Promise<Uint8Array<ArrayBuffer>>;
  /**
   * Makes a node visible (revealing and scrolling only when needed) and
   * measures it. Every call is paired with `endNodeCapture`, which undoes any
   * view change the renderer made.
   */
  beginNodeCapture(nodeId: string): Promise<AgentNodeMeasurement>;
  endNodeCapture(): Promise<void>;
  openDashboard(configPath: string): Promise<void>;
}

export interface AgentControlServer {
  readonly record: AppInstanceRecord;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 64 * 1024;

function json(value: unknown, status = 200): Response {
  return new Response(`${JSON.stringify(value)}\n`, { status, headers: { "content-type": "application/json" } });
}

function failure(error: unknown): Response {
  const code = error instanceof CoreError ? error.code : "AGENT_CONTROL_FAILED";
  const message = error instanceof Error ? error.message : String(error);
  const status = code === "AGENT_CONTROL_BAD_REQUEST" ? 400 : code === "AGENT_CONTROL_NOT_FOUND" ? 404 : 409;
  return json({ error: { code, message } }, status);
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) {
    throw new CoreError("AGENT_CONTROL_BAD_REQUEST", "The request body is too large.");
  }
  if (text.trim() === "") return {};
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CoreError("AGENT_CONTROL_BAD_REQUEST", "The request body must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

function selections(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || Object.values(value).some((entry) => typeof entry !== "string")) {
    throw new CoreError("AGENT_CONTROL_BAD_REQUEST", "selections must map choice ids to option ids.");
  }
  return value as Record<string, string>;
}

/**
 * Serves the running app's agent-control channel on a user-private Unix socket.
 * Every operation goes through the same renderer action registry or runtime
 * path as the UI; the channel adds no capability of its own.
 */
export async function startAgentControlServer(
  identity: Omit<AppInstanceRecord, "startedAt">,
  bridge: AgentControlBridge,
  options: { homeDirectory?: string } = {},
): Promise<AgentControlServer> {
  await mkdir(dirname(identity.socketPath), { recursive: true, mode: 0o700 });
  await chmod(dirname(identity.socketPath), 0o700);
  await rm(identity.socketPath, { force: true });

  let capturingNode = false;
  async function captureNode(nodeId: string): Promise<Response> {
    if (capturingNode) throw new CoreError("AGENT_CONTROL_BUSY", "Another node screenshot is in progress.");
    capturingNode = true;
    try {
      const node = await bridge.beginNodeCapture(nodeId);
      try {
        const png = cropNodeCapture(await bridge.capture(), node);
        return new Response(png, { headers: { "content-type": "image/png", "x-dash-bored-node": JSON.stringify(node) } });
      } finally {
        await bridge.endNodeCapture();
      }
    } finally {
      capturingNode = false;
    }
  }

  const server = Bun.serve({
    unix: identity.socketPath,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      try {
        if (request.method === "GET" && pathname === "/v1/status") {
          return json({ instance: record, state: await bridge.viewState() });
        }
        if (request.method === "GET" && pathname === "/v1/actions") {
          return json({ actions: await bridge.listActions() });
        }
        if (request.method === "POST" && pathname === "/v1/actions/run") {
          const body = await readBody(request);
          if (typeof body.reference !== "string" || body.reference === "") {
            throw new CoreError("AGENT_CONTROL_BAD_REQUEST", "reference must name an action id or reference.");
          }
          const selected = selections(body.selections);
          const result = await bridge.runAction({ reference: body.reference, ...(selected ? { selections: selected } : {}) });
          await bridge.settle();
          return json({ result, state: await bridge.viewState() }, result.status === "completed" ? 200 : 409);
        }
        if (request.method === "POST" && pathname === "/v1/open") {
          const body = await readBody(request);
          if (typeof body.configPath !== "string" || body.configPath === "") {
            throw new CoreError("AGENT_CONTROL_BAD_REQUEST", "configPath must be a dashboard path.");
          }
          if ((await bridge.viewState()).editing) {
            throw new CoreError("AGENT_CONTROL_DRAFT_OPEN", "The user is editing a dashboard draft. Ask them to save or cancel it first.");
          }
          await bridge.openDashboard(body.configPath);
          await bridge.settle();
          return json({ state: await bridge.viewState() });
        }
        if (request.method === "POST" && pathname === "/v1/screenshot") {
          const body = await readBody(request);
          if (body.nodeId !== undefined && (typeof body.nodeId !== "string" || body.nodeId === "")) {
            throw new CoreError("AGENT_CONTROL_BAD_REQUEST", "nodeId must be a node id.");
          }
          if (body.nodeId === undefined) {
            await bridge.settle();
            return new Response(await bridge.capture(), { headers: { "content-type": "image/png" } });
          }
          return await captureNode(body.nodeId);
        }
        throw new CoreError("AGENT_CONTROL_NOT_FOUND", `Unknown agent-control route ${request.method} ${pathname}.`);
      } catch (error) {
        return failure(error);
      }
    },
  });
  await chmod(identity.socketPath, 0o600);

  const record: AppInstanceRecord = { ...identity, startedAt: new Date().toISOString() };
  await publishAppInstance(record, options.homeDirectory);

  return {
    record,
    async close() {
      server.stop(true);
      await withdrawAppInstance(record.identifier, record.pid, options.homeDirectory);
    },
  };
}
