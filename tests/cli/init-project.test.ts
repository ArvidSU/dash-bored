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
    if ("node" in layout) nodes.push(...configuredNodes(layout.node));
    else {
      visitLayout(layout.first);
      visitLayout(layout.second);
    }
  };
  if (Array.isArray(root.children)) {
    for (const item of root.children) nodes.push(...configuredNodes(item.node));
  } else if (root.children !== undefined) {
    visitLayout(root.children);
  }
  return nodes;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("initializeProject", () => {
  test("creates a valid guided dashboard with visible setup steps, a live tour, lock, and component directory", async () => {
    const project = await mkdtemp(join(tmpdir(), "dash-bored-init-"));
    temporaryDirectories.push(project);

    const result = await initializeProject(project);
    const config = parse(await readFile(result.configPath, "utf8"));
    const lock = parse(await readFile(result.lockPath, "utf8"));
    const environment = await readFile(result.environmentPath, "utf8");

    expect(config.schemaVersion).toBe(3);
    expect(config.root.component).toBe("@dash-bored/group");
    expect(config.icon).toBe("./assets/icon.svg");
    const nodes = configuredNodes(config.root);
    expect(nodes.find((node) => node.id === "welcome")).toBeDefined();
    // Onboarding steps stay visible; each reports its outcome through a source-backed status.
    expect(nodes.some((node) => node.component === "@dash-bored/conditional")).toBeFalse();
    for (const id of ["get-started", "step-trust", "step-agent", "step-skill", "step-setup"]) {
      expect(nodes.find((node) => node.id === id).component).toBe("@dash-bored/group");
      if (id !== "get-started") expect(nodes.find((node) => node.id === `${id}-guide`).component).toBe("@dash-bored/markdown");
    }
    for (const id of ["trust-status", "agent-cli-status", "skill-global-status", "skill-project-status"]) {
      const status = nodes.find((node) => node.id === id);
      expect(status.component).toBe("@dash-bored/status");
      expect(status.props.state).toBeUndefined();
      expect(status.props.source.shell).toBeString();
    }
    expect(nodes.find((node) => node.id === "skill-global-status").props.source.shell)
      .toContain('"$DASH_BORED_TOOL" install-skill --global --check');
    expect(nodes.find((node) => node.id === "skill-project-status").props.source.shell)
      .toContain('"$DASH_BORED_TOOL" install-skill . --check');
    expect(nodes.find((node) => node.id === "trust-actions").props.items[0].action).toBe("project:trust");

    // The tour switches panels through a tab bar over a selection container and
    // reads the project's own files rather than hand-written sample data.
    const tourPanels = nodes.find((node) => node.id === "tour-panels");
    expect(tourPanels.component).toBe("@dash-bored/selection");
    const tourTabs = nodes.find((node) => node.id === "tour-tabs");
    expect(tourTabs.props.variant).toBe("tabs");
    expect(tourTabs.props.items.map((item: any) => item.action))
      .toEqual(tourPanels.children.map((edge: any) => `select:tour-panels/${edge.node.id}`));
    for (const edge of tourPanels.children) {
      expect(edge.metadata.label).toBeString();
      expect(nodes.find((node) => node.id === `${edge.node.id}-guide`).component).toBe("@dash-bored/markdown");
    }
    for (const id of ["tour-activity-status", "tour-recent-files", "tour-file-types", "tour-readme"]) {
      expect(nodes.find((node) => node.id === id).props.source.shell).toBeString();
    }
    const ideas = nodes.find((node) => node.id === "tour-ideas");
    expect(ideas.component).toBe("@dash-bored/list");
    for (const todo of ideas.props.todos) {
      expect(todo.id).toBeString();
      expect(todo.done).toBeBoolean();
    }
    for (const retired of ["@dash-bored/card", "@dash-bored/todo-list", "@dash-bored/tabs"]) {
      expect(nodes.some((node) => node.component === retired)).toBeFalse();
    }
    const environmentEditor = nodes.find((node) => node.id === "dashboard-environment");
    const globalSkillCommand = nodes.find((node) => node.id === "install-dash-bored-global-skill");
    const skillCommand = nodes.find((node) => node.id === "install-dash-bored-skill");
    const agentCommand = nodes.find((node) => node.id === "setup-dashboard-with-agent");
    expect(environmentEditor.component).toBe("@dash-bored/env");
    expect(environmentEditor.props.path).toBe(".dash-bored/.env");
    expect(nodes.some((node) => String(node.props?.command ?? "").includes("install-cli"))).toBeFalse();
    expect(globalSkillCommand.props.command).toContain("install-skill --global");
    expect(skillCommand.props.command).toContain("install-skill .");
    expect(agentCommand.id).toBe("setup-dashboard-with-agent");
    expect(agentCommand.component).toBe("@dash-bored/button");
    expect(agentCommand.props.action.run).toBe("agent:prompt");
    expect(agentCommand.props.action.with.prompt).toContain("Set up the dash-bored dashboard");
    expect(agentCommand.props.env).toBeUndefined();
    expect(agentCommand.props.command).toBeUndefined();
    expect(environment).toContain('DASH_BORED_AGENT="codex exec"');
    expect(environment).not.toContain("DASH_BORED_AGENT_PROMPT");
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
