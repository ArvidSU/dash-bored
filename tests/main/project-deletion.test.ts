import { afterEach, describe, expect, test } from "bun:test";
import { access, readFile, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { ProjectRuntime, TrustStore } from "../../src/core";
import { deleteRegisteredProject } from "../../src/main/project-deletion";
import { ProjectRegistry } from "../../src/main/project-registry";
import type { DashboardConfig, ProjectSnapshot } from "../../src/shared/contracts";
import {
  createProject,
  defaultConfig,
  removeTemporaryDirectory,
  temporaryDirectory,
} from "../core/helpers";

const cleanup: string[] = [];
const runtimes: ProjectRuntime[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(cleanup.splice(0).map(removeTemporaryDirectory));
});

function snapshot(projectRoot: string, dashboardName: string | null): ProjectSnapshot {
  return {
    projectRoot,
    configPath: join(projectRoot, ".dash-bored", "dash-bored.yaml"),
    dashboardName,
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

async function setupRegisteredProject(
  root: string,
  name: string,
): Promise<{ canonicalRoot: string; registry: ProjectRegistry; runtime: ProjectRuntime; trustStore: TrustStore }> {
  const canonicalRoot = await realpath(root);
  const registry = new ProjectRegistry(join(root, ".state", "projects.json"));
  const trustStore = new TrustStore(join(root, ".state", "trust.json"));
  const runtime = new ProjectRuntime({ trustStore });
  runtimes.push(runtime);
  await registry.remember(snapshot(canonicalRoot, name));
  return { canonicalRoot, registry, runtime, trustStore };
}

const processConfig: DashboardConfig = {
  schemaVersion: 2,
  name: "Process dashboard",
  root: {
    component: "@dash-bored/group",
    children: {
      type: "tiled",
      layout: {
        type: "child",
        child: {
          node: {
            id: "server",
            component: "@dash-bored/command",
            props: { label: "Server", command: "sleep 30" },
          },
        },
      },
    },
  },
};

describe("registered dashboard deletion", () => {
  test("removes only the registry entry by default and persists the change", async () => {
    const root = await temporaryDirectory();
    cleanup.push(root);
    await createProject(root);
    const { canonicalRoot, registry, runtime, trustStore } = await setupRegisteredProject(root, "Keep files");
    const moved: string[] = [];

    const result = await deleteRegisteredProject({
      registry,
      runtime,
      trustStore,
      projectRoot: canonicalRoot,
      removeFiles: false,
      moveToTrash: (path) => {
        moved.push(path);
        return true;
      },
    });

    expect(result.projectRoot).toBeNull();
    expect(moved).toEqual([]);
    expect(await registry.list()).toEqual([]);
    expect(await new ProjectRegistry(join(root, ".state", "projects.json")).list()).toEqual([]);
    expect(await readFile(join(root, ".dash-bored", "dash-bored.yaml"), "utf8")).toContain("Test project");
  });

  test("unloads the active runtime, revokes trust, and moves only dash-bored/ to Trash", async () => {
    const root = await temporaryDirectory();
    cleanup.push(root);
    await createProject(root, processConfig);
    const { canonicalRoot, registry, runtime, trustStore } = await setupRegisteredProject(root, "Running dashboard");
    await runtime.load(canonicalRoot);
    await runtime.trust();
    await runtime.startProcess("server");
    expect(runtime.getSnapshot().processes[0]?.phase).toBe("running");
    const moved: string[] = [];

    const result = await deleteRegisteredProject({
      registry,
      runtime,
      trustStore,
      projectRoot: canonicalRoot,
      removeFiles: true,
      moveToTrash: async (path) => {
        moved.push(path);
        await rm(path, { recursive: true });
        return true;
      },
    });

    expect(result.projectRoot).toBeNull();
    expect(runtime.getSnapshot().processes).toEqual([]);
    expect(moved).toEqual([join(canonicalRoot, ".dash-bored")]);
    await expect(access(join(root, ".dash-bored"))).rejects.toThrow();
    expect(await trustStore.getGrant(canonicalRoot)).toBeNull();
    expect(await registry.list()).toEqual([]);
  });

  test("rolls back registry, trust, and runtime when moving files fails", async () => {
    const root = await temporaryDirectory();
    cleanup.push(root);
    await createProject(root, defaultConfig);
    const { canonicalRoot, registry, runtime, trustStore } = await setupRegisteredProject(root, "Rollback dashboard");
    await runtime.load(canonicalRoot);
    await runtime.trust();

    await expect(deleteRegisteredProject({
      registry,
      runtime,
      trustStore,
      projectRoot: canonicalRoot,
      removeFiles: true,
      moveToTrash: () => false,
    })).rejects.toMatchObject({ code: "PROJECT_FILES_TRASH_FAILED" });

    expect(await registry.list()).toEqual([{ projectRoot: canonicalRoot, configPath: join(canonicalRoot, ".dash-bored", "dash-bored.yaml"), dashboardName: "Rollback dashboard", iconDataUrl: null }]);
    expect(runtime.getSnapshot().projectRoot).toBe(canonicalRoot);
    expect(runtime.getSnapshot().trusted).toBeTrue();
    expect(await trustStore.getGrant(canonicalRoot)).not.toBeNull();
    expect(await readFile(join(root, ".dash-bored", "dash-bored.yaml"), "utf8")).toContain("Test project");
  });

  test("refuses file removal when dependency analysis is incomplete", async () => {
    const target = await temporaryDirectory();
    const source = await temporaryDirectory();
    cleanup.push(target, source);
    await createProject(target);
    await createProject(source, {
      schemaVersion: 2,
      name: "Broken source",
      root: { component: join((await realpath(target)), ".dash-bored", "missing") },
    });
    const targetSetup = await setupRegisteredProject(target, "Target");
    const sourceRoot = await realpath(source);
    await targetSetup.registry.remember(snapshot(sourceRoot, "Broken source"));
    let moved = false;

    await expect(deleteRegisteredProject({
      ...targetSetup,
      projectRoot: targetSetup.canonicalRoot,
      removeFiles: true,
      moveToTrash: () => {
        moved = true;
        return true;
      },
    })).rejects.toMatchObject({ code: "PROJECT_DELETE_ANALYSIS_INCOMPLETE" });

    expect(moved).toBeFalse();
    expect(await targetSetup.registry.contains(targetSetup.canonicalRoot)).toBeTrue();
    expect(await targetSetup.registry.contains(sourceRoot)).toBeTrue();
  });
});
