import { afterEach, describe, expect, test } from "bun:test";
import { lstat, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { APP_VERSION } from "../../src/shared/app-metadata";

const cli = resolve(import.meta.dirname, "../../src/cli/index.ts");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function run(project: string, ...args: string[]) {
  const subprocess = Bun.spawn({
    cmd: [process.execPath, cli, ...args],
    cwd: project,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

describe("dash-bored command arguments", () => {
  test("reports the package version", async () => {
    const project = await mkdtemp(join(tmpdir(), "dash-bored-cli-"));
    temporaryDirectories.push(project);

    const result = await run(project, "--version");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(APP_VERSION);
  });

  test("command help never executes the command", async () => {
    const project = await mkdtemp(join(tmpdir(), "dash-bored-cli-"));
    temporaryDirectories.push(project);

    const result = await run(project, "init", "--help");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("dash-bored init [name ...] [--project <path>]");
    expect(await exists(join(project, "dash-bored"))).toBeFalse();
  });

  test("unknown flags fail instead of silently targeting the current directory", async () => {
    const project = await mkdtemp(join(tmpdir(), "dash-bored-cli-"));
    temporaryDirectories.push(project);

    const result = await run(project, "init", "--unknown");
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Unknown option for init: --unknown");
    expect(await exists(join(project, "dash-bored"))).toBeFalse();
  });

  test("init accepts a named config and explicit project path", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "dash-bored-cli-"));
    const project = await mkdtemp(join(tmpdir(), "dash-bored-cli-project-"));
    temporaryDirectories.push(cwd, project);

    const result = await run(cwd, "init", "arvid", "--project", project);

    expect(result.exitCode).toBe(0);
    expect(await exists(join(project, "dash-bored", "dash-bored.yaml"))).toBeTrue();
    expect(await exists(join(project, "dash-bored", "arvid", "dash-bored.yaml"))).toBeTrue();
    expect(await exists(join(project, "dash-bored", "arvid", "dash-bored-lock.yaml"))).toBeTrue();
    expect(await exists(join(project, "dash-bored", "arvid", "components"))).toBeTrue();
  });

  test("init interprets every positional name as another bundle directory", async () => {
    const project = await mkdtemp(join(tmpdir(), "dash-bored-cli-"));
    temporaryDirectories.push(project);

    const result = await run(project, "init", "arvid", "cicd", "deployments");

    expect(result.exitCode).toBe(0);
    const bundle = join(project, "dash-bored", "arvid", "cicd", "deployments");
    expect(await exists(join(bundle, "dash-bored.yaml"))).toBeTrue();
    expect(await exists(join(bundle, "dash-bored-lock.yaml"))).toBeTrue();
    expect(await exists(join(bundle, "components"))).toBeTrue();
  });

  test("init dot remains the strict base initializer", async () => {
    const project = await mkdtemp(join(tmpdir(), "dash-bored-cli-"));
    temporaryDirectories.push(project);

    expect((await run(project, "init", ".")).exitCode).toBe(0);
    const repeated = await run(project, "init", ".");
    expect(repeated.exitCode).toBe(1);
    expect(repeated.stderr).toContain("existing files were not overwritten");
  });

  test("install-skill creates an idempotent project-local skill without overwriting changes", async () => {
    const project = await mkdtemp(join(tmpdir(), "dash-bored-cli-"));
    temporaryDirectories.push(project);
    const skillPath = join(project, ".agents", "skills", "dash-bored", "SKILL.md");
    const componentReferencePath = join(
      project,
      ".agents",
      "skills",
      "dash-bored",
      "references",
      "components.md",
    );

    const installed = await run(project, "install-skill", ".");
    expect(installed.exitCode).toBe(0);
    expect(installed.stdout).toContain("Installed portable dash-bored skill");
    expect(await readFile(skillPath, "utf8")).toBe(
      await readFile(resolve(import.meta.dirname, "../../skills/dash-bored/SKILL.md"), "utf8"),
    );
    expect(await readFile(componentReferencePath, "utf8")).toBe(
      await readFile(
        resolve(import.meta.dirname, "../../skills/dash-bored/references/components.md"),
        "utf8",
      ),
    );
    const claudeSkillPath = join(project, ".claude", "skills", "dash-bored");
    expect((await lstat(claudeSkillPath)).isSymbolicLink()).toBeTrue();
    expect(await realpath(claudeSkillPath)).toBe(await realpath(join(project, ".agents", "skills", "dash-bored")));

    const repeated = await run(project, "install-skill", ".");
    expect(repeated.exitCode).toBe(0);
    expect(repeated.stdout).toContain("already installed");

    await writeFile(skillPath, "custom skill\n", "utf8");
    const conflicting = await run(project, "install-skill", ".");
    expect(conflicting.exitCode).toBe(1);
    expect(conflicting.stderr).toContain("Refusing to overwrite a modified dash-bored skill file");
    expect(await readFile(skillPath, "utf8")).toBe("custom skill\n");
  });

  test("install-skill rejects a symlinked agent directory", async () => {
    const project = await mkdtemp(join(tmpdir(), "dash-bored-cli-"));
    const outside = await mkdtemp(join(tmpdir(), "dash-bored-cli-outside-"));
    temporaryDirectories.push(project, outside);
    await symlink(outside, join(project, ".agents"));

    const result = await run(project, "install-skill", ".");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("agent configuration directory must not be a symbolic link");
    expect(await readdir(outside)).toEqual([]);
  });

  test("inspect exposes the version-matched component catalog", async () => {
    const project = await mkdtemp(join(tmpdir(), "dash-bored-cli-"));
    temporaryDirectories.push(project);
    expect((await run(project, "init", ".")).exitCode).toBe(0);

    const inspected = await run(project, "inspect", ".");
    expect(inspected.exitCode).toBe(0);
    const result = JSON.parse(inspected.stdout);
    const command = result.componentCatalog.find(
      (item: { reference: string }) => item.reference === "@dash-bored/command",
    );
    expect(command.available).toBeTrue();
    expect(command.manifest.propsSchema.required).toEqual(["label", "command"]);
    expect(command.manifest.permissions).toEqual(["process:execute"]);
    const split = result.componentCatalog.find(
      (item: { reference: string }) => item.reference === "@dash-bored/split",
    );
    expect(split.manifest.slots).toEqual({
      first: { required: true, multiple: false },
      second: { required: true, multiple: false },
    });
  });
});
