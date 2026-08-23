import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

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
});
