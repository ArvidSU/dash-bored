import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { installDashBoredSkill } from "../cli/install-skill";
import type { Diagnostic, ProjectSnapshot } from "../shared/contracts";
import { CoreError, errorMessage } from "../core/diagnostics";
import { exists } from "../core/paths";

export function installedSkillPath(root: string): string {
  return join(root, ".agents", "skills", "dash-bored");
}

export interface InstalledToolsOptions {
  homeDirectory?: string;
  projectRoots?: string[];
  /** Select only project skills when a dashboard is opened later. */
  includeGlobal?: boolean;
}

export interface RepairInstalledToolsOptions {
  homeDirectory?: string;
  repairGlobalSkill?: boolean;
  projectRoots?: string[];
  /** Move a path to the operating system Trash and report whether it moved. */
  moveToTrash: (path: string) => boolean | Promise<boolean>;
}

async function moveToTrashIfPresent(
  path: string,
  moveToTrash: RepairInstalledToolsOptions["moveToTrash"],
): Promise<void> {
  if (!await exists(path)) return;
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
  await moveToTrashIfPresent(join(root, ".claude", "skills", "dash-bored"), moveToTrash);
  await moveToTrashIfPresent(installedSkillPath(root), moveToTrash);
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
  const roots = new Set(options.projectRoots ?? []);
  if (options.includeGlobal !== false) roots.add(home);
  for (const root of roots) {
    const path = installedSkillPath(root);
    try {
      // lstat includes conflicting paths and broken links, which need a visible report.
      if (!await exists(path)) continue;
      await installDashBoredSkill(root);
    } catch (error) {
      diagnostics.push({ severity: "warning", code: "INSTALLED_TOOL_UPDATE_CONFLICT", file: path, message: `Could not update the installed dash-bored skill: ${errorMessage(error)}` });
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
  const roots = new Set([...(options.repairGlobalSkill ? [home] : []), ...(options.projectRoots ?? [])]);
  const diagnostics: Diagnostic[] = [];
  for (const root of roots) {
    try {
      await removeSkillInstallation(root, options.moveToTrash);
      await installDashBoredSkill(root);
    } catch (error) {
      diagnostics.push({
        severity: "warning",
        code: "INSTALLED_TOOL_UPDATE_CONFLICT",
        file: installedSkillPath(root),
        message: `Could not remove and reinstall the conflicting dash-bored skill: ${errorMessage(error)}`,
      });
    }
  }
  return diagnostics;
}

function installedSkillRootFromDiagnostic(file: string): string | null {
  const resolvedFile = resolve(file);
  const root = resolve(resolvedFile, "..", "..", "..");
  return installedSkillPath(root) === resolvedFile ? root : null;
}

/**
 * The app's installed-tool warnings. The global skill and every project root
 * are refreshed once per run, and the warnings ride on every snapshot.
 */
export class InstalledToolDiagnostics {
  private readonly diagnostics: Diagnostic[] = [];
  private readonly checkedRoots = new Set<string>();

  constructor(private readonly options: {
    moveToTrash: RepairInstalledToolsOptions["moveToTrash"];
    /** The warnings changed outside a snapshot the runtime is about to publish. */
    onChange(): void;
  }) {}

  async refreshRegistered(projectRoots: readonly string[], options: { includeGlobal?: boolean } = {}): Promise<void> {
    for (const root of projectRoots) this.checkedRoots.add(root);
    this.diagnostics.push(...await updateInstalledTools({ projectRoots: [...projectRoots], ...options }));
  }

  /** Refreshes a newly opened project's skill once per run. */
  checkProject(projectRoot: string): void {
    if (this.checkedRoots.has(projectRoot)) return;
    this.checkedRoots.add(projectRoot);
    void updateInstalledTools({ projectRoots: [projectRoot], includeGlobal: false }).then((diagnostics) => {
      this.diagnostics.push(...diagnostics);
      if (diagnostics.length) this.options.onChange();
    });
  }

  addTo(snapshot: ProjectSnapshot): ProjectSnapshot {
    return { ...snapshot, diagnostics: [...snapshot.diagnostics, ...this.diagnostics] };
  }

  /** Moves conflicting skills to Trash and reinstalls them. */
  async repairConflicts(): Promise<{ conflictsRemain: boolean }> {
    const home = resolve(homedir());
    const globalSkillTarget = installedSkillPath(home);
    let repairGlobalSkill = false;
    const projectRoots = new Set<string>();

    for (const diagnostic of this.diagnostics) {
      if (diagnostic.code !== "INSTALLED_TOOL_UPDATE_CONFLICT" || !diagnostic.file) continue;
      const file = resolve(diagnostic.file);
      const skillRoot = installedSkillRootFromDiagnostic(file);
      if (skillRoot === null) continue;
      if (skillRoot === home || file === globalSkillTarget) repairGlobalSkill = true;
      else projectRoots.add(skillRoot);
    }

    if (!repairGlobalSkill && projectRoots.size === 0) {
      throw new CoreError(
        "INSTALLED_TOOL_CONFLICTS_NOT_FOUND",
        "There are no current installed-tool conflicts to repair.",
      );
    }
    const repairedPaths = [
      ...(repairGlobalSkill ? [globalSkillTarget] : []),
      ...[...projectRoots].map((root) => installedSkillPath(root)),
    ];
    const next = await repairInstalledTools({
      homeDirectory: home,
      repairGlobalSkill,
      projectRoots: [...projectRoots],
      moveToTrash: this.options.moveToTrash,
    });
    const replaced = new Set(repairedPaths.map((path) => resolve(path)));
    const retained = this.diagnostics.filter((diagnostic) =>
      diagnostic.file === undefined || !replaced.has(resolve(diagnostic.file)),
    );
    this.diagnostics.splice(0, this.diagnostics.length, ...retained, ...next);
    this.options.onChange();
    return { conflictsRemain: this.diagnostics.some((item) => item.code === "INSTALLED_TOOL_UPDATE_CONFLICT") };
  }
}
