import { afterEach, describe, expect, test } from "bun:test";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { getRegisteredProjectOutline } from "../../src/main/project-outline";
import { ProjectRegistry } from "../../src/main/project-registry";
import type { ProjectSnapshot } from "../../src/shared/contracts";
import {
  createProject,
  removeTemporaryDirectory,
  temporaryDirectory,
} from "../core/helpers";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(removeTemporaryDirectory));
});

function snapshot(projectRoot: string): ProjectSnapshot {
  return {
    projectRoot,
    dashboardName: "Outline dashboard",
    iconDataUrl: null,
    config: null,
    configRevision: null,
    componentCatalog: [],
    trusted: false,
    requestedPermissions: [],
    tree: null,
    components: [],
    processes: [],
    diagnostics: [],
    revision: 1,
  };
}

describe("getRegisteredProjectOutline", () => {
  test("loads the complete resolved tree without activating the project runtime", async () => {
    const directory = await temporaryDirectory();
    cleanup.push(directory);
    const projectRoot = join(directory, "project");
    await createProject(projectRoot, {
      schemaVersion: 1,
      name: "Outline dashboard",
      root: {
        id: "layout",
        component: "@dash-bored/stack",
        slots: {
          children: [
            { id: "welcome", component: "@dash-bored/text", props: { content: "Welcome" } },
            { id: "status", component: "@dash-bored/status", props: { label: "API", state: "healthy" } },
          ],
        },
      },
    });
    const registry = new ProjectRegistry(join(directory, "projects-v1.json"));
    await registry.remember(snapshot(projectRoot));

    const outline = await getRegisteredProjectOutline(registry, projectRoot);

    expect(outline.projectRoot).toBe(await realpath(projectRoot));
    expect(outline.dashboardName).toBe("Outline dashboard");
    expect(outline.tree?.id).toBe("layout");
    expect(outline.tree?.slots.children?.map((node) => node.id)).toEqual(["welcome", "status"]);
    expect(outline.diagnostics).toEqual([]);
  });

  test("rejects projects that are not in sidebar navigation", async () => {
    const directory = await temporaryDirectory();
    cleanup.push(directory);
    const registry = new ProjectRegistry(join(directory, "projects-v1.json"));

    await expect(getRegisteredProjectOutline(registry, join(directory, "unknown"))).rejects.toMatchObject({
      code: "PROJECT_NOT_REGISTERED",
    });
  });
});
