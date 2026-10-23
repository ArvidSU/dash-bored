import { restoreMissingPackages } from "../core/package-restore";
import {
  initializeNamedProjectFiles,
  initializeProjectFiles,
} from "../core/project-files";

export interface InitResult {
  projectRoot: string;
  configPath: string;
  lockPath: string;
  environmentPath: string;
  readmePath: string;
  installerPath: string;
  componentsPath: string;
  /** Set when an offline placeholder was written instead of the default dashboard. */
  warning?: string;
}

export async function initializeProject(
  projectInput = ".",
  configName = ".",
): Promise<InitResult> {
  const result = configName === "."
    ? await initializeProjectFiles(projectInput)
    : await initializeNamedProjectFiles(projectInput, configName);
  const unavailable = result.defaultDashboardUnavailable;
  // The placeholder needs no package; a failed restore is the reason it exists.
  const diagnostics = unavailable === undefined ? await restoreMissingPackages(result.location.configPath) : [];
  if (diagnostics.length) throw new Error(diagnostics.map((item) => item.message).join("; "));
  return {
    projectRoot: result.location.projectRoot,
    configPath: result.location.configPath,
    lockPath: result.location.lockPath,
    environmentPath: result.environmentPath,
    readmePath: result.readmePath,
    installerPath: result.installerPath,
    componentsPath: result.location.componentsDirectory,
    ...(unavailable === undefined ? {} : {
      warning: `The default dashboard could not be created, so dash-bored wrote an offline placeholder. Run dash-bored init again when online to replace it. Cause: ${unavailable}`,
    }),
  };
}
