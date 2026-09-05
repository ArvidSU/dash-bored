import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { installDashBoredCli } from "../cli/install-cli";
import { installDashBoredSkill } from "../cli/install-skill";
import { APP_VERSION } from "../shared/app-metadata";
import type { Diagnostic } from "../shared/contracts";

export interface InstalledToolsOptions {
  cliPath?: string;
  homeDirectory?: string;
  projectRoots?: string[];
  /** Select only project skills when a dashboard is opened later. */
  includeGlobal?: boolean;
}

/** Refresh only artifacts the user has already chosen to install. */
export async function updateInstalledTools(options: InstalledToolsOptions): Promise<Diagnostic[]> {
  const home = options.homeDirectory ?? homedir();
  const diagnostics: Diagnostic[] = [];
  const jobs: { path: string; update: () => Promise<boolean> }[] = [];
  const roots = new Set(options.projectRoots ?? []);
  if (options.includeGlobal !== false) roots.add(home);
  for (const root of roots) {
    jobs.push({
      path: join(root, ".agents", "skills", "dash-bored"),
      update: async () => {
        const result = await installDashBoredSkill(root);
        return result.created.length + result.updated.length + result.linked.length > 0;
      },
    });
  }
  if (options.cliPath && options.includeGlobal !== false && process.platform !== "win32") {
    jobs.push({
      path: join(home, ".local", "bin", "dash-bored"),
      update: async () => {
        const result = await installDashBoredCli({ sourcePath: options.cliPath, targetDirectory: join(home, ".local", "bin") });
        return result.created || result.updated;
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
      if (await job.update()) diagnostics.push({ severity: "info", code: "INSTALLED_TOOL_UPDATED", file: job.path, message: `Updated installed dash-bored guidance or CLI to ${APP_VERSION}.` });
    } catch (error) {
      diagnostics.push({ severity: "warning", code: "INSTALLED_TOOL_UPDATE_CONFLICT", file: job.path, message: `Could not update installed dash-bored tool: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  return diagnostics;
}
