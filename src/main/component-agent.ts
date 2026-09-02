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
  command: string;
  prompt: string;
  projectRoot: string;
  componentPath: string;
  configPath: string;
  request: string;
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
    this.pruneCompletedTasks();
  }

  private pruneCompletedTasks(): void {
    const completed = [...this.tasks.values()]
      .filter((task) => task.process.phase === "exited" || task.process.phase === "failed")
      .sort((left, right) => (right.startedAt ?? "").localeCompare(left.startedAt ?? ""));
    for (const task of completed.slice(MAX_COMPLETED_AGENT_TASKS)) this.tasks.delete(task.id);
  }

  list(): DashboardAgentTask[] {
    return [...this.tasks.values()]
      .sort((left, right) => (right.startedAt ?? "").localeCompare(left.startedAt ?? ""))
      .map((task) => ({ ...task, process: { ...task.process, logs: task.process.logs.map((entry) => ({ ...entry })) } }));
  }

  async stop(id: string): Promise<DashboardAgentTask> {
    await this.manager.stop(id);
    const task = this.tasks.get(id);
    if (!task) throw new CoreError("DASHBOARD_AGENT_TASK_NOT_FOUND", "That dashboard agent task is no longer available.");
    return { ...task, process: { ...task.process, logs: task.process.logs.map((entry) => ({ ...entry })) } };
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

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation);
    this.operation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  launch(options: LaunchComponentAgentOptions): Promise<ComponentAgentLaunch> {
    return this.enqueue(async () => {
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
        command: componentAgentInvocation(options.command),
        interactive: true,
        projectRoot: options.projectRoot,
        env: {
          DASH_BORED_AGENT: options.command,
          DASH_BORED_AGENT_PROMPT: prompt,
          DASH_BORED_COMPONENT_PATH: options.componentPath,
        },
      };
      const task: DashboardAgentTask = {
        id,
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
    await this.operation.catch(() => undefined);
    await this.manager.close();
  }
}

/** @deprecated Use DashboardAgentHarness. */
export const ComponentAgentRunner = DashboardAgentHarness;
