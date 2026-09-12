import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";

export interface BundledToolEnvironment {
  toolsDirectory: string;
  appExecutable: string;
}

interface DesktopExecutableEnvironmentOptions {
  homeDirectory?: string;
  platform?: NodeJS.Platform;
}

function appendPathEntries(environment: NodeJS.ProcessEnv, additions: readonly string[]): void {
  const entries = (environment.PATH ?? "").split(delimiter).filter(Boolean);
  for (const entry of additions) {
    if (entry !== "" && !entries.includes(entry)) entries.push(entry);
  }
  environment.PATH = entries.join(delimiter);
}

/**
 * Finder-launched desktop apps receive a minimal PATH. Add conventional
 * user-owned CLI locations without evaluating login-shell configuration.
 * This keeps the configured dashboard agent portable while leaving arbitrary
 * custom locations opt-in through an absolute command in Settings.
 */
export function configureDesktopExecutableEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  options: DesktopExecutableEnvironmentOptions = {},
): void {
  const homeDirectory = options.homeDirectory ?? homedir();
  const platform = options.platform ?? process.platform;
  const userBins = [
    join(homeDirectory, ".local", "bin"),
    join(homeDirectory, ".bun", "bin"),
    join(homeDirectory, ".cargo", "bin"),
    join(homeDirectory, ".npm-global", "bin"),
    join(homeDirectory, ".local", "share", "pnpm"),
  ];
  const platformBins = platform === "darwin"
    ? [join(homeDirectory, "Library", "pnpm"), "/opt/homebrew/bin", "/usr/local/bin"]
    : platform === "win32"
      ? [join(homeDirectory, "AppData", "Roaming", "npm"), join(homeDirectory, "AppData", "Local", "pnpm")]
      : ["/usr/local/bin"];
  appendPathEntries(environment, [...userBins, ...platformBins]);
}

/** Makes app-bundled tools visible to every command launched by the dashboard. */
export function configureBundledToolEnvironment(
  mainDirectory: string,
  environment: NodeJS.ProcessEnv = process.env,
): BundledToolEnvironment | null {
  const toolsDirectory = resolve(mainDirectory, "..", "tools");
  const cliPath = join(toolsDirectory, process.platform === "win32" ? "dash-bored.exe" : "dash-bored");
  if (!existsSync(cliPath)) return null;

  const entries = (environment.PATH ?? "").split(delimiter).filter(Boolean);
  if (!entries.includes(toolsDirectory)) environment.PATH = [toolsDirectory, ...entries].join(delimiter);
  const appExecutable = process.platform === "win32"
    ? resolve(mainDirectory, "..", "..", "..", "dash-bored.exe")
    : process.platform === "darwin"
      ? resolve(mainDirectory, "..", "..", "..", "MacOS", "launcher")
      : resolve(mainDirectory, "..", "..", "..", "dash-bored");
  environment.DASH_BORED_APP_EXECUTABLE = appExecutable;
  return { toolsDirectory, appExecutable };
}
