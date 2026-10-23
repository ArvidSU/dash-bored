import {
  client,
  ndJsonStream,
  RequestError,
  type AgentNotificationMethod,
  type AgentNotificationParamsByMethod,
  type AgentRequestMethod,
  type AgentRequestParamsByMethod,
  type AgentRequestResponsesByMethod,
  type ClientConnection,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import { CoreError } from "../core/diagnostics";
import { signalName } from "../core/process-signal";
import { isSimpleInvocation } from "./agent-preflight";

/** Default grace between closing stdin, SIGTERM, and SIGKILL. */
export const AGENT_SHUTDOWN_GRACE_MS = 1_500;
const MAX_LOG_LINE = 2_000;

export interface AgentProcessExit {
  code: number | null;
  signal: string | null;
}

export interface AcpAgentProcessOptions {
  command: string;
  cwd: string;
  env: Record<string, string>;
  onUpdate(notification: SessionNotification): void;
  /** Answers one `session/request_permission`; `signal` aborts when the agent withdraws it. */
  onPermission(request: RequestPermissionRequest, signal: AbortSignal): Promise<RequestPermissionResponse>;
  /** One stderr line from the agent, already bounded. */
  onLog(line: string): void;
  onExit(exit: AgentProcessExit): void;
  shutdownGraceMs?: number;
}

export interface AcpRequestOptions {
  /** Kill the agent when the request has not been answered in time. */
  timeoutMs?: number;
  /** Stop waiting and send `$/cancel_request`; rejects with `AcpAbortError`. */
  signal?: AbortSignal;
}

/** The agent did not answer a request in time; its process was stopped. */
export class AcpTimeoutError extends Error {
  constructor(readonly method: string, readonly timeoutMs: number) {
    super(`The agent did not answer ${method} within ${formatDuration(timeoutMs)}.`);
    this.name = "AcpTimeoutError";
  }
}

/** The agent process ended while a request was outstanding. */
export class AcpExitError extends Error {
  constructor(readonly method: string, readonly exit: AgentProcessExit) {
    super(`The agent process ${describeExit(exit)} before answering ${method}.`);
    this.name = "AcpExitError";
  }
}

export class AcpAbortError extends Error {
  constructor(readonly method: string) {
    super(`Stopped waiting for ${method}.`);
    this.name = "AcpAbortError";
  }
}

export function formatDuration(ms: number): string {
  return ms >= 1_000 ? `${Math.round(ms / 1_000)} s` : `${ms} ms`;
}

export function describeExit(exit: AgentProcessExit): string {
  return exit.signal ? `stopped after ${exit.signal}` : `exited with code ${String(exit.code)}`;
}

export function isAuthRequired(error: unknown): boolean {
  return error instanceof RequestError && error.code === -32000;
}

/**
 * Spawn arguments. The configured command keeps its literal shell syntax; a
 * plain invocation replaces the shell (`exec`), while assignments, builtins,
 * and compound commands such as `source ~/.nvm/nvm.sh && agent` run as
 * written. Either way the process group is what the app stops.
 */
export function agentSpawnCommand(command: string, platform: NodeJS.Platform = process.platform): string[] {
  if (platform === "win32") return ["cmd.exe", "/d", "/s", "/c", command];
  return ["/bin/sh", "-c", isSimpleInvocation(command) ? `exec ${command}` : command];
}

/**
 * One ACP agent subprocess and its client connection. The SDK has no request
 * timeouts, so every request races the agent's exit and an optional timer;
 * a timer that wins stops the process. The process runs in its own process
 * group so adapters launched through `npx` or a shell stop with it.
 */
export class AcpAgentProcess {
  readonly pid: number;
  /** Resolves once with the process exit; never rejects. */
  readonly exited: Promise<AgentProcessExit>;
  private exitInfo: AgentProcessExit | null = null;
  private readonly subprocess: Bun.Subprocess<"pipe", "pipe", "pipe">;
  private readonly connection: ClientConnection;
  private readonly graceMs: number;
  private terminating: Promise<void> | null = null;
  private readonly endInput: () => void;

  private constructor(options: AcpAgentProcessOptions, subprocess: Bun.Subprocess<"pipe", "pipe", "pipe">) {
    this.subprocess = subprocess;
    this.pid = subprocess.pid;
    this.graceMs = options.shutdownGraceMs ?? AGENT_SHUTDOWN_GRACE_MS;
    this.exited = subprocess.exited.then(
      () => ({ code: subprocess.signalCode === null ? subprocess.exitCode : null, signal: signalName(subprocess.signalCode) }),
      () => ({ code: null, signal: null }),
    ).then((exit) => {
      this.exitInfo = exit;
      options.onExit(exit);
      return exit;
    });
    void drainLines(subprocess.stderr, options.onLog);

    const stdin = subprocess.stdin;
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      try { void stdin.end(); } catch { /* The agent may already be gone. */ }
    };
    // Bun's stdin is a FileSink; ndJsonStream wants a WritableStream.
    const output = new WritableStream<Uint8Array>({
      async write(chunk) {
        stdin.write(chunk);
        await stdin.flush();
      },
      close: end,
      abort: end,
    });
    this.endInput = end;
    const stream = ndJsonStream(output, subprocess.stdout);
    this.connection = client({ name: "dash-bored" })
      .onNotification("session/update", ({ params }) => options.onUpdate(params))
      .onRequest("session/request_permission", ({ params, signal }) => options.onPermission(params, signal))
      .connect(stream);
  }

  /** Spawn the agent. A missing shell or working directory throws synchronously. */
  static spawn(options: AcpAgentProcessOptions): AcpAgentProcess {
    let subprocess: Bun.Subprocess<"pipe", "pipe", "pipe">;
    try {
      subprocess = Bun.spawn({
        cmd: agentSpawnCommand(options.command),
        cwd: options.cwd,
        env: options.env,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        detached: process.platform !== "win32",
      });
    } catch (error) {
      throw new CoreError(
        "AGENT_START_FAILED",
        `The agent could not be started: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return new AcpAgentProcess(options, subprocess);
  }

  get exit(): AgentProcessExit | null {
    return this.exitInfo;
  }

  /** Waits briefly for an exit that is already under way, for error reporting. */
  async settledExit(waitMs = 250): Promise<AgentProcessExit | null> {
    if (this.exitInfo) return this.exitInfo;
    return Promise.race([this.exited, Bun.sleep(waitMs).then(() => null)]);
  }

  request<M extends AgentRequestMethod>(
    method: M,
    params: AgentRequestParamsByMethod[M],
    options: AcpRequestOptions = {},
  ): Promise<AgentRequestResponsesByMethod[M]> {
    const request = this.connection.agent.request(method, params, options.signal ? { cancellationSignal: options.signal } : undefined);
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => finish(() => reject(new AcpAbortError(method)));
      const finish = (settle: () => void) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        settle();
      };
      request.then(
        (value) => finish(() => resolve(value)),
        (error: unknown) => finish(() => reject(error)),
      );
      void this.exited.then((exit) => finish(() => reject(new AcpExitError(method, exit))));
      if (options.timeoutMs !== undefined) {
        timer = setTimeout(() => finish(() => {
          void this.terminate();
          reject(new AcpTimeoutError(method, options.timeoutMs!));
        }), options.timeoutMs);
      }
      if (options.signal) {
        if (options.signal.aborted) onAbort();
        else options.signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  async notify<M extends AgentNotificationMethod>(method: M, params: AgentNotificationParamsByMethod[M]): Promise<void> {
    if (this.exitInfo) return;
    await this.connection.agent.notify(method, params).catch(() => undefined);
  }

  /**
   * Stop the agent: close stdin, give it a grace period, then SIGTERM and
   * finally SIGKILL its process group. Some agents ignore stdin EOF.
   */
  terminate(): Promise<void> {
    this.terminating ??= (async () => {
      this.endInput();
      this.connection.close();
      if (!this.exitInfo && !(await this.exitWithin(this.graceMs))) {
        this.signalGroup("SIGTERM");
        if (!(await this.exitWithin(this.graceMs))) {
          this.signalGroup("SIGKILL");
          await this.exitWithin(this.graceMs);
        }
      }
      // An exited leader may leave adapter children behind in its group.
      this.signalGroup("SIGTERM");
    })();
    return this.terminating;
  }

  private async exitWithin(ms: number): Promise<boolean> {
    if (this.exitInfo) return true;
    return Promise.race([this.exited.then(() => true), Bun.sleep(ms).then(() => false)]);
  }

  private signalGroup(signal: NodeJS.Signals): void {
    if (process.platform === "win32") {
      try { this.subprocess.kill(signal); } catch { /* Already gone. */ }
      return;
    }
    try {
      process.kill(-this.pid, signal);
    } catch {
      if (this.exitInfo) return;
      try { this.subprocess.kill(signal); } catch { /* Already gone. */ }
    }
  }
}

async function drainLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  let pending = "";
  const emit = (line: string) => {
    const text = line.replace(/\r$/, "");
    onLine(text.length > MAX_LOG_LINE ? `${text.slice(0, MAX_LOG_LINE)}…` : text);
  };
  try {
    for await (const chunk of stream) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) emit(line);
      // A runaway line without a newline must not grow without bound.
      if (pending.length > MAX_LOG_LINE * 4) {
        emit(pending);
        pending = "";
      }
    }
  } catch {
    // The stream ends with the process; a read error has nothing more to report.
  }
  pending += decoder.decode();
  if (pending) emit(pending);
}
