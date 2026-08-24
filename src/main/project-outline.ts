import {
  CoreError,
  loadProjectDefinition,
  resolveProjectLocation,
} from "../core/index";
import type { ProjectOutline } from "../shared/contracts";
import type { ProjectRegistry } from "./project-registry";

export async function getRegisteredProjectOutline(
  registry: ProjectRegistry,
  projectRoot: string,
): Promise<ProjectOutline> {
  if (!(await registry.contains(projectRoot))) {
    throw new CoreError(
      "PROJECT_NOT_REGISTERED",
      "Choose this project through Add dashboard before inspecting it from the sidebar.",
    );
  }

  const location = await resolveProjectLocation(projectRoot, {
    inputKind: "project-root",
  });
  const definition = await loadProjectDefinition(location);
  return {
    projectRoot: location.projectRoot,
    dashboardName: definition.config?.name ?? null,
    tree: definition.tree,
    diagnostics: definition.diagnostics,
  };
}
