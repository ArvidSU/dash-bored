import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { writeFileAtomically } from "../core/fs-atomic";
import type { AgentConfigChoices, AgentConfigOption, RememberedAgentConfig } from "../shared/agent-session";
import { MAX_CONFIG_OPTIONS } from "./agent-session-updates";

const VERSION = 1;
export const MAX_REMEMBERED_AGENTS = 10;

interface Entry extends RememberedAgentConfig {
  usedAt: string;
}

function isChoiceValue(value: unknown): value is string | boolean {
  return typeof value === "string" || typeof value === "boolean";
}

function isOption(value: unknown): value is AgentConfigOption {
  const option = value as AgentConfigOption | null;
  return typeof option === "object" && option !== null
    && typeof option.id === "string" && typeof option.name === "string"
    && (option.type === "boolean" || (option.type === "select" && Array.isArray(option.options)
      && option.options.every((choice) => typeof choice?.value === "string" && typeof choice.name === "string")))
    && isChoiceValue(option.currentValue);
}

function isEntry(value: unknown): value is Entry {
  const entry = value as Entry | null;
  return typeof entry === "object" && entry !== null && typeof entry.usedAt === "string"
    && Array.isArray(entry.options) && entry.options.length <= MAX_CONFIG_OPTIONS && entry.options.every(isOption)
    && typeof entry.chosen === "object" && entry.chosen !== null && !Array.isArray(entry.chosen)
    && Object.values(entry.chosen).every(isChoiceValue);
}

/**
 * Per launch command: the config options the agent offered when the app last
 * created a session with it, and the composer's last choices. ACP lists
 * options only once a session exists, so this is how the composer can offer
 * them before the first prompt. It is a convenience: a missing or unreadable
 * file starts empty, and a failed write keeps the memory in this app session.
 */
export class AgentConfigMemory {
  private entries: Map<string, Entry> | null = null;
  private loadPromise: Promise<void> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async get(): Promise<Record<string, RememberedAgentConfig>> {
    await this.load();
    return Object.fromEntries([...this.entries!].map(([command, { options, chosen }]) => [command, structuredClone({ options, chosen })]));
  }

  /** A session was created with `command` and offered `options`. */
  offered(command: string, options: readonly AgentConfigOption[]): Promise<void> {
    return this.change(command, (entry) => ({ options: structuredClone([...options]), chosen: entry?.chosen ?? {} }));
  }

  /** The composer launched `command` with `choices`; they replace the previous choices. */
  chose(command: string, choices: AgentConfigChoices): Promise<void> {
    return this.change(command, (entry) => ({ options: entry?.options ?? [], chosen: { ...choices } }));
  }

  private load(): Promise<void> {
    this.loadPromise ??= (async () => {
      this.entries = new Map();
      try {
        const stored = JSON.parse(await readFile(this.path, "utf8")) as { version?: unknown; agents?: unknown };
        if (stored.version !== VERSION || typeof stored.agents !== "object" || stored.agents === null) return;
        for (const [command, entry] of Object.entries(stored.agents)) {
          if (isEntry(entry)) this.entries.set(command, entry);
        }
      } catch {
        // Remembered options are a convenience; start without them.
      }
    })();
    return this.loadPromise;
  }

  private async change(command: string, next: (entry: Entry | undefined) => RememberedAgentConfig): Promise<void> {
    await this.load();
    const entries = this.entries!;
    const entry = { ...next(entries.get(command)), usedAt: new Date().toISOString() };
    // Most recently used last, so the oldest commands are forgotten first.
    entries.delete(command);
    entries.set(command, entry);
    for (const stale of [...entries.keys()].slice(0, Math.max(0, entries.size - MAX_REMEMBERED_AGENTS))) entries.delete(stale);
    const contents = `${JSON.stringify({ version: VERSION, agents: Object.fromEntries(entries) }, null, 2)}\n`;
    const write = async () => {
      await mkdir(dirname(this.path), { recursive: true });
      await writeFileAtomically(this.path, contents, { mode: 0o600 });
    };
    this.writeQueue = this.writeQueue.then(write, write).catch((error: unknown) => {
      console.error("Could not remember agent config options.", error);
    });
    await this.writeQueue;
  }
}
