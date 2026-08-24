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

function snapshot(projectRoot: string, dashboardName: string | null): ProjectSnapshot {
  return {
    projectRoot,
    dashboardName,
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
    await registry.remember(snapshot(firstRoot, "Renamed dashboard"));

    expect(await registry.contains(firstRoot)).toBeTrue();
    expect(await registry.contains(join(directory, "unknown"))).toBeFalse();
    expect(await new ProjectRegistry(registryPath).list()).toEqual([
      { projectRoot: firstRoot, dashboardName: "Renamed dashboard" },
      { projectRoot: secondRoot, dashboardName: null },
    ]);
  });

  test("returns an empty list when the registry does not exist", async () => {
    const directory = await temporaryDirectory();
    cleanup.push(directory);
    const registry = new ProjectRegistry(join(directory, "missing", "projects-v1.json"));

    expect(await registry.list()).toEqual([]);
  });

  test("removes and restores a project with atomic persisted registry state", async () => {
    const directory = await temporaryDirectory();
    cleanup.push(directory);
    const registryPath = join(directory, "state", "projects-v1.json");
    const projectRoot = join(directory, "project");
    const item = { projectRoot, dashboardName: "Restore me" };
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
