import { chmod, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  MAX_IDLE_TIMEOUT_MS,
  type AgentActionDescriptor,
  type AgentNodeMeasurement,
  type AgentNodeText,
  type AgentProcessInfo,
  type AgentProcessLogs,
  type AgentRunActionRequest,
  type AgentRunActionResult,
  type AgentViewState,
  type AppInstanceRecord,
} from "../shared/agent-control";
import { clampLogTail } from "../shared/agent-control";
import { CoreError } from "../core/index";
import { cropNodeCapture } from "./png-crop";
import { publishAppInstance, withdrawAppInstance } from "../core/app-instances";

export interface AgentControlBridge {
  viewState(): Promise<AgentViewState>;
  listActions(): Promise<AgentActionDescriptor[]>;
  runAction(request: AgentRunActionRequest): Promise<AgentRunActionResult>;
  /** Resolves after the renderer has painted pending updates. */
  settle(): Promise<void>;
  /**
   * Resolves true once no source fetches are in flight for mounted views
   * (then after a paint), or false when `timeoutMs` elapses first.
   */
  idle(timeoutMs: number): Promise<boolean>;
  capture(): Promise<Uint8Array<ArrayBuffer>>;
  /**
   * Makes a node visible (revealing and scrolling only when needed) and
   * measures it. Every call is paired with `endNodeCapture`, which undoes any
   * view change the renderer made.
   */
  beginNodeCapture(nodeId: string): Promise<AgentNodeMeasurement>;
  endNodeCapture(): Promise<boolean>;
  /** Reads a node's rendered text after its sources load (bounded), restoring any view change. */
  readNode(nodeId: string, timeoutMs: number): Promise<AgentNodeText>;
  openDashboard(configPath: string): Promise<void>;
  /** Command processes of the active dashboard; main owns their state. */
  processes(): AgentProcessInfo[];
  /** Recent output of one command process, or null when none has that id. */
  processLogs(id: string, tail: number): AgentProcessLogs | null;
}

