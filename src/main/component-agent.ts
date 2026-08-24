import { randomUUID } from "node:crypto";
import { CoreError } from "../core/diagnostics";
import { ProcessManager, type ProcessDefinition } from "../core/process-manager";
import type { ComponentAgentLaunch } from "../shared/contracts";

const MAX_AGENT_PROMPT_LENGTH = 16_384;

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
}

export class ComponentAgentRunner {
  private readonly manager: ProcessManager;
  private definitions: ProcessDefinition[] = [];
  private operation: Promise<void> = Promise.resolve();

  constructor() {
    this.manager = new ProcessManager({ projectRoot: process.cwd() });
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
        projectRoot: options.projectRoot,
        env: {
          DASH_BORED_AGENT: options.command,
          DASH_BORED_AGENT_PROMPT: prompt,
          DASH_BORED_COMPONENT_PATH: options.componentPath,
        },
      };
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
