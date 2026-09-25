import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { ProcessLogEntry, ProcessRunSnapshot, ProcessSnapshot } from "../shared/contracts";
import { CoreError, errorMessage } from "./diagnostics";
import { resolveContainedPath } from "./paths";
import { resolveEnvironment, type PublishedEnvironment } from "./environment";

const DEFAULT_MAX_LOG_BYTES = 512 * 1024;
const DEFAULT_MAX_LOG_ENTRIES = 2_000;
const DEFAULT_STOP_GRACE_MS = 2_000;
const DEFAULT_TERMINAL_COLS = 100;
const DEFAULT_TERMINAL_ROWS = 24;
const MAX_COMMAND_HEADER_LENGTH = 200;
/** Upper bound for trailing PTY output after a session's process exits (a background job may hold it open). */
const PTY_DRAIN_MS = 250;
const ITEM_ENV_NAME = /^DASH_ITEM_[A-Z][A-Z0-9_]*$/;

function validateItemEnvironment(value: Record<string, string> | undefined): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CoreError("PROCESS_ITEM_ENV_INVALID", "Item environment must be a string map.");
  }
  const entries = Object.entries(value);
  if (entries.length > 32 || entries.some(([key, entry]) =>
    !ITEM_ENV_NAME.test(key) || typeof entry !== "string" || entry.length > 2048 || entry.includes("\0"))) {
    throw new CoreError("PROCESS_ITEM_ENV_INVALID", "Item environment accepts at most 32 DASH_ITEM_* string values of up to 2048 characters.");
  }
  return Object.fromEntries(entries);
}

export interface ProcessDefinition {
  id: string;
  command: string;
  interactive?: boolean;
  /**
   * Optional fixed terminal shell for host-owned interactive processes. The
   * resting shell runs it as given; each run appends `-c <command>`.
   */
  interactiveShell?: string[];
  /** Interactive only: end the terminal with its run instead of continuing in a resting shell. */
  closeAfterRun?: boolean;
  projectRoot?: string;
  /** Owning bundle, independent of the command's working directory. */
  configPath?: string;
  cwd?: string;
  env?: Record<string, string>;
}

export interface ProcessManagerOptions {
  projectRoot: string;
  onProcess?: (snapshot: ProcessSnapshot) => void;
  maxLogBytes?: number;
  maxLogEntries?: number;
  stopGraceMs?: number;
  getPublishedEnvironment?: PublishedEnvironment;
}

/**
 * One PTY-backed program inside an interactive terminal: either a single run
 * of the configured command, or the resting interactive shell that follows it.
 */
interface TerminalSession {
  kind: "run" | "shell";
  subprocess: Bun.Subprocess;
  terminal: Bun.Terminal;
  decoder: TextDecoder;
  /** Set when the manager ends this resting shell so a new run can take over the terminal. */
  replacing: boolean;
  /** The user has typed into this session, so a resting shell may be running their command. */
  inputWritten: boolean;
  /** Resolves when the PTY reports end of output. */
  eof: Promise<void>;
  completion: Promise<void>;
}

interface RunState {
  phase: ProcessRunSnapshot["phase"];
  exitCode: number | null;
  signal: string | null;
  startedAt: string;
  startedAtMs: number;
  durationMs: number | null;
}

interface ManagedProcess {
  definition: ProcessDefinition;
  /** Lifetime of the supervised process, or of the whole interactive terminal. */
  phase: ProcessSnapshot["phase"];
  /** Non-interactive child process. */
  subprocess: Bun.Subprocess | null;
  /** Interactive terminal: the active run, or the resting shell after it. */
  session: TerminalSession | null;
  exitCode: number | null;
  signal: string | null;
  logs: ProcessLogEntry[];
  logBytes: number;
  nextSequence: number;
  completion: Promise<void> | null;
  startedAt: string | null;
  startedAtMs: number | null;
  durationMs: number | null;
  /** Latest execution of the configured command, retained across terminal restarts. */
  run: RunState | null;
  cols: number;
  rows: number;
  /** A start is resolving its environment or replacing the resting shell. */
  starting: boolean;
  /** Incremented by stop so an in-flight start cannot spawn after it. */
  generation: number;
}

