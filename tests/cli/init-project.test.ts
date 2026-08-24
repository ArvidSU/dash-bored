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
  test("creates a valid guided dashboard, agent setup command, lock, and component directory", async () => {
    const project = await mkdtemp(join(tmpdir(), "dash-bored-init-"));
    temporaryDirectories.push(project);

    const result = await initializeProject(project);
    const config = parse(await readFile(result.configPath, "utf8"));
    const lock = parse(await readFile(result.lockPath, "utf8"));
    const environment = await readFile(result.environmentPath, "utf8");

    expect(config.schemaVersion).toBe(1);
    expect(config.root.component).toBe("@dash-bored/stack");
    expect(config.root.slots.children[0].id).toBe("welcome");
    expect(config.root.slots.children[1].component).toBe("@dash-bored/split");
    const environmentEditor = config.root.slots.children[2].slots.children[1];
    const cliCommand = config.root.slots.children[2].slots.children[2];
    const skillCommand = config.root.slots.children[2].slots.children[3];
    const agentCommand = config.root.slots.children[2].slots.children[4];
    expect(environmentEditor.component).toBe("@dash-bored/env");
    expect(environmentEditor.props.path).toBe("dash-bored/.env");
    expect(cliCommand.id).toBe("install-dash-bored-cli");
    expect(cliCommand.props.command).toContain("install-cli");
    expect(skillCommand.id).toBe("install-dash-bored-skill");
    expect(skillCommand.props.command).toContain("install-skill .");
    expect(agentCommand.id).toBe("setup-dashboard-with-agent");
    expect(agentCommand.component).toBe("@dash-bored/command");
    expect(agentCommand.props.command).toContain("DASH_BORED_AGENT");
    expect(agentCommand.props.env.DASH_BORED_AGENT_PROMPT).toContain(
      "Inspect this project before making changes.",
    );
    expect(agentCommand.props.command).not.toContain('. "./dash-bored/.env"');
    expect(environment).toContain("Configure DASH_BORED_AGENT once");
    expect((await stat(result.environmentPath)).mode & 0o777).toBe(0o600);
    expect(lock).toEqual({ lockfileVersion: 1, components: {} });
    expect((await stat(result.componentsPath)).isDirectory()).toBe(true);
    expect((await readdir(join(project, "dash-bored"))).some((name) => name.endsWith(".tmp"))).toBeFalse();

    const command = Bun.spawn(["/bin/sh", "-lc", agentCommand.props.command], {
      cwd: project,
      env: { ...process.env, ...agentCommand.props.env, DASH_BORED_AGENT: "printf" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await command.exited).toBe(0);
    expect(await new Response(command.stdout).text()).toBe(agentCommand.props.env.DASH_BORED_AGENT_PROMPT);
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
    expect(await readFile(result.environmentPath, "utf8")).toContain("Configure DASH_BORED_AGENT once");
    expect(
      parse(await readFile(result.configPath, "utf8")).root.slots.children[2].slots.children[1].props.path,
    ).toBe("dash-bored/people/arvid/.env");
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
