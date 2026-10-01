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
}

export async function initializeProject(
  projectInput = ".",
  configName = ".",
): Promise<InitResult> {
  const result = configName === "."
    ? await initializeProjectFiles(projectInput)
    : await initializeNamedProjectFiles(projectInput, configName);
  return {
    projectRoot: result.location.projectRoot,
    configPath: result.location.configPath,
    lockPath: result.location.lockPath,
    environmentPath: result.environmentPath,
    readmePath: result.readmePath,
    installerPath: result.installerPath,
    componentsPath: result.location.componentsDirectory,
  };
}
