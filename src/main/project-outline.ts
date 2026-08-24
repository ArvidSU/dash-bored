import {
  CoreError,
  loadProjectDefinition,
  resolveProjectLocation,
} from "../core/index";
import { join } from "node:path";
import type { ProjectOutline } from "../shared/contracts";
import type { ProjectRegistry } from "./project-registry";

export async function getRegisteredProjectOutline(
  registry: ProjectRegistry,
  projectRoot: string,
  configPath = join(projectRoot, "dash-bored", "dash-bored.yaml"),
): Promise<ProjectOutline> {
  if (!(await registry.contains(projectRoot, configPath))) {
    throw new CoreError(
      "PROJECT_NOT_REGISTERED",
      "Choose this project through Add dashboard before inspecting it from the sidebar.",
    );
  }

  const location = await resolveProjectLocation(configPath);
  const definition = await loadProjectDefinition(location);
  return {
    projectRoot: location.projectRoot,
    configPath: location.configPath,
    dashboardName: definition.config?.name ?? null,
    tree: definition.tree,
    diagnostics: definition.diagnostics,
  };
}
