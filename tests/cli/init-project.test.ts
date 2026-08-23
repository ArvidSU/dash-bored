import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { initializeProject } from "../../src/cli/init-project";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("initializeProject", () => {
  test("creates a valid welcome dashboard, lock, and component directory", async () => {
    const project = await mkdtemp(join(tmpdir(), "dash-bored-init-"));
    temporaryDirectories.push(project);

    const result = await initializeProject(project);
    const config = parse(await readFile(result.configPath, "utf8"));
    const lock = parse(await readFile(result.lockPath, "utf8"));

    expect(config.schemaVersion).toBe(1);
    expect(config.root.component).toBe("@dash-bored/stack");
    expect(config.root.slots.children[0].id).toBe("welcome");
    expect(lock).toEqual({ lockfileVersion: 1, components: {} });
    expect((await stat(result.componentsPath)).isDirectory()).toBe(true);
    expect((await readdir(join(project, "dash-bored"))).some((name) => name.endsWith(".tmp"))).toBeFalse();
  });

  test("never overwrites an existing initialization", async () => {
    const project = await mkdtemp(join(tmpdir(), "dash-bored-init-"));
    temporaryDirectories.push(project);
    await initializeProject(project);

    await expect(initializeProject(project)).rejects.toThrow("existing files were not overwritten");
  });

  test("creates a standalone named bundle and repairs a missing base bundle", async () => {
    const project = await mkdtemp(join(tmpdir(), "dash-bored-init-"));
    temporaryDirectories.push(project);

    const result = await initializeProject(project, "people/arvid");

    const canonicalProject = await realpath(project);
    expect(result.configPath).toBe(join(canonicalProject, "dash-bored", "people", "arvid", "dash-bored.yaml"));
    expect(parse(await readFile(result.configPath, "utf8")).name).toBe("arvid");
    expect(parse(await readFile(result.lockPath, "utf8"))).toEqual({ lockfileVersion: 1, components: {} });
    expect((await stat(result.componentsPath)).isDirectory()).toBeTrue();
    expect((await stat(join(project, "dash-bored", "dash-bored.yaml"))).isFile()).toBeTrue();
    expect((await stat(join(project, "dash-bored", "dash-bored-lock.yaml"))).isFile()).toBeTrue();
    expect((await stat(join(project, "dash-bored", "components"))).isDirectory()).toBeTrue();

    await expect(initializeProject(project, "people/arvid")).rejects.toThrow(
      "existing files were not overwritten",
    );
  });

  test("rejects unsafe named config paths", async () => {
    const project = await mkdtemp(join(tmpdir(), "dash-bored-init-"));
    temporaryDirectories.push(project);

    await expect(initializeProject(project, "../outside")).rejects.toThrow("Invalid config name");
    await expect(initializeProject(project, "components/private")).rejects.toThrow("Invalid config name");
  });

  test("preserves an existing base bundle while initializing a named bundle", async () => {
    const project = await mkdtemp(join(tmpdir(), "dash-bored-init-"));
    temporaryDirectories.push(project);
    const baseDirectory = join(project, "dash-bored");
    const baseConfig = "schemaVersion: 1\nname: Keep me\nroot:\n  component: '@dash-bored/markdown'\n  props:\n    content: custom\n";
    const baseLock = "lockfileVersion: 1\ncomponents: {}\n";
    await mkdir(join(baseDirectory, "components"), { recursive: true });
    await writeFile(join(baseDirectory, "dash-bored.yaml"), baseConfig);
    await writeFile(join(baseDirectory, "dash-bored-lock.yaml"), baseLock);

    await initializeProject(project, "arvid");

    expect(await readFile(join(baseDirectory, "dash-bored.yaml"), "utf8")).toBe(baseConfig);
    expect(await readFile(join(baseDirectory, "dash-bored-lock.yaml"), "utf8")).toBe(baseLock);
  });

  test("rejects a dash-bored directory symlink instead of writing outside the project", async () => {
    const project = await mkdtemp(join(tmpdir(), "dash-bored-init-"));
    const outside = await mkdtemp(join(tmpdir(), "dash-bored-init-"));
    temporaryDirectories.push(project, outside);
    await symlink(outside, join(project, "dash-bored"));

    await expect(initializeProject(project)).rejects.toThrow("must not be a symbolic link");
    expect(await readdir(outside)).toEqual([]);
  });
});
