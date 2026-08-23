import type { ProcessLogEntry, ProcessSnapshot } from "../shared/contracts";
import { CoreError, errorMessage } from "./diagnostics";
import { resolveContainedPath } from "./paths";

const DEFAULT_MAX_LOG_BYTES = 512 * 1024;
const DEFAULT_MAX_LOG_ENTRIES = 2_000;
const DEFAULT_STOP_GRACE_MS = 2_000;

export interface ProcessDefinition {
  id: string;
  command: string;
  projectRoot?: string;
  cwd?: string;
  env?: Record<string, string>;
}

export interface ProcessManagerOptions {
  projectRoot: string;
  onProcess?: (snapshot: ProcessSnapshot) => void;
  maxLogBytes?: number;
  maxLogEntries?: number;
  stopGraceMs?: number;
}

interface ManagedProcess {
  definition: ProcessDefinition;
  phase: ProcessSnapshot["phase"];
  subprocess: Bun.Subprocess<"ignore", "pipe", "pipe"> | null;
  exitCode: number | null;
  signal: string | null;
  logs: ProcessLogEntry[];
  logBytes: number;
  nextSequence: number;
  completion: Promise<void> | null;
}

function cloneDefinition(definition: ProcessDefinition): ProcessDefinition {
  return {
    id: definition.id,
    command: definition.command,
    ...(definition.projectRoot === undefined ? {} : { projectRoot: definition.projectRoot }),
    ...(definition.cwd === undefined ? {} : { cwd: definition.cwd }),
    ...(definition.env === undefined ? {} : { env: { ...definition.env } }),
  };
}

function definitionKey(definition: ProcessDefinition): string {
  return JSON.stringify({
    command: definition.command,
    projectRoot: definition.projectRoot ?? null,
    cwd: definition.cwd ?? null,
    env: Object.entries(definition.env ?? {}).sort(([left], [right]) => left.localeCompare(right)),
  });
}

async function killTree(subprocess: Bun.Subprocess, signal: NodeJS.Signals): Promise<void> {
  if (subprocess.exitCode !== null) return;
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

export class ProcessManager {
  readonly projectRoot: string;
  private readonly onProcess?: (snapshot: ProcessSnapshot) => void;
  private readonly maxLogBytes: number;
  private readonly maxLogEntries: number;
  private readonly stopGraceMs: number;
  private readonly processes = new Map<string, ManagedProcess>();
  private closed = false;

  constructor(options: ProcessManagerOptions) {
    this.projectRoot = options.projectRoot;
    this.onProcess = options.onProcess;
    this.maxLogBytes = options.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES;
    this.maxLogEntries = options.maxLogEntries ?? DEFAULT_MAX_LOG_ENTRIES;
    this.stopGraceMs = options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
  }

  private create(definition: ProcessDefinition): ManagedProcess {
    return {
      definition: cloneDefinition(definition),
      phase: "idle",
      subprocess: null,
      exitCode: null,
      signal: null,
      logs: [],
      logBytes: 0,
      nextSequence: 1,
      completion: null,
    };
  }

  private snapshot(processState: ManagedProcess): ProcessSnapshot {
    return {
      id: processState.definition.id,
      phase: processState.phase,
      pid: processState.subprocess?.exitCode === null ? processState.subprocess.pid : null,
      exitCode: processState.exitCode,
      signal: processState.signal,
      logs: processState.logs.map((entry) => ({ ...entry })),
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
      processState.exitCode = subprocess.signalCode === null ? exitCode : null;
      processState.signal = subprocess.signalCode;
      processState.phase = exitResult?.status === "rejected" ? "failed" : "exited";
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

  async start(id: string): Promise<ProcessSnapshot> {
    if (this.closed) throw new CoreError("PROCESS_MANAGER_CLOSED", "The process manager is closed.");
    const processState = this.processes.get(id);
    if (processState === undefined) throw new CoreError("PROCESS_NOT_FOUND", `Unknown command node: ${id}`);
    if (processState.subprocess !== null) {
      throw new CoreError("PROCESS_ALREADY_RUNNING", `Command ${id} is already running.`);
    }
    if (processState.definition.command.trim() === "" || processState.definition.command.length > 32_768) {
      throw new CoreError("PROCESS_COMMAND_INVALID", "Process command must be non-empty and at most 32768 characters.");
    }

    const projectRoot = processState.definition.projectRoot ?? this.projectRoot;
    const cwd =
      processState.definition.cwd === undefined
        ? projectRoot
        : await resolveContainedPath(projectRoot, processState.definition.cwd, { kind: "directory" });
    const shell = process.platform === "win32" ? ["cmd.exe", "/d", "/s", "/c"] : ["/bin/sh", "-lc"];
    processState.logs = [];
    processState.logBytes = 0;
    processState.exitCode = null;
    processState.signal = null;

    try {
      const subprocess = Bun.spawn({
        cmd: [...shell, processState.definition.command],
        cwd,
        env: { ...process.env, ...processState.definition.env },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        detached: process.platform !== "win32",
      });
      processState.subprocess = subprocess;
      processState.phase = "running";
      this.append(processState, "system", `Started process ${subprocess.pid}.`);
      processState.completion = this.monitor(processState, subprocess);
      return this.emit(processState);
    } catch (error) {
      processState.phase = "failed";
      this.append(processState, "system", `Failed to start: ${errorMessage(error)}`);
      return this.emit(processState);
    }
  }

  async stop(id: string): Promise<ProcessSnapshot> {
    const processState = this.processes.get(id);
    if (processState === undefined) throw new CoreError("PROCESS_NOT_FOUND", `Unknown command node: ${id}`);
    const subprocess = processState.subprocess;
    if (subprocess === null) return this.snapshot(processState);

    processState.phase = "stopping";
    this.emit(processState);
    await killTree(subprocess, "SIGTERM");
    const forceTimer = setTimeout(() => void killTree(subprocess, "SIGKILL"), this.stopGraceMs);
    try {
      await processState.completion;
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
