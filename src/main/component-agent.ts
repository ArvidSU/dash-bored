import { randomUUID } from "node:crypto";
import { CoreError } from "../core/diagnostics";
import { ProcessManager, type ProcessDefinition } from "../core/process-manager";
import type { ComponentAgentLaunch, DashboardAgentTask, ProcessSnapshot } from "../shared/contracts";

const MAX_AGENT_PROMPT_LENGTH = 16_384;
const MAX_COMPLETED_AGENT_TASKS = 20;

function shellPromptReference(): string {
  return process.platform === "win32"
    ? '"%DASH_BORED_AGENT_PROMPT%"'
    : '"$DASH_BORED_AGENT_PROMPT"';
}

export function componentAgentInvocation(command: string): string {
  return `${command.trim()} ${shellPromptReference()}`;
}

export interface LaunchComponentAgentOptions {
  purpose?: DashboardAgentTask["purpose"];
  command: string;
  prompt: string;
  projectRoot: string;
  componentPath: string;
  configPath: string;
  request: string;
  env?: Record<string, string>;
  onFinished?: (task: DashboardAgentTask) => void | Promise<void>;
}

export interface DashboardAgentHarnessOptions {
  onTask?: (task: DashboardAgentTask) => void;
}

/**
 * A deliberately small wrapper around the user's configured CLI. It manages
 * only dashboard-change requests so the app can show launch, output, exit,
 * and concurrent dashboard-change feedback without becoming an agent host.
 * Agent processes use the same PTY-backed process primitive as command nodes so
 * the activity detail view can attach the regular command terminal to them.
 */
export class DashboardAgentHarness {
  private readonly manager: ProcessManager;
  private definitions: ProcessDefinition[] = [];
  private operation: Promise<void> = Promise.resolve();
  private readonly tasks = new Map<string, DashboardAgentTask>();
  private readonly onTask?: (task: DashboardAgentTask) => void;
  private readonly finishers = new Map<string, (task: DashboardAgentTask) => void | Promise<void>>();
  private readonly finished = new Set<string>();
  private closed = false;

  constructor(options: DashboardAgentHarnessOptions = {}) {
    this.onTask = options.onTask;
    this.manager = new ProcessManager({
      projectRoot: process.cwd(),
      onProcess: (process) => this.updateProcess(process),
    });
  }

  private emit(task: DashboardAgentTask): void {
    this.onTask?.({ ...task, process: { ...task.process, logs: task.process.logs.map((entry) => ({ ...entry })) } });
  }

  private updateProcess(process: ProcessSnapshot): void {
    const task = this.tasks.get(process.id);
    if (!task) return;
    task.process = process;
    this.emit(task);
    if ((process.phase === "exited" || process.phase === "failed") && !this.finished.has(task.id)) {
      this.finished.add(task.id);
      const finisher = this.finishers.get(task.id);
      this.finishers.delete(task.id);
      if (finisher && !this.closed) {
        void Promise.resolve().then(() => finisher(structuredClone(task))).catch((error) => {
          this.setValidation(task.id, {
            status: "failed",
            diagnostics: [{
              severity: "error",
              code: "DASHBOARD_AGENT_FINISH_FAILED",
              message: error instanceof Error ? error.message : String(error),
            }],
          });
        });
      }
    }
    this.pruneCompletedTasks();
  }

  private pruneCompletedTasks(): void {
    const completed = [...this.tasks.values()]
      .filter((task) => (task.process.phase === "exited" || task.process.phase === "failed")
        && task.validation?.status !== "checking" && task.validation?.status !== "repairing")
      .sort((left, right) => (right.startedAt ?? "").localeCompare(left.startedAt ?? ""));
    for (const task of completed.slice(MAX_COMPLETED_AGENT_TASKS)) {
      this.tasks.delete(task.id);
      this.finishers.delete(task.id);
      this.finished.delete(task.id);
    }
  }

  list(): DashboardAgentTask[] {
    return [...this.tasks.values()]
      .sort((left, right) => (right.startedAt ?? "").localeCompare(left.startedAt ?? ""))
      .map((task) => ({ ...task, process: { ...task.process, logs: task.process.logs.map((entry) => ({ ...entry })) } }));
  }

  async stop(id: string): Promise<DashboardAgentTask> {
    const task = this.tasks.get(id);
    if (task) {
      task.cancelled = true;
      this.emit(task);
    }
    if (this.manager.get(id)) await this.manager.stop(id);
    const stopped = this.tasks.get(id);
    if (!stopped) throw new CoreError("DASHBOARD_AGENT_TASK_NOT_FOUND", "That dashboard agent task is no longer available.");
    return { ...stopped, process: { ...stopped.process, logs: stopped.process.logs.map((entry) => ({ ...entry })) } };
  }

