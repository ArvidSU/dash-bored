import { afterEach, describe, expect, test } from "bun:test";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { getRegisteredProjectOutline } from "../../src/main/project-outline";
import { ProjectRegistry } from "../../src/main/project-registry";
import type { ProjectSnapshot, ResolvedComponentNode } from "../../src/shared/contracts";
import {
  createProject,
  removeTemporaryDirectory,
  temporaryDirectory,
} from "../core/helpers";

const cleanup: string[] = [];

function resolvedChildren(node: ResolvedComponentNode | null | undefined): ResolvedComponentNode[] {
  const children = node?.children;
  if (children === undefined) return [];
  if (children.type === "managed") return children.items.map((edge) => edge.node);
  const nodes: ResolvedComponentNode[] = [];
  const visit = (layout: typeof children.layout): void => {
    if (layout.type === "child") nodes.push(layout.child.node);
    else {
      visit(layout.first);
      visit(layout.second);
    }
  };
  visit(children.layout);
  return nodes;
}

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
      schemaVersion: 2,
      name: "Outline dashboard",
      root: {
        id: "layout",
        component: "@dash-bored/group",
        children: {
          type: "tiled",
          layout: {
            type: "split",
            axis: "vertical",
            ratio: 0.5,
            first: {
              type: "child",
              child: {
                node: { id: "welcome", component: "@dash-bored/text", props: { content: "Welcome" } },
              },
            },
            second: {
              type: "child",
              child: {
                node: { id: "status", component: "@dash-bored/status", props: { label: "API", state: "healthy" } },
              },
            },
          },
        },
      },
    });
    const registry = new ProjectRegistry(join(directory, "projects-v1.json"));
    await registry.remember(snapshot(projectRoot));

    const outline = await getRegisteredProjectOutline(registry, projectRoot);

    expect(outline.projectRoot).toBe(await realpath(projectRoot));
    expect(outline.dashboardName).toBe("Outline dashboard");
    expect(outline.tree?.id).toBe("layout");
    expect(outline.tree?.children).toMatchObject({
      type: "tiled",
      layout: { type: "split", axis: "vertical", ratio: 0.5 },
    });
    expect(resolvedChildren(outline.tree).map((node) => node.id)).toEqual(["welcome", "status"]);
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
