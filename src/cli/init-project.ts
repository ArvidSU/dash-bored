import {
  initializeNamedProjectFiles,
  initializeProjectFiles,
} from "../core/project-files";

export interface InitResult {
  projectRoot: string;
  configPath: string;
  lockPath: string;
  environmentPath: string;
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
    componentsPath: result.location.componentsDirectory,
  };
}
