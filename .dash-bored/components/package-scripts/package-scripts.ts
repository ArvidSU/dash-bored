export type PackageRunner = "bun" | "npm" | "pnpm" | "yarn";

export interface PackageScript {
  name: string;
  command: string;
}

export interface PackageScriptsInfo {
  name: string | null;
  version: string | null;
  packageManager: string | null;
  scripts: PackageScript[];
}

const ANSI_ESCAPE_PATTERN = /(?:\u001B\[[0-?]*[ -/]*[@-~]|\u001B\][^\u0007]*(?:\u0007|\u001B\\)|\u001B[()][0-2A-Z]|\u009B[0-?]*[ -/]*[@-~])/g;

export function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE_PATTERN, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parsePackageScripts(source: string): PackageScriptsInfo {
  const manifest = JSON.parse(source) as unknown;
  if (!isRecord(manifest)) {
    throw new Error("package.json must contain a JSON object.");
  }

  const rawScripts = manifest.scripts;
  if (rawScripts !== undefined && !isRecord(rawScripts)) {
    throw new Error("package.json scripts must be an object.");
  }

  const scripts = Object.entries(rawScripts ?? {})
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([name, command]) => ({ name, command }))
    .sort((left, right) => left.name.localeCompare(right.name));

  return {
    name: typeof manifest.name === "string" ? manifest.name : null,
    version: typeof manifest.version === "string" ? manifest.version : null,
    packageManager: typeof manifest.packageManager === "string" ? manifest.packageManager : null,
    scripts,
  };
}

export function packageRunner(
  packageManager: string | null | undefined,
  override?: PackageRunner,
): PackageRunner {
  if (override) return override;

  const name = packageManager?.trim().split(/[@\s]/u, 1)[0]?.toLowerCase();
  if (name === "bun" || name === "npm" || name === "pnpm" || name === "yarn") {
    return name;
  }
  return "npm";
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function packageScriptCommand(runner: PackageRunner, scriptName: string): string {
  const quotedName = shellQuote(scriptName);
  return runner === "yarn" ? `yarn run ${quotedName}` : `${runner} run ${quotedName}`;
}

export function packageWorkingDirectory(packageFile: string): string {
  const normalized = packageFile.trim().replaceAll("\\", "/");
  const separator = normalized.lastIndexOf("/");
  if (separator < 0) return ".";
  return normalized.slice(0, separator) || "/";
}

export function packageScriptActionId(index: number): string {
  return `run-package-script-${index + 1}`;
}

export function packageScriptOutput(stdout: string, stderr: string): string {
  const output = [stripAnsi(stdout).trimEnd(), stripAnsi(stderr).trimEnd()].filter(Boolean).join("\n");
  if (output.length <= 12_000) return output;
  return `…${output.slice(-12_000)}`;
}