export interface AgentControlServer {
  readonly record: AppInstanceRecord;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 64 * 1024;
/** A minimized or hidden window never paints; report that instead of hanging. */
const SETTLE_TIMEOUT_MS = 5_000;
const NOT_RENDERING =
  "The dash-bored window is not rendering, usually because it is minimized or hidden. Ask the user to show it, then retry.";

const IDLE_TIMED_OUT = (timeoutMs: number) =>
  `The app was still loading after ${timeoutMs} ms; the state may not be final. Re-read status or retry with a larger --timeout.`;

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

function idleTimeout(value: unknown): number {
  if (value === undefined) return DEFAULT_IDLE_TIMEOUT_MS;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_IDLE_TIMEOUT_MS) {
    throw new CoreError("AGENT_CONTROL_BAD_REQUEST", `timeoutMs must be between 0 and ${MAX_IDLE_TIMEOUT_MS}.`);
  }
  return Math.floor(value);
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
  options: { homeDirectory?: string; settleTimeoutMs?: number } = {},
): Promise<AgentControlServer> {
  await mkdir(dirname(identity.socketPath), { recursive: true, mode: 0o700 });
  await chmod(dirname(identity.socketPath), 0o700);
  await rm(identity.socketPath, { force: true });

  async function settled(): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), options.settleTimeoutMs ?? SETTLE_TIMEOUT_MS); });
    try {
      return await Promise.race([bridge.settle().then(() => true as const), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** The renderer bounds the wait itself; the extra margin only guards a stuck paint. */
  async function idle(timeoutMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const backstop = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs + (options.settleTimeoutMs ?? SETTLE_TIMEOUT_MS));
    });
    try {
      return await Promise.race([bridge.idle(timeoutMs), backstop]);
    } finally {
      clearTimeout(timer);
    }
  }

  // Node screenshots and reads temporarily reveal nodes; one at a time keeps
  // each restore from undoing another's reveal.
  let capturingNode = false;
  const busy = () => new CoreError(
    "AGENT_CONTROL_BUSY",
    "Another node screenshot or read is in progress, probably from another agent; retry in a few seconds.",
  );
  async function readNode(nodeId: string, timeoutMs: number): Promise<AgentNodeText> {
    if (capturingNode) throw busy();
    capturingNode = true;
    try {
      return await bridge.readNode(nodeId, timeoutMs);
    } finally {
      capturingNode = false;
    }
  }
  async function captureNode(nodeId: string, timeoutMs: number): Promise<Response> {
    if (capturingNode) throw busy();
    capturingNode = true;
    try {
      const node = await bridge.beginNodeCapture(nodeId);
      let ended = false;
      try {
        // A reveal can mount views whose sources then load.
        const quiet = await idle(timeoutMs);
        const png = cropNodeCapture(await bridge.capture(), node);
        ended = true;
        if (!await bridge.endNodeCapture()) {
          throw new CoreError(
            "AGENT_CONTROL_VIEW_CHANGED",
            `The view changed while ${nodeId} was captured (the user or another agent switched tabs or scrolled); retry.`,
          );
        }
        return new Response(png, { headers: {
          "content-type": "image/png", "x-dash-bored-node": JSON.stringify(node), ...(quiet ? {} : { "x-dash-bored-idle": "false" }),
        } });
      } finally {
        if (!ended) await bridge.endNodeCapture();
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
        if (request.method === "GET" && pathname === "/v1/processes") {
          return json({ processes: bridge.processes() });
        }
        const logsRoute = /^\/v1\/processes\/([^/]+)\/logs$/.exec(pathname);
        if (request.method === "GET" && logsRoute) {
          const id = decodeURIComponent(logsRoute[1]!);
          const requested = new URL(request.url).searchParams.get("tail");
          if (requested !== null && !/^\d+$/.test(requested)) {
            throw new CoreError("AGENT_CONTROL_BAD_REQUEST", "tail must be a positive integer.");
          }
          const logs = bridge.processLogs(id, clampLogTail(requested === null ? undefined : Number(requested)));
          if (!logs) throw new CoreError("AGENT_CONTROL_NOT_FOUND", `No command process has the id ${id}.`);
          return json({ logs });
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
          if (body.wait !== undefined && typeof body.wait !== "boolean") {
            throw new CoreError("AGENT_CONTROL_BAD_REQUEST", "wait must be true or false.");
          }
          const timeoutMs = idleTimeout(body.timeoutMs);
          let wait: { idle?: boolean; warning?: string } = {};
          if (!await settled()) wait = { warning: NOT_RENDERING };
          else if (body.wait !== false) {
            const quiet = await idle(timeoutMs);
            wait = quiet ? { idle: true } : { idle: false, warning: IDLE_TIMED_OUT(timeoutMs) };
          }
          return json({ result, state: await bridge.viewState(), ...wait }, result.status === "completed" ? 200 : 409);
        }
        if (request.method === "POST" && pathname === "/v1/open") {
          const body = await readBody(request);
          if (typeof body.configPath !== "string" || body.configPath === "") {
            throw new CoreError("AGENT_CONTROL_BAD_REQUEST", "configPath must be a dashboard path.");
          }
          if ((await bridge.viewState()).editing) {
            throw new CoreError("AGENT_CONTROL_DRAFT_OPEN", "The user has unsaved dashboard changes or a save in progress. Ask them to save or cancel the changes, or wait for the save to finish.");
          }
          await bridge.openDashboard(body.configPath);
          const warning = await settled() ? {} : { warning: NOT_RENDERING };
          return json({ state: await bridge.viewState(), ...warning });
        }
        if (request.method === "POST" && pathname === "/v1/read") {
          const body = await readBody(request);
          if (typeof body.nodeId !== "string" || body.nodeId === "") {
            throw new CoreError("AGENT_CONTROL_BAD_REQUEST", "nodeId must be a node id.");
          }
          const timeoutMs = idleTimeout(body.timeoutMs);
          if (!await settled()) throw new CoreError("APP_WINDOW_NOT_RENDERING", NOT_RENDERING);
          return json({ node: await readNode(body.nodeId, timeoutMs) });
        }
        if (request.method === "POST" && pathname === "/v1/screenshot") {
          const body = await readBody(request);
          const timeoutMs = idleTimeout(body.timeoutMs);
          if (body.nodeId !== undefined && (typeof body.nodeId !== "string" || body.nodeId === "")) {
            throw new CoreError("AGENT_CONTROL_BAD_REQUEST", "nodeId must be a node id.");
          }
          if (!await settled()) throw new CoreError("APP_WINDOW_NOT_RENDERING", NOT_RENDERING);
          if (body.nodeId !== undefined) return await captureNode(body.nodeId, timeoutMs);
          const quiet = await idle(timeoutMs);
          const png = await bridge.capture();
          return new Response(png, {
            headers: { "content-type": "image/png", ...(quiet ? {} : { "x-dash-bored-idle": "false" }) },
          });
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
