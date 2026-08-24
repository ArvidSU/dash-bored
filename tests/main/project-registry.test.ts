import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ProjectRegistry } from "../../src/main/project-registry";
import type { ProjectSnapshot } from "../../src/shared/contracts";
import {
  removeTemporaryDirectory,
  temporaryDirectory,
} from "../core/helpers";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(removeTemporaryDirectory));
});

function snapshot(
  projectRoot: string,
  dashboardName: string | null,
  iconDataUrl: string | null = null,
): ProjectSnapshot {
  return {
    projectRoot,
    configPath: join(projectRoot, "dash-bored", "dash-bored.yaml"),
    dashboardName,
    iconDataUrl,
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

describe("ProjectRegistry", () => {
  test("persists projects in insertion order and updates configured names", async () => {
    const directory = await temporaryDirectory();
    cleanup.push(directory);
    const registryPath = join(directory, "state", "projects-v1.json");
    const firstRoot = join(directory, "first");
    const secondRoot = join(directory, "second");
    const registry = new ProjectRegistry(registryPath);

    await registry.remember(snapshot(firstRoot, "First dashboard"));
    await registry.remember(snapshot(secondRoot, null));
    await registry.remember({
      ...snapshot(firstRoot, "Arvid dashboard"),
      configPath: join(firstRoot, "dash-bored", "arvid", "dash-bored.yaml"),
    });
    await registry.remember(snapshot(firstRoot, "Renamed dashboard"));

    expect(await registry.contains(firstRoot)).toBeTrue();
    expect(await registry.contains(firstRoot, join(firstRoot, "dash-bored", "arvid", "dash-bored.yaml"))).toBeTrue();
    expect(await registry.contains(join(directory, "unknown"))).toBeFalse();
    expect(await new ProjectRegistry(registryPath).list()).toEqual([
      { projectRoot: firstRoot, configPath: join(firstRoot, "dash-bored", "dash-bored.yaml"), dashboardName: "Renamed dashboard", iconDataUrl: null },
      { projectRoot: secondRoot, configPath: join(secondRoot, "dash-bored", "dash-bored.yaml"), dashboardName: null, iconDataUrl: null },
      { projectRoot: firstRoot, configPath: join(firstRoot, "dash-bored", "arvid", "dash-bored.yaml"), dashboardName: "Arvid dashboard", iconDataUrl: null },
    ]);
  });

  test("returns an empty list when the registry does not exist", async () => {
    const directory = await temporaryDirectory();
    cleanup.push(directory);
    const registry = new ProjectRegistry(join(directory, "missing", "projects-v1.json"));

    expect(await registry.list()).toEqual([]);
  });

  test("keeps icon data separate for named dashboards sharing a project root", async () => {
    const directory = await temporaryDirectory();
    cleanup.push(directory);
    const projectRoot = join(directory, "project");
    const namedConfigPath = join(projectRoot, "dash-bored", "arvid", "dash-bored.yaml");
    const registry = new ProjectRegistry(join(directory, "state", "projects-v1.json"));

    await registry.remember(snapshot(projectRoot, "Canonical", "data:image/svg+xml;base64,canonical"));
    await registry.remember({
      ...snapshot(projectRoot, "Arvid", "data:image/svg+xml;base64,arvid"),
      configPath: namedConfigPath,
    });

    expect(await registry.list()).toEqual([
      {
        projectRoot,
        configPath: join(projectRoot, "dash-bored", "dash-bored.yaml"),
        dashboardName: "Canonical",
        iconDataUrl: "data:image/svg+xml;base64,canonical",
      },
      {
        projectRoot,
        configPath: namedConfigPath,
        dashboardName: "Arvid",
        iconDataUrl: "data:image/svg+xml;base64,arvid",
      },
    ]);
  });

  test("removes and restores a project with atomic persisted registry state", async () => {
    const directory = await temporaryDirectory();
    cleanup.push(directory);
    const registryPath = join(directory, "state", "projects-v1.json");
    const projectRoot = join(directory, "project");
    const item = { projectRoot, configPath: join(projectRoot, "dash-bored", "dash-bored.yaml"), dashboardName: "Restore me", iconDataUrl: null };
    const registry = new ProjectRegistry(registryPath);

    await registry.remember(snapshot(projectRoot, item.dashboardName));
    expect(await registry.remove(projectRoot)).toEqual(item);
    expect(await registry.list()).toEqual([]);
    expect(await new ProjectRegistry(registryPath).list()).toEqual([]);

    await registry.restore(item);
    expect(await new ProjectRegistry(registryPath).list()).toEqual([item]);
    expect(await registry.remove(join(directory, "missing"))).toBeNull();
  });
});
