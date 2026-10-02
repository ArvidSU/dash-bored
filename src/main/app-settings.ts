import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { writeFileAtomically } from "../core/fs-atomic";
import { CoreError } from "../core/diagnostics";
import type { AppSettings } from "../shared/contracts";
import {
  cloneDefaultAppSettings,
  DEFAULT_DASH_BORED_AGENT,
} from "../shared/app-settings";
import { normalizeKeyboardShortcut } from "../shared/keyboard-shortcut";
import { isAppThemeReference } from "../shared/themes";
import { isLegacyAppThemeReference } from "../migrations/app-theme-reference";

export { DEFAULT_DASH_BORED_AGENT };
const MAX_AGENT_COMMAND_LENGTH = 1_024;

interface StoredAppSettings extends Partial<AppSettings> {
  version: 1 | 2;
}

export { DEFAULT_COMMAND_PALETTE_SHORTCUT, DEFAULT_ACTION_SHORTCUTS } from "../shared/app-settings";

function defaults(dashBoredAgent: string): AppSettings {
  return {
    ...cloneDefaultAppSettings(),
    dashBoredAgent,
  };
}

function normalizeActionIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.trim()))];
}

function normalizeActionShortcuts(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [id, candidate] of Object.entries(value)) {
    const shortcut = normalizeKeyboardShortcut(candidate);
    if (id.trim() && shortcut) result[id.trim()] = shortcut;
  }
  return result;
}

function normalizeSettings(value: Partial<AppSettings>, defaultAgent: string): AppSettings {
  const fallback = defaults(defaultAgent);
  const paletteShortcut = value.commandPaletteShortcut === null
    ? null
    : normalizeKeyboardShortcut(value.commandPaletteShortcut) ?? fallback.commandPaletteShortcut;
  const actionShortcuts = value.actionShortcuts === undefined
    ? fallback.actionShortcuts
    : normalizeActionShortcuts(value.actionShortcuts);
  for (const [id, shortcut] of Object.entries(actionShortcuts)) {
    if (shortcut === paletteShortcut) delete actionShortcuts[id];
  }
  const seen = new Set<string>();
  for (const [id, shortcut] of Object.entries(actionShortcuts)) {
    if (seen.has(shortcut)) delete actionShortcuts[id];
    else seen.add(shortcut);
  }
  return {
    // Legacy ./themes references remain readable until main pins them to
    // their owning dashboard (src/migrations/app-theme-reference.ts).
    theme: typeof value.theme === "string" && (isAppThemeReference(value.theme) || isLegacyAppThemeReference(value.theme))
      ? value.theme
      : fallback.theme,
    themeMode: value.themeMode === "light" || value.themeMode === "system" ? value.themeMode : fallback.themeMode,
    dashBoredAgent: value.dashBoredAgent === null
      ? null
      : normalizeDashBoredAgent(value.dashBoredAgent ?? defaultAgent),
    sidebarExpandedByDefault: value.sidebarExpandedByDefault === true,
    favoriteActionIds: normalizeActionIds(value.favoriteActionIds),
    commandPaletteShortcut: paletteShortcut,
    clearPaletteInputOnKeepOpen: value.clearPaletteInputOnKeepOpen !== false,
    actionShortcuts,
  };
}

/** Resolve the command used for an agent launch after app settings and bundle environment are merged. */
export function resolveDashBoredAgent(
  appSetting: string | null,
  environment: Readonly<Record<string, string>>,
): string {
  if (appSetting !== null) return appSetting;
  return environment.DASH_BORED_AGENT?.trim() || DEFAULT_DASH_BORED_AGENT;
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
      this.settings = defaults(this.defaultAgent);
      try {
        const candidate = JSON.parse(await readFile(this.path, "utf8")) as Partial<StoredAppSettings>;
        if (candidate.version !== 1 && candidate.version !== 2) return;
        this.settings = normalizeSettings(candidate, this.defaultAgent);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          // Invalid settings fall back to a usable default without blocking app startup.
          this.settings = defaults(this.defaultAgent);
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
    const next = normalizeSettings(settings, this.defaultAgent);
    return this.enqueueWrite(async () => {
      const previous = this.settings!;
      this.settings = next;
      try {
        await mkdir(dirname(this.path), { recursive: true });
        await writeFileAtomically(
          this.path,
          `${JSON.stringify({ version: 2, ...next }, null, 2)}\n`,
          { mode: 0o600 },
        );
        return structuredClone(next);
      } catch (error) {
        this.settings = previous;
        throw error;
      }
    });
  }
}
