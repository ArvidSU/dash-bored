import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, sep } from "node:path";
import {
  PROTOCOL_VERSION,
  RequestError,
  type InitializeResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import { CoreError } from "../core/diagnostics";
import { KNOWN_AGENTS } from "../shared/agent-catalog";
import type {
  AgentAuthMethod,
  AgentConfigChoices,
  AgentConfigOption,
  AgentPermissionRequest,
  AgentSessionTask,
  AgentTaskCommand,
  AgentToolKind,
} from "../shared/agent-session";
import { isAgentTaskBusy } from "../shared/agent-session";
import { APP_VERSION } from "../shared/app-metadata";
import type { ComponentAgentLaunch } from "../shared/contracts";
import {
  AcpAbortError,
  AcpAgentProcess,
  AcpTimeoutError,
  describeExit,
  formatDuration,
  isAuthRequired,
  type AgentProcessExit,
} from "./acp-connection";
import { acpCommandHint, agentDisplay } from "./agent-detection";
import { handoffScript, openHandoffScript, resumeCommand, shellWord, writeHandoffScript } from "./agent-handoff";
import {
  addEntry,
  addNotice,
  applySessionUpdate,
  boundText,
  clip,
  configOptions,
  createTranscriptState,
  MAX_AUTH_METHODS,
  MAX_LABEL_LENGTH,
  MAX_NOTICE_TEXT,
  MAX_PATH_LENGTH,
  MAX_PERMISSION_OPTIONS,
  MAX_TOOL_EDITS,
  MAX_TOOL_LOCATIONS,
  MODE_FALLBACK_ID,
  modeOption,
  pushLog,
  upsertTool,
  type TranscriptState,
} from "./agent-session-updates";

export const MAX_AGENT_PROMPT_LENGTH = 16_384;
export const MAX_AGENT_TASKS = 20;
export const DEFAULT_AGENT_TIMEOUTS = {
  /** First-run adapters (npx downloads, model warm-up) can be slow to answer. */
  initialize: 60_000,
  newSession: 60_000,
  /** Sign-in may wait on a browser; the user can stop waiting earlier. */
  authenticate: 120_000,
  config: 30_000,
  closeSession: 5_000,
};

export interface AgentSessionLaunchOptions {
  purpose?: AgentSessionTask["purpose"];
  template?: string;
  command: string;
  prompt: string;
  projectRoot: string;
  /** The owning bundle directory: the only place an untrusted repair may edit. */
  bundleDirectory: string;
  componentPath: string;
  configPath: string;
  request: string;
  env?: Record<string, string>;
  /**
   * Untrusted repair: reads and commands can receive one-time approval. Edits
   * outside the bundle, fetches, and mode switches are refused automatically;
   * "always allow" is never offered and the agent's mode cannot be changed.
   */
  untrusted?: boolean;
  /**
   * Config option values to set once the session exists, before the first
   * prompt. One the agent does not offer, or refuses, is skipped with a notice.
   */
  config?: AgentConfigChoices;
  /**
   * Runs after every prompt turn ends, and once when the session ends before
   * an outstanding turn (including the first one) could.
   */
  onTurnEnd?: (task: AgentSessionTask) => void | Promise<void>;
}

export interface AgentSessionsOptions {
  onTask?: (task: AgentSessionTask) => void;
  /** A trusted session was created and offered these config options, before any launch choices. */
  onConfigOffered?: (command: string, options: AgentConfigOption[]) => void;
  /** Where hand-off scripts are written; hand-off is unavailable without it. */
  handoffDirectory?: string;
  /** Opens a hand-off script in the user's terminal; injectable so tests never open one. */
  openHandoff?: (scriptPath: string) => Promise<void>;
  platform?: NodeJS.Platform;
  timeouts?: Partial<typeof DEFAULT_AGENT_TIMEOUTS>;
  /** Task emissions are coalesced per task. */
  emitDelayMs?: number;
  maxTasks?: number;
  shutdownGraceMs?: number;
}

interface PendingPermission {
  request: AgentPermissionRequest;
  /** Options the agent offered that the app does not show (`allow_always` in an untrusted repair). */
  withheld: Set<string>;
  resolve(response: RequestPermissionResponse): void;
}

interface SessionRecord {
  task: AgentSessionTask;
  options: AgentSessionLaunchOptions;
  process: AcpAgentProcess;
  transcript: TranscriptState;
  initialize: InitializeResponse | null;
  /** A prompt waiting for a session (the first prompt, or one interrupted by sign-in). */
  pendingPrompt: string | null;
  /** A turn is outstanding: from launch until the first stop, then for each follow-up. */
  turnPending: boolean;
  /** `onTurnEnd` is running; user prompts wait for its validation. */
  hookRunning: boolean;
  permissions: PendingPermission[];
  /** `session/cancel` was sent for the running turn; later permission requests are answered cancelled. */
  cancelRequested: boolean;
  authAbort: AbortController | null;
  closing: boolean;
  /** A hand-off is writing its script; the session takes no more commands. */
  handingOff: boolean;
  emitTimer: ReturnType<typeof setTimeout> | null;
  prompts: number;
}

const CANCELLED: RequestPermissionResponse = { outcome: { outcome: "cancelled" } };
const FILE_TOOL_KINDS = new Set<AgentToolKind>(["read", "edit", "delete", "move"]);
const REFUSED_UNTRUSTED_KINDS = new Set<AgentToolKind>(["fetch", "switch_mode", "other"]);

function taskNotFound(): CoreError {
  return new CoreError("AGENT_TASK_NOT_FOUND", "That agent task is no longer available.");
}

/**
 * Where an absolute `path` leads once every symlink is followed, as the OS
 * would: one component at a time, so `link/..` is the parent of the link's
 * target (Bun's `realpath` folds `..` before following links). Components
 * that do not exist yet are appended as they are. Null when the path cannot
 * be resolved (a loop, a file used as a directory, no access).
 */
export async function resolveRealPath(path: string): Promise<string | null> {
  if (!isAbsolute(path)) return null;
  const { root } = parse(path);
  let current: string;
  try {
    current = await realpath(root);
  } catch {
    return null;
  }
  // Components appended below the deepest existing directory.
  let missing = 0;
  for (const part of path.slice(root.length).split(sep === "\\" ? /[\\/]/ : "/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      current = dirname(current);
      if (missing > 0) missing -= 1;
      continue;
    }
    if (missing > 0) {
      current = join(current, part);
      missing += 1;
      continue;
    }
    try {
      // `current` is fully resolved, so this resolves exactly one more component.
      current = await realpath(join(current, part));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
      current = join(current, part);
      missing = 1;
    }
  }
  return current;
}

/** Whether `path` (absolute, or relative to `base`) resolves inside `directory`, following symlinks. */
export async function pathWithin(directory: string, path: string, base: string): Promise<boolean> {
  const [root, target] = await Promise.all([
    realpath(directory).catch(() => null),
    // Joined without normalizing, so `link/..` is resolved through the link as the OS would.
    resolveRealPath(isAbsolute(path) ? path : `${base}${sep}${path}`),
  ]);
  if (root === null || target === null) return false;
  const relation = relative(root, target);
  return relation === "" || (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}

function signInMethods(initialize: InitializeResponse | null): AgentAuthMethod[] {
  // Terminal sign-in needs the `auth.terminal` client capability, which the app does not offer.
  return (initialize?.authMethods ?? [])
    .filter((method) => !("type" in method) || method.type === undefined || (method.type as string) === "agent")
    .slice(0, MAX_AUTH_METHODS)
    .map((method) => ({
      id: method.id,
      name: clip(method.name, MAX_LABEL_LENGTH),
      ...(method.description ? { description: clip(method.description, MAX_LABEL_LENGTH) } : {}),
    }));
}

function checkPrompt(text: string): string {
  const prompt = text.trim();
  if (prompt.length === 0 || prompt.length > MAX_AGENT_PROMPT_LENGTH) {
    throw new CoreError(
      "COMPONENT_AGENT_PROMPT_INVALID",
      `The request must be between 1 and ${MAX_AGENT_PROMPT_LENGTH} characters after context is added.`,
    );
  }
  return prompt;
}

/**
 * The app's Agent Client Protocol sessions: one agent process and one ACP
 * session per task. Sessions stay open for follow-ups until the user closes
 * or hands off the task, project trust is revoked, or the app quits. The
 * renderer sees a bounded projection (`AgentSessionTask`), emitted at most
 * once per `emitDelayMs` per task.
 */
export class AgentSessions {
  private readonly records = new Map<string, SessionRecord>();
  private readonly timeouts: typeof DEFAULT_AGENT_TIMEOUTS;
  private closed = false;

  constructor(private readonly options: AgentSessionsOptions = {}) {
    this.timeouts = { ...DEFAULT_AGENT_TIMEOUTS, ...options.timeouts };
  }

  list(): AgentSessionTask[] {
    return [...this.records.values()]
      .sort((left, right) => right.task.startedAt.localeCompare(left.task.startedAt))
      .map((record) => this.snapshot(record));
  }

  get(id: string): AgentSessionTask {
    return this.snapshot(this.require(id));
  }

  async launch(options: AgentSessionLaunchOptions): Promise<ComponentAgentLaunch> {
    if (this.closed) throw new CoreError("AGENT_SESSIONS_CLOSED", "The app is shutting down its agent sessions.");
    const prompt = checkPrompt(options.prompt);
    const id = `agent-${randomUUID()}`;
    const task: AgentSessionTask = {
      id,
      ...(options.purpose ? { purpose: options.purpose } : {}),
      ...(options.template ? { template: options.template } : {}),
      agent: { command: options.command, ...agentDisplay(options.command) },
      prompt,
      componentPath: options.componentPath,
      request: options.request,
      configPath: options.configPath,
      startedAt: new Date().toISOString(),
      state: "starting",
      sessionId: null,
      pid: null,
      entries: [],
      truncated: 0,
      plan: null,
      permission: null,
      configOptions: [],
      turns: 0,
      handoff: null,
      dashboardChanged: false,
      ...(options.untrusted ? { untrusted: true } : {}),
      log: [],
    };
    // Callbacks only run after spawn returns, once `record` is assigned.
    let record!: SessionRecord;
    const agentProcess = AcpAgentProcess.spawn({
      command: options.command,
      cwd: options.projectRoot,
      env: {
        ...(options.env ?? {}),
        DASH_BORED_AGENT: options.command,
        DASH_BORED_COMPONENT_PATH: options.componentPath,
        // Keep shell startup hooks from replacing the PATH preflight verified.
        ...(process.platform === "win32" ? {} : { ENV: "/dev/null", BASH_ENV: "/dev/null" }),
      },
      shutdownGraceMs: this.options.shutdownGraceMs,
      onUpdate: (notification) => this.onUpdate(record, notification),
      onPermission: (request, signal) => this.onPermission(record, request, signal),
      onLog: (line) => {
        pushLog(record.task, line);
        this.schedule(record);
      },
      onExit: (exit) => this.onExit(record, exit),
    });
    task.pid = agentProcess.pid;
    record = {
      task,
      options,
      process: agentProcess,
      transcript: createTranscriptState(),
      initialize: null,
      pendingPrompt: prompt,
      turnPending: true,
      hookRunning: false,
      permissions: [],
      cancelRequested: false,
      authAbort: null,
      closing: false,
      handingOff: false,
      emitTimer: null,
      prompts: 0,
    };
    this.records.set(id, record);
    this.prune();
    void this.start(record);
    // A mutation pushes what it changed before it resolves (see rpc.ts).
    this.emitNow(record);
    return { taskId: id, command: options.command, componentPath: options.componentPath, pid: agentProcess.pid };
  }

  /**
   * Run one renderer command against a task and answer with the task
   * afterwards. The task's pending emission is flushed first, so the push
   * precedes the answer as rpc.ts promises: a double click on a permission
   * card cannot answer the next queued request before the renderer has seen it.
   * Streaming updates stay coalesced.
   */
  async command(id: string, command: AgentTaskCommand): Promise<AgentSessionTask> {
    try {
      return await this.run(id, command);
    } finally {
      const record = this.records.get(id);
      if (record?.emitTimer) this.emitNow(record);
    }
  }

  private async run(id: string, command: AgentTaskCommand): Promise<AgentSessionTask> {
    switch (command.type) {
      case "prompt": return this.prompt(id, command.text);
      case "cancel": return this.cancel(id);
      case "permission": return this.answerPermission(id, command.requestId, command.optionId);
      case "config": return this.setConfig(id, command.configId, command.value);
      case "authenticate": return this.authenticate(id, command.methodId);
      case "handoff": return this.handoff(id);
      case "close": return this.close(id);
    }
  }

  /** A user's follow-up prompt; accepted only while the session is idle and validation is settled. */
  prompt(id: string, text: string): AgentSessionTask {
    const record = this.require(id);
    const prompt = checkPrompt(text);
    this.assertIdle(record);
    if (record.hookRunning || record.task.validation?.status === "checking") {
      throw new CoreError("AGENT_SESSION_BUSY", "dash-bored is still checking the dashboard after the last turn. Try again in a moment.");
    }
    void this.runTurn(record, prompt);
    return this.snapshot(record);
  }

  /** A host follow-up in the same session, such as the single automatic repair. */
  followUp(id: string, text: string): void {
    const record = this.require(id);
    const prompt = checkPrompt(text);
    this.assertIdle(record);
    void this.runTurn(record, prompt);
  }

  /** Cancel the running turn; the session stays open. Before a session exists, stop the task. */
  async cancel(id: string): Promise<AgentSessionTask> {
    const record = this.require(id);
    const { task } = record;
    if (record.authAbort) {
      record.authAbort.abort();
      return this.snapshot(record);
    }
    if (task.state === "starting" || task.state === "auth-required") return this.close(id);
    if ((task.state === "working" || task.state === "waiting") && task.sessionId) {
      record.cancelRequested = true;
      await record.process.notify("session/cancel", { sessionId: task.sessionId });
      this.cancelPermissions(record);
    }
    return this.snapshot(record);
  }

  answerPermission(id: string, requestId: string, optionId: string | null): AgentSessionTask {
    const record = this.require(id);
    const index = record.permissions.findIndex((pending) => pending.request.id === requestId);
    const pending = record.permissions[index];
    if (!pending) throw new CoreError("AGENT_PERMISSION_STALE", "That permission request was already answered or withdrawn.");
    if (optionId !== null && pending.withheld.has(optionId)) {
      throw new CoreError("AGENT_PERMISSION_INVALID", "This project is not trusted, so the repair cannot always allow a tool. Allow it once instead.");
    }
    if (optionId !== null && !pending.request.options.some((option) => option.optionId === optionId)) {
      throw new CoreError("AGENT_PERMISSION_INVALID", "That answer is not one of the request's options.");
    }
    record.permissions.splice(index, 1);
    pending.resolve(optionId === null ? CANCELLED : { outcome: { outcome: "selected", optionId } });
    this.syncPermission(record);
    return this.snapshot(record);
  }

  async setConfig(id: string, configId: string, value: string | boolean): Promise<AgentSessionTask> {
    const record = this.require(id);
    const { task } = record;
    if (!task.sessionId || task.state === "closed" || task.state === "failed" || task.state === "starting") {
      throw new CoreError("AGENT_SESSION_UNAVAILABLE", "The agent session is not open.");
    }
    if (record.handingOff) throw new CoreError("AGENT_SESSION_BUSY", "This session is being handed off.");
    const option = this.configOption(record, configId, value);
    try {
      await this.sendConfig(record, option, value);
    } catch (error) {
      if (error instanceof RequestError) {
        throw new CoreError("AGENT_CONFIG_FAILED", clip(`The agent refused the change: ${error.message}`, MAX_NOTICE_TEXT));
      }
      const message = await this.requestFailure(record, "session/set_config_option", error);
      this.fail(record, message);
      throw new CoreError("AGENT_CONFIG_FAILED", message);
    }
    this.schedule(record);
    return this.snapshot(record);
  }

  /** The offered option `value` may be set on, or why it may not. */
  private configOption(record: SessionRecord, configId: string, value: string | boolean): AgentConfigOption {
    const option = record.task.configOptions.find((candidate) => candidate.id === configId);
    if (!option) throw new CoreError("AGENT_CONFIG_UNKNOWN", "The agent does not offer that option.");
    if (record.task.untrusted && option.category === "mode") {
      // A mode can let the agent act without asking, which would bypass the repair's permission policy.
      throw new CoreError("AGENT_CONFIG_REFUSED", "This project is not trusted, so the repair cannot change the agent's mode.");
    }
    if (option.type === "boolean" ? typeof value !== "boolean"
      : typeof value !== "string" || !option.options?.some((choice) => choice.value === value)) {
      throw new CoreError("AGENT_CONFIG_INVALID", `That value is not one of the choices for ${option.name}.`);
    }
    return option;
  }

  private async sendConfig(record: SessionRecord, option: AgentConfigOption, value: string | boolean): Promise<void> {
    const { task } = record;
    const sessionId = task.sessionId!;
    if (record.transcript.modeFallback && option.id === MODE_FALLBACK_ID) {
      await record.process.request("session/set_mode", { sessionId, modeId: value as string }, { timeoutMs: this.timeouts.config });
      option.currentValue = value;
      return;
    }
    const response = await record.process.request("session/set_config_option", typeof value === "boolean"
      ? { sessionId, configId: option.id, type: "boolean", value }
      : { sessionId, configId: option.id, value }, { timeoutMs: this.timeouts.config });
    record.transcript.modeFallback = false;
    task.configOptions = configOptions(response.configOptions);
  }

  /**
   * Set the launch's config choices before the first prompt, in the order the
   * agent lists its options (a model change can change the effort choices).
   * A choice the agent no longer offers or refuses is skipped with a notice;
   * a failed connection fails the task. False when the session ended.
   */
  private async applyLaunchConfig(record: SessionRecord): Promise<boolean> {
    const { task } = record;
    const choices = record.options.config ?? {};
    const position = (id: string) => {
      const index = task.configOptions.findIndex((option) => option.id === id);
      return index < 0 ? task.configOptions.length : index;
    };
    for (const configId of Object.keys(choices).sort((left, right) => position(left) - position(right))) {
      const value = choices[configId]!;
      const offered = task.configOptions.find((option) => option.id === configId);
      if (offered?.currentValue === value) continue;
      try {
        await this.sendConfig(record, this.configOption(record, configId, value), value);
      } catch (error) {
        if (record.closing || this.ended(record)) return false;
        if (error instanceof CoreError || error instanceof RequestError) {
          addNotice(task, record.transcript, "warning", `${offered?.name ?? configId} was left at the agent's default: ${error.message}`);
          continue;
        }
        this.fail(record, await this.requestFailure(record, "session/set_config_option", error));
        return false;
      }
      if (record.closing || this.ended(record)) return false;
    }
    return true;
  }

  /** Start an agent-handled sign-in, then create the session (or resend the interrupted prompt). */
  authenticate(id: string, methodId: string): AgentSessionTask {
    const record = this.require(id);
    const { task } = record;
    if (task.state !== "auth-required") {
      throw new CoreError("AGENT_SESSION_NOT_SIGNING_IN", "The agent is not waiting for sign-in.");
    }
    if (!task.auth?.some((method) => method.id === methodId)) {
      throw new CoreError("AGENT_AUTH_METHOD_UNKNOWN", "The agent does not offer that sign-in method.");
    }
    const abort = new AbortController();
    record.authAbort = abort;
    task.state = "starting";
    this.schedule(record);
    void (async () => {
      try {
        await record.process.request("authenticate", { methodId }, { timeoutMs: this.timeouts.authenticate, signal: abort.signal });
      } catch (error) {
        record.authAbort = null;
        if (record.closing) return;
        if (error instanceof AcpAbortError || error instanceof RequestError) {
          task.state = "auth-required";
          addNotice(task, record.transcript, error instanceof AcpAbortError ? "info" : "error",
            error instanceof AcpAbortError ? "Stopped waiting for sign-in." : `Sign-in failed: ${error.message}`);
          this.schedule(record);
          return;
        }
        this.fail(record, await this.requestFailure(record, "authenticate", error));
        return;
      }
      record.authAbort = null;
      if (record.closing) return;
      delete task.auth;
      if (task.sessionId) {
        task.state = "idle";
        const pending = record.pendingPrompt;
        record.pendingPrompt = null;
        if (pending !== null) void this.runTurn(record, pending, { resend: true });
        else this.schedule(record);
      } else {
        await this.openSession(record);
      }
    })();
    return this.snapshot(record);
  }

  /**
   * Resume the session in the agent's own app. The app closes its side first
   * so two clients never drive one session, then opens a script in the
   * user's default terminal app.
   */
  async handoff(id: string): Promise<AgentSessionTask> {
    const record = this.require(id);
    const { task } = record;
    if (record.handingOff) throw new CoreError("AGENT_HANDOFF_BUSY", "This session is already being handed off.");
    const resume = this.snapshot(record).handoff;
    if (!resume) {
      throw new CoreError("AGENT_HANDOFF_UNAVAILABLE", task.turns < 1
        ? "Hand-off is available once the agent has finished its first turn."
        : "This agent does not define a way to resume the session in its own app.");
    }
    if (task.state !== "idle" || record.hookRunning || task.validation?.status === "checking" || task.validation?.status === "repairing") {
      throw new CoreError("AGENT_HANDOFF_BUSY", "Wait until the agent is idle before handing the session off.");
    }
    if ((this.options.platform ?? process.platform) !== "darwin") {
      throw new CoreError("AGENT_HANDOFF_UNSUPPORTED", `Opening a terminal for hand-off is supported on macOS only. Run this instead: ${resume.command}`);
    }
    if (!this.options.handoffDirectory) throw new CoreError("AGENT_HANDOFF_UNAVAILABLE", "Hand-off is not available in this build.");
    const known = KNOWN_AGENTS.find((agent) => agent.id === task.agent.knownId);
    const command = resumeCommand(known, task.sessionId, record.options.projectRoot)!;
    // Claimed before the first await, so a second hand-off or a prompt cannot slip in.
    record.handingOff = true;
    let script: string;
    try {
      script = await writeHandoffScript(this.options.handoffDirectory, task.id, handoffScript(record.options.projectRoot, command));
    } catch (error) {
      record.handingOff = false;
      throw error;
    }
    await this.endSession(record, { handedOff: true });
    await (this.options.openHandoff ?? openHandoffScript)(script);
    return this.snapshot(record);
  }

  /**
   * End the session and stop the agent process. `cancelled: false` is for
   * the app closing a session whose work is done, such as a finished migration.
   */
  async close(id: string, options: { cancelled?: boolean } = {}): Promise<AgentSessionTask> {
    const record = this.require(id);
    await this.endSession(record, { cancelled: options.cancelled ?? true });
    return this.snapshot(record);
  }

  /**
   * Project trust was revoked or the project was removed: close every session
   * that works in that project, or only those for `configPath`.
   */
  async stopProject(projectRoot: string, configPath?: string): Promise<void> {
    await Promise.all([...this.records.values()]
      .filter((record) => record.options.projectRoot === projectRoot && !record.closing
        && (configPath === undefined || record.task.configPath === configPath))
      .map((record) => this.endSession(record, { cancelled: true })));
  }

  markDashboardChanged(configPath: string): void {
    for (const record of this.records.values()) {
      const { task } = record;
      if (task.configPath !== configPath || (task.state !== "working" && task.state !== "waiting")) continue;
      task.dashboardChanged = true;
      this.schedule(record);
    }
  }

  setValidation(id: string, validation: AgentSessionTask["validation"]): void {
    const record = this.records.get(id);
    if (!record) return;
    record.task.validation = validation;
    this.schedule(record);
  }

  isCancelled(id: string): boolean {
    return this.closed || this.records.get(id)?.task.cancelled === true;
  }

  /** App quit: close every session and publish the final state. */
  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.all([...this.records.values()].map((record) => this.endSession(record, { cancelled: true })));
    for (const record of this.records.values()) this.emitNow(record);
  }

  /** Read through a call so TypeScript does not keep a state narrowed across awaits. */
  private ended(record: SessionRecord): boolean {
    return record.task.state === "failed" || record.task.state === "closed";
  }

  private require(id: string): SessionRecord {
    const record = this.records.get(id);
    if (!record) throw taskNotFound();
    return record;
  }

  private assertIdle(record: SessionRecord): void {
    if (this.ended(record)) throw new CoreError("AGENT_SESSION_BUSY", "This agent session has ended. Start a new request instead.");
    if (record.handingOff) throw new CoreError("AGENT_SESSION_BUSY", "This session is being handed off.");
    if (record.task.state !== "idle") {
      throw new CoreError("AGENT_SESSION_BUSY", "The agent is still working. Wait for the turn to finish, or stop it first.");
    }
  }

  private async start(record: SessionRecord): Promise<void> {
    let initialize: InitializeResponse;
    try {
      initialize = await record.process.request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
          auth: { terminal: false },
          // `plan` (plan_update/plan_removed) is not advertised: agents may then send
          // markdown or file plans, which the app does not show.
          session: { configOptions: { boolean: {} }, notices: {} },
        },
        clientInfo: { name: "dash-bored", title: "dash-bored", version: APP_VERSION },
      }, { timeoutMs: this.timeouts.initialize });
    } catch (error) {
      if (!record.closing) this.fail(record, await this.handshakeFailure(record, error));
      return;
    }
    if (record.closing) return;
    if (initialize.protocolVersion !== PROTOCOL_VERSION) {
      this.fail(record, `The agent speaks ACP protocol version ${initialize.protocolVersion}; this app speaks version ${PROTOCOL_VERSION}.`);
      return;
    }
    record.initialize = initialize;
    await this.openSession(record);
  }

  private async openSession(record: SessionRecord): Promise<void> {
    const { task } = record;
    let session;
    try {
      session = await record.process.request("session/new", { cwd: record.options.projectRoot, mcpServers: [] }, { timeoutMs: this.timeouts.newSession });
    } catch (error) {
      if (record.closing) return;
      if (isAuthRequired(error)) {
        this.requireSignIn(record);
        return;
      }
      this.fail(record, await this.requestFailure(record, "session/new", error));
      return;
    }
    if (record.closing) return;
    task.sessionId = session.sessionId;
    if (session.configOptions && session.configOptions.length > 0) {
      task.configOptions = configOptions(session.configOptions);
    } else if (session.modes && session.modes.availableModes.length > 0) {
      record.transcript.modeFallback = true;
      task.configOptions = [modeOption(session.modes)];
    }
    // An untrusted project's agent configuration does not shape what the app remembers.
    if (task.configOptions.length > 0 && !task.untrusted) this.options.onConfigOffered?.(task.agent.command, structuredClone(task.configOptions));
    if (record.options.config && !(await this.applyLaunchConfig(record))) return;
    task.state = "idle";
    const pending = record.pendingPrompt;
    record.pendingPrompt = null;
    if (pending !== null) void this.runTurn(record, pending, { resend: false });
    else this.schedule(record);
  }

  private requireSignIn(record: SessionRecord): void {
    const { task } = record;
    const methods = signInMethods(record.initialize);
    if (methods.length === 0) {
      this.fail(record, "The agent requires sign-in but offers no sign-in method this app can start. Sign in with the agent's own CLI, then try again.");
      return;
    }
    task.state = "auth-required";
    task.auth = methods;
    this.schedule(record);
  }

  private async runTurn(record: SessionRecord, text: string, options: { resend?: boolean } = {}): Promise<void> {
    const { task } = record;
    record.turnPending = true;
    record.cancelRequested = false;
    task.state = "working";
    delete task.stopReason;
    record.transcript.run = null;
    if (!options.resend) {
      record.prompts += 1;
      // The first prompt is the launch briefing, shown whole in the Prompt tab.
      if (record.prompts > 1) addEntry(task, { kind: "user", id: `prompt-${record.prompts}`, text: boundText(text) });
    }
    this.schedule(record);
    try {
      const response = await record.process.request("session/prompt", { sessionId: task.sessionId!, prompt: [{ type: "text", text }] });
      this.cancelPermissions(record);
      task.turns += 1;
      task.stopReason = response.stopReason;
      if (!record.closing && !this.ended(record)) task.state = "idle";
    } catch (error) {
      this.cancelPermissions(record);
      if (record.closing || this.ended(record)) {
        // close() or a failure already reported the session's end.
      } else if (isAuthRequired(error)) {
        record.pendingPrompt = text;
        this.requireSignIn(record);
        return;
      } else if (error instanceof RequestError && record.process.exit === null) {
        // The agent rejected this turn but its session lives on for another try.
        task.state = "idle";
        addNotice(task, record.transcript, "error", `The agent could not complete this turn: ${error.message}`);
      } else {
        this.fail(record, await this.requestFailure(record, "session/prompt", error));
      }
    }
    this.endTurn(record);
  }

  /** Close the outstanding turn exactly once and let the owner validate it. */
  private endTurn(record: SessionRecord): void {
    if (!record.turnPending) return;
    record.turnPending = false;
    this.schedule(record);
    const hook = record.options.onTurnEnd;
    if (!hook || this.closed) return;
    record.hookRunning = true;
    void Promise.resolve()
      .then(() => hook(this.snapshot(record)))
      .catch((error: unknown) => {
        this.setValidation(record.task.id, {
          status: "failed",
          diagnostics: [{ severity: "error", code: "DASHBOARD_AGENT_FINISH_FAILED", message: error instanceof Error ? error.message : String(error) }],
        });
      })
      .finally(() => {
        record.hookRunning = false;
        this.schedule(record);
      });
  }

  private fail(record: SessionRecord, message: string): void {
    const { task } = record;
    if (task.state === "failed" || task.state === "closed") return;
    task.state = "failed";
    task.error = clip(message, MAX_NOTICE_TEXT);
    this.cancelPermissions(record);
    void record.process.terminate();
    this.schedule(record);
    this.endTurn(record);
    this.prune();
  }

  private async endSession(record: SessionRecord, flags: { cancelled?: boolean; handedOff?: boolean }): Promise<void> {
    const { task } = record;
    if (record.closing) {
      await record.process.terminate();
      return;
    }
    record.closing = true;
    const active = task.state !== "closed" && task.state !== "failed";
    if (active && flags.cancelled) task.cancelled = true;
    if (flags.handedOff) task.handedOff = true;
    record.authAbort?.abort();
    const sessionId = task.sessionId;
    if (sessionId && (task.state === "working" || task.state === "waiting")) {
      await record.process.notify("session/cancel", { sessionId });
    }
    this.cancelPermissions(record);
    if (active) task.state = "closed";
    this.schedule(record);
    if (sessionId && active && record.initialize?.agentCapabilities?.sessionCapabilities?.close && record.process.exit === null) {
      await record.process.request("session/close", { sessionId }, { timeoutMs: this.timeouts.closeSession }).catch(() => undefined);
    }
    await record.process.terminate();
    this.endTurn(record);
    this.schedule(record);
    this.prune();
  }

  private onUpdate(record: SessionRecord, notification: SessionNotification): void {
    if (record.closing) return;
    applySessionUpdate(record.task, record.transcript, notification.update);
    this.schedule(record);
  }

  private onExit(record: SessionRecord, exit: AgentProcessExit): void {
    this.schedule(record);
    // A pending request reports its own failure; only a quiet session ends here.
    if (!record.closing && (record.task.state === "idle" || record.task.state === "auth-required")) {
      this.fail(record, `The agent process ${describeExit(exit)}.`);
    }
  }

  /** The turn can no longer take a permission answer: it ended, or the user asked to cancel it. */
  private permissionClosed(record: SessionRecord): boolean {
    return record.closing || record.cancelRequested || !record.turnPending || this.ended(record);
  }

  private onPermission(record: SessionRecord, request: RequestPermissionRequest, signal: AbortSignal): Promise<RequestPermissionResponse> {
    const { task } = record;
    if (this.permissionClosed(record)) return Promise.resolve(CANCELLED);
    record.transcript.run = null;
    const tool = upsertTool(task, request.toolCall);
    const offered = request.options.slice(0, MAX_PERMISSION_OPTIONS);
    const withheld = new Set(task.untrusted ? offered.filter((option) => option.kind === "allow_always").map((option) => option.optionId) : []);
    const permission: AgentPermissionRequest = {
      id: `permission-${randomUUID()}`,
      toolCallId: request.toolCall.toolCallId,
      title: boundText(request.toolCall.title || tool.title, 2_000),
      toolKind: tool.toolKind,
      locations: tool.locations.map((location) => ({ ...location })),
      options: offered
        .filter((option) => !withheld.has(option.optionId))
        .map((option) => ({ optionId: option.optionId, name: clip(option.name, MAX_LABEL_LENGTH), kind: option.kind })),
    };
    if (!task.untrusted) return this.queuePermission(record, permission, withheld, signal);
    return this.untrustedRefusal(record, permission, tool.edits.map((edit) => edit.path)).then((refusal) => {
      if (refusal) {
        this.schedule(record);
        return refusal;
      }
      if (this.permissionClosed(record)) return CANCELLED;
      return this.queuePermission(record, permission, withheld, signal);
    });
  }

  private queuePermission(record: SessionRecord, permission: AgentPermissionRequest, withheld: Set<string>, signal: AbortSignal): Promise<RequestPermissionResponse> {
    if (signal.aborted) return Promise.resolve(CANCELLED);
    return new Promise((resolvePermission) => {
      const pending: PendingPermission = { request: permission, withheld, resolve: resolvePermission };
      record.permissions.push(pending);
      this.syncPermission(record);
      signal.addEventListener("abort", () => {
        const index = record.permissions.indexOf(pending);
        if (index < 0) return;
        record.permissions.splice(index, 1);
        resolvePermission(CANCELLED);
        this.syncPermission(record);
      }, { once: true });
    });
  }

  /**
   * The untrusted repair policy. It narrows what the agent may do through
   * permission requests; it is not a sandbox: an agent that does not ask
   * before acting is not stopped by it.
   */
  private async untrustedRefusal(record: SessionRecord, permission: AgentPermissionRequest, editedPaths: string[]): Promise<RequestPermissionResponse | null> {
    const kind = permission.toolKind ?? "other";
    const paths = [...permission.locations.map((location) => location.path), ...editedPaths];
    let reason: string | null = null;
    if (REFUSED_UNTRUSTED_KINDS.has(kind)) {
      reason = kind === "switch_mode" ? "mode switches are not allowed" : `${kind === "other" ? "unclassified" : kind} tools are not allowed`;
    } else if (paths.length === 0 && FILE_TOOL_KINDS.has(kind)) {
      reason = "the request names no file to check against the dashboard bundle";
    } else if (permission.locations.length >= MAX_TOOL_LOCATIONS || editedPaths.length >= MAX_TOOL_EDITS
      || paths.some((path) => path.length >= MAX_PATH_LENGTH)) {
      // Bounded lists and paths may have been cut, so the whole request cannot be checked.
      reason = "the request names more files, or longer paths, than the app can check";
    } else {
      // Read and command locations describe context, not declared file edits.
      const edits = kind === "execute" || kind === "read" ? editedPaths : paths;
      for (const path of edits) {
        if (!(await pathWithin(record.options.bundleDirectory, path, record.options.projectRoot))) {
          reason = `${path} is outside the dashboard bundle`;
          break;
        }
      }
    }
    if (reason === null) return null;
    const option = permission.options.find((candidate) => candidate.kind === "reject_once")
      ?? permission.options.find((candidate) => candidate.kind === "reject_always");
    addNotice(record.task, record.transcript, "warning",
      `Refused “${permission.title}” automatically: ${reason}. This project is not trusted, so the repair may only edit files inside its dashboard bundle; reads and commands need one-time approval.`);
    return option ? { outcome: { outcome: "selected", optionId: option.optionId } } : CANCELLED;
  }

  private syncPermission(record: SessionRecord): void {
    const { task } = record;
    task.permission = record.permissions[0]?.request ?? null;
    if (task.state === "working" || task.state === "waiting") task.state = record.permissions.length > 0 ? "waiting" : "working";
    this.schedule(record);
  }

  private cancelPermissions(record: SessionRecord): void {
    if (record.permissions.length === 0) return;
    for (const pending of record.permissions.splice(0)) pending.resolve(CANCELLED);
    this.syncPermission(record);
  }

  private async handshakeFailure(record: SessionRecord, error: unknown): Promise<string> {
    let reason: string;
    if (error instanceof AcpTimeoutError) {
      reason = `It did not answer the ACP handshake within ${formatDuration(error.timeoutMs)} and was stopped.`;
    } else {
      const exit = await record.process.settledExit();
      reason = exit
        ? `It ${describeExit(exit)} before answering the ACP handshake.`
        : `The handshake failed: ${error instanceof Error ? error.message : String(error)}.`;
    }
    const hint = acpCommandHint(record.task.agent.command);
    return `This command did not answer as an ACP agent. ${reason}${hint ? ` ${hint}` : ""}`;
  }

  private async requestFailure(record: SessionRecord, method: string, error: unknown): Promise<string> {
    if (error instanceof AcpTimeoutError) return `${error.message} The agent was stopped.`;
    if (error instanceof RequestError) return clip(`The agent refused ${method}: ${error.message}`, MAX_NOTICE_TEXT);
    const exit = await record.process.settledExit();
    if (exit) return `The agent process ${describeExit(exit)}.`;
    return clip(`The agent connection failed during ${method}: ${error instanceof Error ? error.message : String(error)}`, MAX_NOTICE_TEXT);
  }

  /**
   * Keep at most MAX_AGENT_TASKS. Ended tasks go first, oldest first; then
   * quiet sessions are closed and go once closed. Busy work is never pruned,
   * and every pruned task publishes its final snapshot before it goes.
   */
  private prune(): void {
    const records = [...this.records.values()].sort((left, right) => left.task.startedAt.localeCompare(right.task.startedAt));
    const quiet = (record: SessionRecord) => !record.hookRunning && !record.handingOff && !isAgentTaskBusy(record.task);
    let excess = records.length - (this.options.maxTasks ?? MAX_AGENT_TASKS);
    for (const record of records) {
      if (excess <= 0) return;
      if (this.ended(record) && quiet(record)) {
        this.emitNow(record);
        this.records.delete(record.task.id);
        excess -= 1;
      }
    }
    // Sessions already closing leave through the prune that ends their close.
    excess -= records.filter((record) => record.closing && this.records.has(record.task.id)).length;
    for (const record of records) {
      if (excess <= 0) return;
      if (!record.closing && quiet(record)) {
        excess -= 1;
        void this.endSession(record, { cancelled: true });
      }
    }
  }

  private snapshot(record: SessionRecord): AgentSessionTask {
    const { task } = record;
    const known = KNOWN_AGENTS.find((agent) => agent.id === task.agent.knownId);
    const resume = task.turns >= 1 ? resumeCommand(known, task.sessionId, record.options.projectRoot) : null;
    // The copyable command runs from the project root, as the hand-off script does.
    task.handoff = resume && known ? { command: `cd ${shellWord(record.options.projectRoot)} && ${resume}`, app: known.name } : null;
    return structuredClone(task);
  }

  private schedule(record: SessionRecord): void {
    if (!this.options.onTask || record.emitTimer) return;
    record.emitTimer = setTimeout(() => {
      record.emitTimer = null;
      this.emitNow(record);
    }, this.options.emitDelayMs ?? 50);
  }

  private emitNow(record: SessionRecord): void {
    if (record.emitTimer) clearTimeout(record.emitTimer);
    record.emitTimer = null;
    if (!this.options.onTask || this.records.get(record.task.id) !== record) return;
    this.options.onTask(this.snapshot(record));
  }
}
