import { existsSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";

export interface BundledToolEnvironment {
  cliPath: string;
  toolsDirectory: string;
  appExecutable: string;
}

/** Makes app-bundled tools visible to every command launched by the dashboard. */
export function configureBundledToolEnvironment(
  mainDirectory: string,
  environment: NodeJS.ProcessEnv = process.env,
): BundledToolEnvironment | null {
  const toolsDirectory = resolve(mainDirectory, "..", "tools");
  const cliPath = join(toolsDirectory, process.platform === "win32" ? "dash-bored.exe" : "dash-bored");
  if (!existsSync(cliPath)) return null;

  const existingPath = environment.PATH ?? "";
  const entries = existingPath.split(delimiter).filter(Boolean);
  if (!entries.includes(toolsDirectory)) {
    environment.PATH = [toolsDirectory, ...entries].join(delimiter);
  }
  environment.DASH_BORED_BUNDLED_CLI = cliPath;

  const appExecutable = process.platform === "win32"
    ? resolve(mainDirectory, "..", "..", "..", "dash-bored.exe")
    : process.platform === "darwin"
      ? resolve(mainDirectory, "..", "..", "..", "MacOS", "launcher")
      : resolve(mainDirectory, "..", "..", "..", "dash-bored");
  environment.DASH_BORED_APP_EXECUTABLE = appExecutable;
  return { cliPath, toolsDirectory, appExecutable };
}
