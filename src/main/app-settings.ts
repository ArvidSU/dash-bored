import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { CoreError } from "../core/diagnostics";
import type { AppSettings } from "../shared/contracts";

export const DEFAULT_DASH_BORED_AGENT = "codex exec";
const MAX_AGENT_COMMAND_LENGTH = 1_024;

interface StoredAppSettings extends AppSettings {
  version: 1;
}

export function normalizeDashBoredAgent(value: unknown): string {
  if (typeof value !== "string") {
    throw new CoreError("APP_SETTINGS_INVALID", "DASH_BORED_AGENT must be a command string.");
  }
  const command = value.trim();
  if (command.length === 0 || command.length > MAX_AGENT_COMMAND_LENGTH) {
    throw new CoreError(
      "APP_SETTINGS_INVALID",
      `DASH_BORED_AGENT must be between 1 and ${MAX_AGENT_COMMAND_LENGTH} characters.`,
    );
  }
  return command;
}

export class AppSettingsStore {
  private settings: AppSettings | null = null;
  private loadPromise: Promise<void> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly defaultAgent: string;

  constructor(
    private readonly path: string,
    defaultAgent = process.env.DASH_BORED_AGENT?.trim() || DEFAULT_DASH_BORED_AGENT,
  ) {
    this.defaultAgent = normalizeDashBoredAgent(defaultAgent);
  }

  private load(): Promise<void> {
    this.loadPromise ??= (async () => {
      this.settings = { dashBoredAgent: this.defaultAgent };
      try {
        const candidate = JSON.parse(await readFile(this.path, "utf8")) as Partial<StoredAppSettings>;
        if (candidate.version !== 1) return;
        this.settings = {
          dashBoredAgent: normalizeDashBoredAgent(candidate.dashBoredAgent),
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          // Invalid settings fall back to a usable default without blocking app startup.
          this.settings = { dashBoredAgent: this.defaultAgent };
        }
      }
    })();
    return this.loadPromise;
  }

  private enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(operation, operation);
    this.writeQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async get(): Promise<AppSettings> {
    await this.load();
    await this.writeQueue;
    return structuredClone(this.settings!);
  }

  async update(settings: AppSettings): Promise<AppSettings> {
    await this.load();
    const next: AppSettings = {
      dashBoredAgent: normalizeDashBoredAgent(settings.dashBoredAgent),
    };
    return this.enqueueWrite(async () => {
      const previous = this.settings!;
      this.settings = next;
      const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await mkdir(dirname(this.path), { recursive: true });
        await writeFile(
          temporaryPath,
          `${JSON.stringify({ version: 1, ...next }, null, 2)}\n`,
          { mode: 0o600 },
        );
        await rename(temporaryPath, this.path);
        return structuredClone(next);
      } catch (error) {
        this.settings = previous;
        throw error;
      } finally {
        await unlink(temporaryPath).catch(() => undefined);
      }
    });
  }
}
