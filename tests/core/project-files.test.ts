import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "yaml";
import { ensureProjectFiles, inspectProject, resolveProjectLocation } from "../../src/core";
import {
  defaultConfig,
  removeTemporaryDirectory,
  temporaryDirectory,
} from "./helpers";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(removeTemporaryDirectory));
});

describe("ensureProjectFiles", () => {
  test("creates the project-owned dash-bored files when opening a new project", async () => {
    const root = await temporaryDirectory();
    cleanup.push(root);

    const result = await ensureProjectFiles(root);

    expect(result.created).toEqual({
      config: true,
      lock: true,
      environment: true,
      componentsDirectory: true,
    });
    expect((await stat(join(root, ".dash-bored", "components"))).isDirectory()).toBeTrue();
    const environment = await readFile(join(root, ".dash-bored", ".env"), "utf8");
    expect(environment).toContain('DASH_BORED_AGENT="codex exec"');
    expect(environment).toContain("DASH_BORED_AGENT_PROMPT=\"Set up the dash-bored dashboard for");
    expect((await inspectProject(root)).ok).toBeTrue();
  });

  test("repairs missing artifacts without changing existing project configuration", async () => {
    const root = await temporaryDirectory();
    cleanup.push(root);
    const directory = join(root, ".dash-bored");
    const configPath = join(directory, "dash-bored.yaml");
    const existingConfig = stringify({ ...defaultConfig, name: "Keep this name" });
    await mkdir(directory);
    await writeFile(configPath, existingConfig, "utf8");

    const result = await ensureProjectFiles(root);

    expect(result.created).toEqual({
      config: false,
      lock: true,
      environment: true,
      componentsDirectory: true,
    });
    expect(await readFile(configPath, "utf8")).toBe(existingConfig);
    expect((await inspectProject(root)).ok).toBeTrue();

    const repeated = await ensureProjectFiles(root);
    expect(repeated.created).toEqual({
      config: false,
      lock: false,
      environment: false,
      componentsDirectory: false,
    });
    expect(await readFile(configPath, "utf8")).toBe(existingConfig);
  });

  test("preserves an existing dashboard environment file", async () => {
    const root = await temporaryDirectory();
    cleanup.push(root);
    const directory = join(root, ".dash-bored");
    const environmentPath = join(directory, ".env");
    const existingEnvironment = 'DASH_BORED_AGENT="claude -p"\n';
    await mkdir(directory);
    await writeFile(environmentPath, existingEnvironment, "utf8");

    const result = await ensureProjectFiles(root);

    expect(result.created.environment).toBeFalse();
    expect(await readFile(environmentPath, "utf8")).toBe(existingEnvironment);
  });

  test("treats a selected folder named .dash-bored as the project root", async () => {
    const parent = await temporaryDirectory();
    cleanup.push(parent);
    const root = join(parent, ".dash-bored");
    await mkdir(root);

    const result = await ensureProjectFiles(root, { inputKind: "project-root" });

    expect(result.location.projectRoot).toBe(await realpath(root));
    expect((await stat(join(root, ".dash-bored", "components"))).isDirectory()).toBeTrue();
    await expect(access(join(root, "dash-bored.yaml"))).rejects.toThrow();
  });

  test("resolves an explicit nested config or its directory as a standalone bundle", async () => {
    const root = await temporaryDirectory();
    cleanup.push(root);
    const configDirectory = join(root, ".dash-bored", "people", "arvid");
    await mkdir(configDirectory, { recursive: true });
    const configPath = join(configDirectory, "dash-bored.yaml");
    await writeFile(configPath, stringify(defaultConfig), "utf8");

    const location = await resolveProjectLocation(configPath);
    const directoryLocation = await resolveProjectLocation(configDirectory);

    expect(location.projectRoot).toBe(await realpath(root));
    const canonicalConfigDirectory = await realpath(configDirectory);
    expect(location.configDirectory).toBe(canonicalConfigDirectory);
    expect(location.lockPath).toBe(join(canonicalConfigDirectory, "dash-bored-lock.yaml"));
    expect(location.componentsDirectory).toBe(join(canonicalConfigDirectory, "components"));
    expect(directoryLocation).toEqual(location);
  });
});