function cloneDefinition(definition: ProcessDefinition): ProcessDefinition {
  return {
    id: definition.id,
    command: definition.command,
    ...(definition.interactive === true ? { interactive: true } : {}),
    ...(definition.interactiveShell === undefined ? {} : { interactiveShell: [...definition.interactiveShell] }),
    ...(definition.closeAfterRun === true ? { closeAfterRun: true } : {}),
    ...(definition.projectRoot === undefined ? {} : { projectRoot: definition.projectRoot }),
    ...(definition.configPath === undefined ? {} : { configPath: definition.configPath }),
    ...(definition.cwd === undefined ? {} : { cwd: definition.cwd }),
    ...(definition.env === undefined ? {} : { env: { ...definition.env } }),
  };
}

function definitionKey(definition: ProcessDefinition): string {
  return JSON.stringify({
    command: definition.command,
    interactive: definition.interactive === true,
    interactiveShell: definition.interactiveShell ?? null,
    closeAfterRun: definition.closeAfterRun === true,
    projectRoot: definition.projectRoot ?? null,
    configPath: definition.configPath ?? null,
    cwd: definition.cwd ?? null,
    env: Object.entries(definition.env ?? {}).sort(([left], [right]) => left.localeCompare(right)),
  });
}

function terminalShell(definition: ProcessDefinition): string[] {
  if (definition.interactiveShell !== undefined) return [...definition.interactiveShell];
  return process.platform === "win32" ? ["cmd.exe"] : [process.env.SHELL || "/bin/sh", "-i"];
}

/**
 * A run executes the command once in the terminal's shell. POSIX shells keep
 * `-i` so the command sees the same interactive startup files as typed input.
 */
function runCommandLine(shell: readonly string[], command: string): string[] {
  const program = basename(shell[0] ?? "").toLowerCase();
  if (process.platform === "win32" && (program === "cmd" || program === "cmd.exe")) {
    return [...shell, "/d", "/s", "/c", command];
  }
  return [...shell, "-c", command];
}

function commandHeader(command: string): string {
  const lines = command.trim().split(/\r?\n/);
  const first = lines[0] ?? "";
  const shortened = first.length > MAX_COMMAND_HEADER_LENGTH ? `${first.slice(0, MAX_COMMAND_HEADER_LENGTH)}…` : first;
  return `$ ${shortened}${lines.length > 1 && first.length <= MAX_COMMAND_HEADER_LENGTH ? " …" : ""}`;
}

async function killTree(subprocess: Bun.Subprocess, signal: NodeJS.Signals): Promise<void> {
  if (subprocess.exitCode !== null || subprocess.signalCode !== null) return;
  if (process.platform === "win32") {
    const cmd = ["taskkill", "/PID", String(subprocess.pid), "/T"];
    if (signal === "SIGKILL") cmd.push("/F");
    await Bun.spawn({ cmd, stdout: "ignore", stderr: "ignore" }).exited.catch(() => undefined);
    return;
  }
  try {
    process.kill(-subprocess.pid, signal);
  } catch {
    try {
      subprocess.kill(signal);
    } catch {
      // The subprocess may have exited between checks.
    }
  }
}

