import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { configureBundledToolEnvironment } from "../../src/main/tool-environment";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("configureBundledToolEnvironment", () => {
  test("prepends the packaged tools directory to PATH", async () => {
    const appDirectory = await mkdtemp(join(tmpdir(), "dash-bored-tools-"));
    cleanup.push(appDirectory);
    const mainDirectory = join(appDirectory, "Contents", "Resources", "app", "bun");
    const toolsDirectory = join(appDirectory, "Contents", "Resources", "app", "tools");
    const cliPath = join(toolsDirectory, process.platform === "win32" ? "dash-bored.exe" : "dash-bored");
    await mkdir(mainDirectory, { recursive: true });
    await mkdir(toolsDirectory, { recursive: true });
    await writeFile(cliPath, "cli");
    const environment: NodeJS.ProcessEnv = { PATH: "/usr/bin" };

    const result = configureBundledToolEnvironment(mainDirectory, environment);

    expect(result?.toolsDirectory).toBe(toolsDirectory);
    expect(environment.PATH?.split(delimiter)[0]).toBe(toolsDirectory);
  });
});
