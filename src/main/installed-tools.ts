import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { installDashBoredCli } from "../cli/install-cli";
import { installDashBoredSkill } from "../cli/install-skill";
import type { Diagnostic } from "../shared/contracts";

const SKILL_DIRECTORY = [".agents", "skills", "dash-bored"] as const;
const CLAUDE_SKILL_DIRECTORY = [".claude", "skills", "dash-bored"] as const;

export function installedSkillPath(root: string): string {
  return join(root, ...SKILL_DIRECTORY);
}

export function installedClaudeSkillPath(root: string): string {
  return join(root, ...CLAUDE_SKILL_DIRECTORY);
}

export function installedCliPath(home: string): string {
  return join(home, ".local", "bin", "dash-bored");
}

export function installedCliReceiptPath(home: string): string {
  return join(home, ".local", "bin", ".dash-bored-cli.json");
}

export interface InstalledToolsOptions {
  cliPath?: string;
  homeDirectory?: string;
  projectRoots?: string[];
  /** Select only project skills when a dashboard is opened later. */
  includeGlobal?: boolean;
}

export interface RepairInstalledToolsOptions {
  /** The bundled CLI to install after the managed link is moved aside. */
  cliPath?: string;
  homeDirectory?: string;
  repairGlobalSkill?: boolean;
  repairCli?: boolean;
  projectRoots?: string[];
  /** Move a path to the operating system Trash and report whether it moved. */
  moveToTrash: (path: string) => boolean | Promise<boolean>;
}

async function moveToTrashIfPresent(
  path: string,
  moveToTrash: RepairInstalledToolsOptions["moveToTrash"],
): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!await moveToTrash(path)) {
    throw new Error(`The operating system could not move ${path} to Trash.`);
  }
}

async function removeSkillInstallation(
  root: string,
  moveToTrash: RepairInstalledToolsOptions["moveToTrash"],
): Promise<void> {
  // Move the alias before its canonical directory so the old alias never
  // points at a new installation while the repair is in progress.
  await moveToTrashIfPresent(installedClaudeSkillPath(root), moveToTrash);
  await moveToTrashIfPresent(installedSkillPath(root), moveToTrash);
}

async function removeCliInstallation(
  home: string,
  moveToTrash: RepairInstalledToolsOptions["moveToTrash"],
): Promise<void> {
  await moveToTrashIfPresent(installedCliPath(home), moveToTrash);
  await moveToTrashIfPresent(installedCliReceiptPath(home), moveToTrash);
}

/** Refresh only artifacts the user has already chosen to install.
 *
 * A successful refresh is maintenance, not a diagnostic. Only conflicts and
 * unexpected failures are returned so the diagnostics panel disappears once
 * the installed tools are healthy.
 */
export async function updateInstalledTools(options: InstalledToolsOptions): Promise<Diagnostic[]> {
  const home = options.homeDirectory ?? homedir();
  const diagnostics: Diagnostic[] = [];
  const jobs: { path: string; update: () => Promise<void> }[] = [];
  const roots = new Set(options.projectRoots ?? []);
  if (options.includeGlobal !== false) roots.add(home);
  for (const root of roots) {
    jobs.push({
      path: installedSkillPath(root),
      update: async () => {
        await installDashBoredSkill(root);
      },
    });
  }
  if (options.cliPath && options.includeGlobal !== false && process.platform !== "win32") {
    jobs.push({
      path: installedCliPath(home),
      update: async () => {
        await installDashBoredCli({ sourcePath: options.cliPath, targetDirectory: join(home, ".local", "bin") });
      },
    });
  }
  for (const job of jobs) {
    try {
      // lstat includes conflicting paths and broken links, which need a visible report.
      try { await lstat(job.path); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      await job.update();
    } catch (error) {
      diagnostics.push({ severity: "warning", code: "INSTALLED_TOOL_UPDATE_CONFLICT", file: job.path, message: `Could not update installed dash-bored tool: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  return diagnostics;
}

/**
 * Explicitly replace only the managed installs selected by the diagnostics UI.
 * The normal startup refresh remains non-destructive; this path is the user's
 * opt-in recovery action and keeps the previous files recoverable in Trash.
 */
export async function repairInstalledTools(options: RepairInstalledToolsOptions): Promise<Diagnostic[]> {
  const home = options.homeDirectory ?? homedir();
  const jobs: { path: string; remove: () => Promise<void>; update: () => Promise<void> }[] = [];
  const projectRoots = new Set(options.projectRoots ?? []);

  if (options.repairGlobalSkill) {
    jobs.push({
      path: installedSkillPath(home),
      remove: () => removeSkillInstallation(home, options.moveToTrash),
      update: async () => { await installDashBoredSkill(home); },
    });
  }
  for (const root of projectRoots) {
    if (options.repairGlobalSkill && root === home) continue;
    jobs.push({
      path: installedSkillPath(root),
      remove: () => removeSkillInstallation(root, options.moveToTrash),
      update: async () => { await installDashBoredSkill(root); },
    });
  }
  if (options.repairCli) {
    jobs.push({
      path: installedCliPath(home),
      remove: () => removeCliInstallation(home, options.moveToTrash),
      update: async () => {
        if (!options.cliPath) throw new Error("The bundled dash-bored CLI is unavailable.");
        if (process.platform === "win32") throw new Error("CLI link repair is not supported on Windows.");
        await installDashBoredCli({ sourcePath: options.cliPath, targetDirectory: join(home, ".local", "bin") });
      },
    });
  }

  const diagnostics: Diagnostic[] = [];
  for (const job of jobs) {
    try {
      await job.remove();
      await job.update();
    } catch (error) {
      diagnostics.push({
        severity: "warning",
        code: "INSTALLED_TOOL_UPDATE_CONFLICT",
        file: job.path,
        message: `Could not remove and reinstall the conflicting dash-bored tool: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  return diagnostics;
}