/** Foreground process group of the terminal whose session leader is `pid`. */
async function foregroundProcessGroup(pid: number): Promise<number | null> {
  if (process.platform === "win32") return null;
  try {
    if (process.platform === "linux") {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const tpgid = Number(fields[5]);
      return Number.isInteger(tpgid) ? tpgid : null;
    }
    const ps = Bun.spawn({
      cmd: [process.platform === "darwin" ? "/bin/ps" : "ps", "-o", "tpgid=", "-p", String(pid)],
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const [text, exitCode] = await Promise.all([new Response(ps.stdout).text(), ps.exited]);
    if (exitCode !== 0) return null;
    const tpgid = Number.parseInt(text.trim(), 10);
    return Number.isInteger(tpgid) ? tpgid : null;
  } catch {
    return null;
  }
}

/**
 * A resting shell nobody typed into is idle. Otherwise it leads its own
 * session, so another foreground process group means the user started a
 * command in it. An unknown answer (including Windows) counts as busy so a new
 * run never ends work the user started.
 */
async function restingShellIsBusy(session: TerminalSession): Promise<boolean> {
  if (!session.inputWritten) return false;
  const { subprocess } = session;
  const tpgid = await foregroundProcessGroup(subprocess.pid);
  if (subprocess.exitCode !== null || subprocess.signalCode !== null) return false;
  if (tpgid === null) return true;
  return tpgid > 0 && tpgid !== subprocess.pid;
}

/**
 * End a PTY session like closing its terminal window: signal the job in the
 * terminal's foreground (an interactive shell may give it its own process
 * group) and then the session's own process tree.
 */
async function killSession(session: TerminalSession, signal: NodeJS.Signals): Promise<void> {
  const { subprocess } = session;
  if (subprocess.exitCode !== null || subprocess.signalCode !== null) return;
  if (process.platform !== "win32") {
    const tpgid = await foregroundProcessGroup(subprocess.pid);
    if (tpgid !== null && tpgid > 0 && tpgid !== subprocess.pid) {
      try {
        process.kill(-tpgid, signal);
      } catch {
        // The foreground job may have exited between checks.
      }
    }
  }
  await killTree(subprocess, signal);
}

function runActive(processState: ManagedProcess): boolean {
  return processState.run?.phase === "running" || processState.run?.phase === "stopping";
}

export class ProcessManager {
  readonly projectRoot: string;
  private readonly onProcess?: (snapshot: ProcessSnapshot) => void;
  private readonly maxLogBytes: number;
  private readonly maxLogEntries: number;
  private readonly stopGraceMs: number;
  private readonly getPublishedEnvironment: PublishedEnvironment;
  private readonly processes = new Map<string, ManagedProcess>();
  private closed = false;

  constructor(options: ProcessManagerOptions) {
    this.projectRoot = options.projectRoot;
    this.onProcess = options.onProcess;
    this.maxLogBytes = options.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES;
    this.maxLogEntries = options.maxLogEntries ?? DEFAULT_MAX_LOG_ENTRIES;
    this.stopGraceMs = options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
    this.getPublishedEnvironment = options.getPublishedEnvironment ?? (() => ({}));
  }

  private create(definition: ProcessDefinition): ManagedProcess {
    return {
      definition: cloneDefinition(definition),
      phase: "idle",
      subprocess: null,
      session: null,
      exitCode: null,
      signal: null,
      logs: [],
      logBytes: 0,
      nextSequence: 1,
      completion: null,
      startedAt: null,
      startedAtMs: null,
      durationMs: null,
      run: null,
      cols: DEFAULT_TERMINAL_COLS,
      rows: DEFAULT_TERMINAL_ROWS,
      starting: false,
      generation: 0,
    };
  }

  private snapshot(processState: ManagedProcess): ProcessSnapshot {
    const live = processState.session?.subprocess ?? processState.subprocess;
    const run = processState.run;
    return {
      id: processState.definition.id,
      phase: processState.phase,
      pid: live !== null && live.exitCode === null && live.signalCode === null ? live.pid : null,
      exitCode: processState.exitCode,
      signal: processState.signal,
      logs: processState.logs.map((entry) => ({ ...entry })),
      ...(processState.definition.interactive === true ? { interactive: true } : {}),
      ...(processState.startedAt === null ? {} : { startedAt: processState.startedAt }),
      ...(processState.durationMs === null ? {} : { durationMs: processState.durationMs }),
      ...(run === null ? {} : {
        run: {
          phase: run.phase,
          exitCode: run.exitCode,
          signal: run.signal,
          startedAt: run.startedAt,
          ...(run.durationMs === null ? {} : { durationMs: run.durationMs }),
        },
      }),
    };
  }

  private emit(processState: ManagedProcess): ProcessSnapshot {
    const snapshot = this.snapshot(processState);
    this.onProcess?.(snapshot);
    return snapshot;
  }

  private append(
    processState: ManagedProcess,
    stream: ProcessLogEntry["stream"],
    text: string,
  ): void {
    if (text === "") return;
    let boundedText = text;
    let bytes = Buffer.byteLength(boundedText);
    if (bytes > this.maxLogBytes) {
      const encoded = new TextEncoder().encode(boundedText);
      boundedText = new TextDecoder().decode(encoded.slice(encoded.byteLength - this.maxLogBytes));
      bytes = Buffer.byteLength(boundedText);
    }
    processState.logs.push({
      sequence: processState.nextSequence++,
      stream,
      text: boundedText,
    });
    processState.logBytes += bytes;
    while (
      processState.logs.length > this.maxLogEntries ||
      processState.logBytes > this.maxLogBytes
    ) {
      const removed = processState.logs.shift();
      if (removed === undefined) break;
      processState.logBytes -= Buffer.byteLength(removed.text);
    }
    this.emit(processState);
  }

  /** A system line that starts and ends on its own terminal row. */
  private terminalLine(processState: ManagedProcess, text: string): void {
    const previous = processState.logs.at(-1)?.text;
    const lineBreak = previous !== undefined && !previous.endsWith("\n") ? "\r\n" : "";
    this.append(processState, "system", `${lineBreak}${text}\r\n`);
  }

  private async pump(
    processState: ManagedProcess,
    subprocess: Bun.Subprocess,
    stream: "stdout" | "stderr",
    readable: ReadableStream<Uint8Array>,
  ): Promise<void> {
    const decoder = new TextDecoder();
    const reader = readable.getReader();
    while (processState.subprocess === subprocess) {
      const { done, value } = await reader.read();
      if (done) break;
      this.append(processState, stream, decoder.decode(value, { stream: true }));
    }
    this.append(processState, stream, decoder.decode());
  }

  private monitor(
    processState: ManagedProcess,
    subprocess: Bun.Subprocess<"ignore", "pipe", "pipe">,
  ): Promise<void> {
    return Promise.allSettled([
      this.pump(processState, subprocess, "stdout", subprocess.stdout),
      this.pump(processState, subprocess, "stderr", subprocess.stderr),
      subprocess.exited,
    ]).then((results) => {
      if (processState.subprocess !== subprocess) return;
      const exitResult = results[2];
      const exitCode = exitResult?.status === "fulfilled" ? exitResult.value : subprocess.exitCode;
      const now = Date.now();
      processState.exitCode = subprocess.signalCode === null ? exitCode : null;
      processState.signal = subprocess.signalCode;
      processState.phase = exitResult?.status === "rejected" ? "failed" : "exited";
      processState.durationMs = processState.startedAtMs === null ? null : Math.max(0, now - processState.startedAtMs);
      if (processState.run !== null) {
        processState.run.phase = processState.phase;
        processState.run.exitCode = processState.exitCode;
        processState.run.signal = processState.signal;
        processState.run.durationMs = Math.max(0, now - processState.run.startedAtMs);
      }
      processState.subprocess = null;
      processState.completion = null;
      if (exitResult?.status === "rejected") {
        this.append(processState, "system", `Process wait failed: ${errorMessage(exitResult.reason)}`);
      } else {
        this.append(
          processState,
          "system",
          subprocess.signalCode === null
            ? `Process exited with code ${String(exitCode)}.`
            : `Process exited after ${subprocess.signalCode}.`,
        );
      }
      this.emit(processState);
    });
  }

  async reconcile(definitions: readonly ProcessDefinition[]): Promise<ProcessSnapshot[]> {
    if (this.closed) throw new CoreError("PROCESS_MANAGER_CLOSED", "The process manager is closed.");
    const incoming = new Map<string, ProcessDefinition>();
    for (const definition of definitions) {
      if (incoming.has(definition.id)) {
        throw new CoreError("PROCESS_DEFINITION_DUPLICATE", `Duplicate process definition: ${definition.id}`);
      }
      incoming.set(definition.id, cloneDefinition(definition));
    }

    for (const [id, current] of [...this.processes]) {
      const replacement = incoming.get(id);
      if (replacement === undefined || definitionKey(replacement) !== definitionKey(current.definition)) {
        await this.stop(id);
        this.processes.delete(id);
      }
    }
    for (const definition of incoming.values()) {
      if (!this.processes.has(definition.id)) this.processes.set(definition.id, this.create(definition));
    }
    return this.list();
  }

  get(id: string): ProcessSnapshot | null {
    const processState = this.processes.get(id);
    return processState === undefined ? null : this.snapshot(processState);
  }

  list(): ProcessSnapshot[] {
    return [...this.processes.values()].map((processState) => this.snapshot(processState));
  }

  private require(id: string): ManagedProcess {
    if (this.closed) throw new CoreError("PROCESS_MANAGER_CLOSED", "The process manager is closed.");
    const processState = this.processes.get(id);
    if (processState === undefined) throw new CoreError("PROCESS_NOT_FOUND", `Unknown command node: ${id}`);
    return processState;
  }

  private assertCommand(processState: ManagedProcess): void {
    if (processState.definition.command.trim() === "" || processState.definition.command.length > 32_768) {
      throw new CoreError("PROCESS_COMMAND_INVALID", "Process command must be non-empty and at most 32768 characters.");
    }
  }

  private resolveCwd(processState: ManagedProcess): Promise<string> {
    const projectRoot = processState.definition.projectRoot ?? this.projectRoot;
    return processState.definition.cwd === undefined
      ? Promise.resolve(projectRoot)
      : resolveContainedPath(projectRoot, processState.definition.cwd, { kind: "directory" });
  }

  private resolveBaseEnvironment(processState: ManagedProcess): Promise<Record<string, string>> {
    return resolveEnvironment(
      processState.definition.configPath,
      this.getPublishedEnvironment(),
      processState.definition.env,
    );
  }

  /**
   * Runs the configured command once. A non-interactive process runs it as its
   * whole lifetime; an interactive terminal runs it as a PTY session and then
   * continues in a resting shell. Item values reach only this run's environment.
   */
  async start(id: string, itemEnvironment?: Record<string, string>): Promise<ProcessSnapshot> {
    const processState = this.require(id);
    return processState.definition.interactive
      ? this.startRun(processState, itemEnvironment)
      : this.startProcess(processState, itemEnvironment);
  }

  /** Start a persistent terminal session without running its configured quick action. */
  async open(id: string): Promise<ProcessSnapshot> {
    const processState = this.require(id);
    if (!processState.definition.interactive) return this.startProcess(processState, undefined);
    return this.openTerminal(processState);
  }

  /** Run the configured quick action again without item values, in the same terminal when one is open. */
  async runQuickAction(id: string): Promise<ProcessSnapshot> {
    return this.start(id);
  }

  private assertCanStart(processState: ManagedProcess): void {
    const id = processState.definition.id;
    if (processState.starting || processState.phase === "stopping" || runActive(processState)) {
      throw new CoreError("PROCESS_ALREADY_RUNNING", `Command ${id} is already running.`);
    }
  }

  private async startProcess(
    processState: ManagedProcess,
    itemEnvironmentInput: Record<string, string> | undefined,
  ): Promise<ProcessSnapshot> {
    const id = processState.definition.id;
    if (processState.subprocess !== null) {
      throw new CoreError("PROCESS_ALREADY_RUNNING", `Command ${id} is already running.`);
    }
    this.assertCanStart(processState);
    this.assertCommand(processState);
    const itemEnvironment = validateItemEnvironment(itemEnvironmentInput);
    processState.starting = true;
    const generation = processState.generation;
    try {
      const cwd = await this.resolveCwd(processState);
      processState.logs = [];
      processState.logBytes = 0;
      processState.exitCode = null;
      processState.signal = null;
      processState.startedAt = null;
      processState.startedAtMs = null;
      processState.durationMs = null;
      try {
        const environment = await this.resolveBaseEnvironment(processState);
        if (generation !== processState.generation || this.closed) return this.snapshot(processState);
        const shell = process.platform === "win32" ? ["cmd.exe", "/d", "/s", "/c"] : ["/bin/sh", "-lc"];
        const subprocess = Bun.spawn({
          cmd: [...shell, processState.definition.command],
          cwd,
          env: { ...environment, ...itemEnvironment },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          detached: process.platform !== "win32",
        });
        processState.subprocess = subprocess;
        processState.phase = "running";
        processState.startedAtMs = Date.now();
        processState.startedAt = new Date(processState.startedAtMs).toISOString();
        processState.run = {
          phase: "running",
          exitCode: null,
          signal: null,
          startedAt: processState.startedAt,
          startedAtMs: processState.startedAtMs,
          durationMs: null,
        };
        this.append(processState, "system", `Started process ${subprocess.pid}.`);
        processState.completion = this.monitor(processState, subprocess);
        return this.emit(processState);
      } catch (error) {
        processState.phase = "failed";
        processState.durationMs = processState.startedAtMs === null ? null : Math.max(0, Date.now() - processState.startedAtMs);
        processState.run = this.failedRun();
        this.append(processState, "system", `Failed to start: ${errorMessage(error)}`);
        return this.emit(processState);
      }
    } finally {
      processState.starting = false;
    }
  }

  private failedRun(): RunState {
    const now = Date.now();
    return {
      phase: "failed",
      exitCode: null,
      signal: null,
      startedAt: new Date(now).toISOString(),
      startedAtMs: now,
      durationMs: 0,
    };
  }

  /** Reset per-terminal state for a terminal that is not currently open. */
  private beginTerminal(processState: ManagedProcess): void {
    processState.logs = [];
    processState.logBytes = 0;
    processState.exitCode = null;
    processState.signal = null;
    processState.durationMs = null;
    processState.phase = "running";
    processState.startedAtMs = Date.now();
    processState.startedAt = new Date(processState.startedAtMs).toISOString();
  }

  /** End the whole interactive terminal with the last session's result. */
  private endTerminal(
    processState: ManagedProcess,
    phase: "exited" | "failed",
    exitCode: number | null,
    signal: string | null,
  ): void {
    processState.phase = phase;
    processState.exitCode = exitCode;
    processState.signal = signal;
    processState.durationMs = processState.startedAtMs === null ? null : Math.max(0, Date.now() - processState.startedAtMs);
  }

  private async openTerminal(processState: ManagedProcess): Promise<ProcessSnapshot> {
    const id = processState.definition.id;
    if (processState.session !== null) {
      throw new CoreError("PROCESS_ALREADY_RUNNING", `Command ${id} is already running.`);
    }
    this.assertCanStart(processState);
    this.assertCommand(processState);
    processState.starting = true;
    const generation = processState.generation;
    try {
      const cwd = await this.resolveCwd(processState);
      let environment: Record<string, string>;
      try {
        environment = await this.resolveBaseEnvironment(processState);
      } catch (error) {
        this.beginTerminal(processState);
        this.endTerminal(processState, "failed", null, null);
        this.append(processState, "system", `Failed to start: ${errorMessage(error)}`);
        return this.emit(processState);
      }
      if (generation !== processState.generation || this.closed) return this.snapshot(processState);
      this.beginTerminal(processState);
      try {
        const session = this.spawnShell(processState, cwd, environment);
        this.terminalLine(processState, `Started interactive terminal ${session.subprocess.pid}.`);
      } catch (error) {
        this.endTerminal(processState, "failed", null, null);
        this.append(processState, "system", `Failed to start: ${errorMessage(error)}`);
      }
      return this.emit(processState);
    } finally {
      processState.starting = false;
    }
  }

  private async startRun(
    processState: ManagedProcess,
    itemEnvironmentInput: Record<string, string> | undefined,
  ): Promise<ProcessSnapshot> {
    const id = processState.definition.id;
    this.assertCanStart(processState);
    this.assertCommand(processState);
    const itemEnvironment = validateItemEnvironment(itemEnvironmentInput);
    processState.starting = true;
    const generation = processState.generation;
    const cancelled = (): boolean => generation !== processState.generation || this.closed;
    try {
      const cwd = await this.resolveCwd(processState);
      let environment: Record<string, string>;
      try {
        environment = await this.resolveBaseEnvironment(processState);
      } catch (error) {
        // An open resting shell stays usable; only this run failed.
        processState.run = this.failedRun();
        if (processState.session === null) {
          this.beginTerminal(processState);
          this.endTerminal(processState, "failed", null, null);
        }
        this.terminalLine(processState, `Failed to start: ${errorMessage(error)}`);
        return this.emit(processState);
      }
      if (cancelled()) return this.snapshot(processState);

      const resting = processState.session;
      if (resting !== null) {
        if (resting.kind === "run") {
          throw new CoreError("PROCESS_ALREADY_RUNNING", `Command ${id} is already running.`);
        }
        if (await restingShellIsBusy(resting)) {
          throw new CoreError(
            "PROCESS_TERMINAL_BUSY",
            `The ${id} terminal is running a command started in it. Finish or interrupt that command, or close the terminal, before running again.`,
          );
        }
        if (cancelled()) return this.snapshot(processState);
        await this.replaceRestingShell(processState, resting);
        if (cancelled()) return this.snapshot(processState);
      }
      if (processState.session !== null) {
        throw new CoreError("PROCESS_ALREADY_RUNNING", `Command ${id} is already running.`);
      }
      if (processState.phase !== "running") this.beginTerminal(processState);
      return this.spawnRun(processState, cwd, environment, itemEnvironment);
    } finally {
      processState.starting = false;
    }
  }

  private spawnSession(
    processState: ManagedProcess,
    kind: TerminalSession["kind"],
    cmd: string[],
    cwd: string,
    environment: Record<string, string>,
  ): TerminalSession {
    const decoder = new TextDecoder();
    let session: TerminalSession | null = null;
    let markEof: () => void = () => undefined;
    const eof = new Promise<void>((resolve) => { markEof = resolve; });
    const subprocess = Bun.spawn({
      cmd,
      cwd,
      env: { ...environment, TERM: "xterm-256color" },
      detached: process.platform !== "win32",
      terminal: {
        cols: processState.cols,
        rows: processState.rows,
        name: "xterm-256color",
        data: (_terminal, data) => {
          if (session !== null && processState.session === session && !session.replacing) {
            this.append(processState, "stdout", decoder.decode(data, { stream: true }));
          }
        },
        exit: () => markEof(),
      },
    });
    const terminal = subprocess.terminal;
    if (!terminal) {
      void killTree(subprocess, "SIGKILL");
      throw new CoreError("PROCESS_TERMINAL_UNAVAILABLE", "The PTY terminal could not be created.");
    }
    session = { kind, subprocess, terminal, decoder, replacing: false, inputWritten: false, eof, completion: Promise.resolve() };
    processState.session = session;
    return session;
  }

  private spawnShell(processState: ManagedProcess, cwd: string, environment: Record<string, string>): TerminalSession {
    const session = this.spawnSession(processState, "shell", terminalShell(processState.definition), cwd, environment);
    session.completion = this.monitorSession(processState, session, cwd, environment);
    return session;
  }

  private spawnRun(
    processState: ManagedProcess,
    cwd: string,
    environment: Record<string, string>,
    itemEnvironment: Record<string, string>,
  ): ProcessSnapshot {
    const command = runCommandLine(terminalShell(processState.definition), processState.definition.command);
    let session: TerminalSession;
    try {
      session = this.spawnSession(processState, "run", command, cwd, { ...environment, ...itemEnvironment });
    } catch (error) {
      processState.run = this.failedRun();
      this.endTerminal(processState, "failed", null, null);
      this.terminalLine(processState, `Failed to start: ${errorMessage(error)}`);
      return this.emit(processState);
    }
    const startedAtMs = Date.now();
    processState.run = {
      phase: "running",
      exitCode: null,
      signal: null,
      startedAt: new Date(startedAtMs).toISOString(),
      startedAtMs,
      durationMs: null,
    };
    this.terminalLine(processState, commandHeader(processState.definition.command));
    // The resting shell that follows a run never inherits this run's item values.
    session.completion = this.monitorSession(processState, session, cwd, environment);
    return this.emit(processState);
  }

  private async replaceRestingShell(processState: ManagedProcess, session: TerminalSession): Promise<void> {
    session.replacing = true;
    await killSession(session, "SIGHUP");
    const forceTimer = setTimeout(() => void killSession(session, "SIGKILL"), this.stopGraceMs);
    try {
      await session.completion;
    } finally {
      clearTimeout(forceTimer);
    }
    if (processState.session === session) processState.session = null;
  }

  private monitorSession(
    processState: ManagedProcess,
    session: TerminalSession,
    cwd: string,
    environment: Record<string, string>,
  ): Promise<void> {
    // Keep a run's trailing output ahead of its exit line and the next prompt.
    const drained = (): Promise<unknown> => Promise.race([session.eof, Bun.sleep(PTY_DRAIN_MS)]);
    return session.subprocess.exited.then(
      async (exitCode) => {
        await drained();
        this.finishSession(processState, session, exitCode, null, cwd, environment);
      },
      async (error: unknown) => {
        await drained();
        this.finishSession(processState, session, null, error, cwd, environment);
      },
    );
  }

  private finishSession(
    processState: ManagedProcess,
    session: TerminalSession,
    exitCode: number | null,
    error: unknown,
    cwd: string,
    environment: Record<string, string>,
  ): void {
    if (processState.session !== session) return;
    const failed = error !== null;
    const signal = session.subprocess.signalCode ?? null;
    const code = failed || signal !== null ? null : exitCode;
    if (!session.replacing) this.append(processState, "stdout", session.decoder.decode());
    processState.session = null;
    session.terminal.close();

    if (session.kind === "shell") {
      // A replaced resting shell hands the still-open terminal to the next run.
      if (session.replacing && processState.phase === "running") return;
      this.endTerminal(processState, failed ? "failed" : "exited", code, signal);
      this.terminalLine(
        processState,
        failed
          ? `Terminal wait failed: ${errorMessage(error)}`
          : signal === null ? `Terminal exited with code ${String(code)}.` : `Terminal exited after ${signal}.`,
      );
      this.emit(processState);
      return;
    }

    const run = processState.run;
    if (run !== null) {
      run.phase = failed ? "failed" : "exited";
      run.exitCode = code;
      run.signal = signal;
      run.durationMs = Math.max(0, Date.now() - run.startedAtMs);
    }
    this.terminalLine(
      processState,
      failed
        ? `Command wait failed: ${errorMessage(error)}`
        : signal === null ? `Command exited with code ${String(code)}.` : `Command exited after ${signal}.`,
    );
    if (processState.phase === "running" && processState.definition.closeAfterRun !== true && !this.closed) {
      try {
        this.spawnShell(processState, cwd, environment);
        this.emit(processState);
        return;
      } catch (spawnError) {
        this.terminalLine(processState, `Failed to start terminal shell: ${errorMessage(spawnError)}`);
      }
    }
    this.endTerminal(processState, failed ? "failed" : "exited", code, signal);
    this.emit(processState);
  }

  private liveSession(processState: ManagedProcess): TerminalSession {
    const session = processState.session;
    if (!processState.definition.interactive || session === null || session.replacing) {
      throw new CoreError("PROCESS_TERMINAL_NOT_RUNNING", `Interactive terminal ${processState.definition.id} is not running.`);
    }
    return session;
  }

  async write(id: string, input: string): Promise<ProcessSnapshot> {
    const processState = this.require(id);
    const session = this.liveSession(processState);
    if (input.length === 0 || input.length > 32_768) {
      throw new CoreError("PROCESS_TERMINAL_INPUT_INVALID", "Terminal input must be between 1 and 32768 characters.");
    }
    session.inputWritten = true;
    session.terminal.write(input);
    return this.snapshot(processState);
  }

  async resize(id: string, cols: number, rows: number): Promise<ProcessSnapshot> {
    const processState = this.require(id);
    const session = this.liveSession(processState);
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 20 || cols > 500 || rows < 4 || rows > 200) {
      throw new CoreError("PROCESS_TERMINAL_SIZE_INVALID", "Terminal size must be 20-500 columns and 4-200 rows.");
    }
    processState.cols = cols;
    processState.rows = rows;
    session.terminal.resize(cols, rows);
    return this.snapshot(processState);
  }

  async stop(id: string): Promise<ProcessSnapshot> {
    const processState = this.processes.get(id);
    if (processState === undefined) throw new CoreError("PROCESS_NOT_FOUND", `Unknown command node: ${id}`);
    processState.generation += 1;
    const session = processState.session;
    const subprocess = processState.subprocess;
    const completion = session?.completion ?? processState.completion;
    if (session === null && subprocess === null) return this.snapshot(processState);

    processState.phase = "stopping";
    if (processState.run?.phase === "running") processState.run.phase = "stopping";
    this.emit(processState);
    // Closing an interactive terminal hangs it up like closing its window.
    const end = (signal: NodeJS.Signals): Promise<void> => session !== null
      ? killSession(session, signal)
      : killTree(subprocess!, signal);
    await end(session !== null ? "SIGHUP" : "SIGTERM");
    const forceTimer = setTimeout(() => void end("SIGKILL"), this.stopGraceMs);
    try {
      await completion;
    } finally {
      clearTimeout(forceTimer);
    }
    return this.snapshot(processState);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await Promise.all([...this.processes.keys()].map((id) => this.stop(id).catch(() => undefined)));
    this.closed = true;
  }
}
