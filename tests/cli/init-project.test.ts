import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { initializeProject } from "../../src/cli/init-project";

const temporaryDirectories: string[] = [];

function configuredNodes(root: any): any[] {
  const nodes = [root];
  const visitLayout = (layout: any): void => {
    if (layout.type === "child") nodes.push(...configuredNodes(layout.child.node));
    else {
      visitLayout(layout.first);
      visitLayout(layout.second);
    }
  };
  if (root.children?.type === "managed") {
    for (const item of root.children.items) nodes.push(...configuredNodes(item.node));
  } else if (root.children?.type === "tiled") {
    visitLayout(root.children.layout);
  }
  return nodes;
}

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

    expect(config.schemaVersion).toBe(2);
    expect(config.root.component).toBe("@dash-bored/group");
    expect(config.icon).toBe("./assets/icon.svg");
    const nodes = configuredNodes(config.root);
    expect(nodes.find((node) => node.id === "welcome")).toBeDefined();
    const concepts = nodes.find((node) => node.id === "concepts");
    expect(concepts.component).toBe("@dash-bored/group");
    expect(concepts.children.layout).toMatchObject({
      type: "split",
      axis: "horizontal",
      ratio: 0.5,
    });
    const demonstration = nodes.find((node) => node.id === "demonstration");
    expect(demonstration.component).toBe("@dash-bored/card");
    const statusDemo = nodes.find((node) => node.id === "status-demo");
    expect(statusDemo.component).toBe("@dash-bored/status");
    expect(statusDemo.props.state).toBe("healthy");
    const chartDemo = nodes.find((node) => node.id === "chart-demo");
    expect(chartDemo.component).toBe("@dash-bored/chart");
    expect(chartDemo.props.labels.length).toBe(chartDemo.props.series[0].values.length);
    const demoTodos = nodes.find((node) => node.id === "demo-todos");
    expect(demoTodos.component).toBe("@dash-bored/todo-list");
    expect(demoTodos.props.todos.length).toBeGreaterThan(0);
    for (const todo of demoTodos.props.todos) {
      expect(todo.description).toBeString();
      expect(todo.done).toBeBoolean();
    }
    const environmentEditor = nodes.find((node) => node.id === "dashboard-environment");
    const cliCommand = nodes.find((node) => node.id === "install-dash-bored-cli");
    const globalSkillCommand = nodes.find((node) => node.id === "install-dash-bored-global-skill");
    const skillCommand = nodes.find((node) => node.id === "install-dash-bored-skill");
    const cliVisibility = nodes.find((node) => node.id === "show-install-dash-bored-cli");
    const globalSkillVisibility = nodes.find((node) => node.id === "show-install-dash-bored-global-skill");
    const skillVisibility = nodes.find((node) => node.id === "show-install-dash-bored-skill");
    const agentCommand = nodes.find((node) => node.id === "setup-dashboard-with-agent");
    expect(environmentEditor.component).toBe("@dash-bored/env");
    expect(environmentEditor.props.path).toBe(".dash-bored/.env");
    expect(cliCommand.id).toBe("install-dash-bored-cli");
    expect(cliCommand.props.command).toContain("install-cli");
    expect(cliVisibility.component).toBe("@dash-bored/conditional");
    expect(cliVisibility.props.invert).toBeTrue();
    expect(cliVisibility.props.command).toContain(".local/bin/dash-bored");
    expect(globalSkillCommand.id).toBe("install-dash-bored-global-skill");
    expect(globalSkillCommand.props.command).toContain("install-skill --global");
    expect(globalSkillVisibility.component).toBe("@dash-bored/conditional");
    expect(globalSkillVisibility.props.command).toContain(".agents/skills/dash-bored/SKILL.md");
    expect(skillCommand.id).toBe("install-dash-bored-skill");
    expect(skillCommand.props.command).toContain("install-skill .");
    expect(skillVisibility.component).toBe("@dash-bored/conditional");
    expect(skillVisibility.props.command).toContain(".agents/skills/dash-bored/SKILL.md");
    expect(agentCommand.id).toBe("setup-dashboard-with-agent");
    expect(agentCommand.component).toBe("@dash-bored/command");
    expect(agentCommand.props.command).toContain("dash-bored");
    expect(agentCommand.props.command).toContain(" agent");
    expect(agentCommand.props.command).toContain("${DASH_BORED_AGENT:-codex exec}");
    expect(agentCommand.props.env.DASH_BORED_AGENT_PROMPT).toContain(
      "Inspect this project before making changes.",
    );
    expect(agentCommand.props.env.DASH_BORED_AGENT_PROMPT).toContain("assets/icon.svg");
    expect(environment).toContain('DASH_BORED_AGENT="codex exec"');
    expect(environment).toContain("DASH_BORED_AGENT_PROMPT=\"Set up the dash-bored dashboard for");
    expect(environment).toContain("Inspect this project before making changes.");
    expect((await stat(result.environmentPath)).mode & 0o777).toBe(0o600);
    expect(lock).toEqual({ lockfileVersion: 1, components: {} });
    expect((await stat(result.componentsPath)).isDirectory()).toBe(true);
    expect((await readdir(join(project, ".dash-bored"))).some((name) => name.endsWith(".tmp"))).toBeFalse();

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
    expect(result.configPath).toBe(join(canonicalProject, ".dash-bored", "people", "arvid", "dash-bored.yaml"));
    expect(parse(await readFile(result.configPath, "utf8")).name).toBe("arvid");
    expect(parse(await readFile(result.lockPath, "utf8"))).toEqual({ lockfileVersion: 1, components: {} });
    expect(await readFile(result.environmentPath, "utf8")).toContain('DASH_BORED_AGENT="codex exec"');
    expect(
      configuredNodes(parse(await readFile(result.configPath, "utf8")).root)
        .find((node) => node.id === "dashboard-environment").props.path,
    ).toBe(".dash-bored/people/arvid/.env");
    expect((await stat(result.componentsPath)).isDirectory()).toBeTrue();
    expect((await stat(join(project, ".dash-bored", "dash-bored.yaml"))).isFile()).toBeTrue();
    expect((await stat(join(project, ".dash-bored", "dash-bored-lock.yaml"))).isFile()).toBeTrue();
    expect((await stat(join(project, ".dash-bored", "components"))).isDirectory()).toBeTrue();

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
    const baseDirectory = join(project, ".dash-bored");
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
    await symlink(outside, join(project, ".dash-bored"));

    await expect(initializeProject(project)).rejects.toThrow("must not be a symbolic link");
    expect(await readdir(outside)).toEqual([]);
  });
});