  async writeTerminal(id: string, input: string): Promise<DashboardAgentTask> {
    const process = await this.manager.write(id, input);
    this.updateProcess(process);
    const task = this.tasks.get(id);
    if (!task) throw new CoreError("DASHBOARD_AGENT_TASK_NOT_FOUND", "That dashboard agent task is no longer available.");
    return { ...task, process: { ...task.process, logs: task.process.logs.map((entry) => ({ ...entry })) } };
  }

  async resizeTerminal(id: string, cols: number, rows: number): Promise<DashboardAgentTask> {
    const process = await this.manager.resize(id, cols, rows);
    this.updateProcess(process);
    const task = this.tasks.get(id);
    if (!task) throw new CoreError("DASHBOARD_AGENT_TASK_NOT_FOUND", "That dashboard agent task is no longer available.");
    return { ...task, process: { ...task.process, logs: task.process.logs.map((entry) => ({ ...entry })) } };
  }

  markDashboardChanged(configPath: string): void {
    for (const task of this.tasks.values()) {
      if (task.configPath !== configPath || task.process.phase !== "running") continue;
      task.dashboardChanged = true;
      this.emit(task);
    }
  }

  setValidation(id: string, validation: DashboardAgentTask["validation"]): void {
    const task = this.tasks.get(id);
    if (!task) return;
    task.validation = validation;
    this.emit(task);
  }

  isCancelled(id: string): boolean {
    return this.closed || this.tasks.get(id)?.cancelled === true;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation);
    this.operation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  launch(options: LaunchComponentAgentOptions): Promise<ComponentAgentLaunch> {
    if (this.closed) throw new CoreError("DASHBOARD_AGENT_HARNESS_CLOSED", "The dashboard agent harness is closed.");
    return this.enqueue(async () => {
      if (this.closed) throw new CoreError("DASHBOARD_AGENT_HARNESS_CLOSED", "The dashboard agent harness is closed.");
      const prompt = options.prompt.trim();
      if (prompt.length === 0 || prompt.length > MAX_AGENT_PROMPT_LENGTH) {
        throw new CoreError(
          "COMPONENT_AGENT_PROMPT_INVALID",
          `The requested change must be between 1 and ${MAX_AGENT_PROMPT_LENGTH} characters after context is added.`,
        );
      }

      this.definitions = this.definitions.filter((definition) => {
        const phase = this.manager.get(definition.id)?.phase;
        return phase === "running" || phase === "stopping";
      });
      const id = `component-agent-${randomUUID()}`;
      const definition: ProcessDefinition = {
        id,
        // Agent work has a finite lifetime even though it uses a PTY. Replace
        // the interactive shell so the task finishes when the configured CLI
        // finishes; ordinary command terminals remain persistent.
        command: process.platform === "win32"
          ? `${componentAgentInvocation(options.command)}\nexit\n`
          : `exec /bin/sh -c '${componentAgentInvocation(options.command).replaceAll("'", "'\\''")}'`,
        interactive: true,
        // Do not source an arbitrary login shell: it may replace the PATH that
        // agent preflight just verified. The agent command itself still runs in
        // a PTY and retains its literal configured shell syntax.
        ...(process.platform === "win32" ? {} : { interactiveShell: ["/bin/sh", "-i"] }),
        projectRoot: options.projectRoot,
        env: {
          ...(options.env ?? {}),
          DASH_BORED_AGENT: options.command,
          DASH_BORED_AGENT_PROMPT: prompt,
          DASH_BORED_COMPONENT_PATH: options.componentPath,
          // POSIX sh may source ENV for an interactive terminal. Keep that
          // startup hook empty so it cannot replace the preflighted PATH.
          ...(process.platform === "win32" ? {} : { ENV: "/dev/null", BASH_ENV: "/dev/null" }),
        },
      };
      const task: DashboardAgentTask = {
        id,
        ...(options.purpose ? { purpose: options.purpose } : {}),
        command: options.command,
        prompt,
        componentPath: options.componentPath,
        request: options.request,
        configPath: options.configPath,
        startedAt: new Date().toISOString(),
        dashboardChanged: false,
        process: {
          id,
          phase: "idle",
          pid: null,
          exitCode: null,
          signal: null,
          logs: [],
        },
      };
      this.tasks.set(id, task);
      if (options.onFinished) this.finishers.set(id, options.onFinished);
      this.definitions.push(definition);
      await this.manager.reconcile(this.definitions);
      const launched = await this.manager.start(id);
      if (launched.phase === "failed") {
        throw new CoreError(
          "COMPONENT_AGENT_START_FAILED",
          launched.logs.at(-1)?.text ?? "The configured agent could not be started.",
        );
      }
      return {
        taskId: id,
        command: options.command,
        componentPath: options.componentPath,
        pid: launched.pid,
      };
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const task of this.tasks.values()) {
      if (task.process.phase === "running" || task.process.phase === "stopping") {
        task.cancelled = true;
        this.emit(task);
      }
    }
    await this.operation.catch(() => undefined);
    await this.manager.close();
  }
}

/** @deprecated Use DashboardAgentHarness. */
export const ComponentAgentRunner = DashboardAgentHarness;
