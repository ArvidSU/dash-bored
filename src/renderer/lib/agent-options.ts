import type {
  AgentCommandChoice,
  AgentCommandOptions,
} from "../../shared/agent-session";

/*
 * Agent pickers (the prompt composer and Settings) present the main process's
 * `AgentCommandOptions`. A picker value is a string so it fits a native
 * <select>; it maps one-to-one to an `AgentCommandChoice`.
 */

export type AgentPickerValue = "app" | "project" | "custom" | `detected:${string}`;

const DETECTED_PREFIX = "detected:";

export function detectedPickerValue(id: string): AgentPickerValue {
  return `${DETECTED_PREFIX}${id}`;
}

export function pickerValueForChoice(choice: AgentCommandChoice): AgentPickerValue {
  return choice.source === "detected" ? detectedPickerValue(choice.id) : choice.source;
}

export function choiceForPickerValue(value: AgentPickerValue, customCommand: string): AgentCommandChoice {
  if (value.startsWith(DETECTED_PREFIX)) return { source: "detected", id: value.slice(DETECTED_PREFIX.length) };
  if (value === "custom") return { source: "custom", command: customCommand.trim() };
  return { source: value as "app" | "project" };
}

/** The value an omitted choice resolves to, or null when no agent is configured or detected. */
export function effectivePickerValue(options: AgentCommandOptions | null): AgentPickerValue | null {
  const effective = options?.effective;
  if (!effective) return null;
  if (effective.source !== "detected") return effective.source;
  const match = options.detected.find((agent) => agent.command === effective.command);
  return match ? detectedPickerValue(match.id) : null;
}

/** The exact command a picker value runs; empty when that source is unset. */
export function commandForPickerValue(
  value: AgentPickerValue | null,
  options: AgentCommandOptions | null,
  customCommand: string,
): string {
  if (value === "custom") return customCommand.trim();
  if (!options || value === null) return "";
  if (value === "app") return options.app ?? "";
  if (value === "project") return options.project ?? "";
  const id = value.slice(DETECTED_PREFIX.length);
  return options.detected.find((agent) => agent.id === id)?.command ?? "";
}

/** Settings stores a command string (null returns selection to each bundle). */
export function settingsPickerValue(setting: string | null, options: AgentCommandOptions | null): AgentPickerValue | "bundle" {
  if (setting === null) return "bundle";
  const match = options?.detected.find((agent) => agent.command === setting.trim());
  return match ? detectedPickerValue(match.id) : "custom";
}

/** Remembered per viewer so a custom command survives reopening a picker. */
const CUSTOM_COMMAND_KEY = "dash-bored.agent-prompt.custom-command";

export function storedCustomAgentCommand(): string {
  try {
    return window.localStorage.getItem(CUSTOM_COMMAND_KEY) ?? "";
  } catch {
    return "";
  }
}

export function storeCustomAgentCommand(command: string): void {
  try {
    window.localStorage.setItem(CUSTOM_COMMAND_KEY, command);
  } catch {
    // Storage is a convenience; pickers work without it.
  }
}
