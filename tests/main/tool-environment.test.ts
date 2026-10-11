import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { assertAgentAvailable } from "../../src/main/agent-preflight";
import { AgentSessions } from "../../src/main/agent-sessions";
import { configureBundledToolEnvironment, configureDesktopExecutableEnvironment } from "../../src/main/tool-environment";

const FAKE_AGENT = join(import.meta.dir, "..", "fixtures", "acp", "fake-agent.ts");

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("configureBundledToolEnvironment", () => {
  test("publishes the packaged agent tool by path without touching PATH", async () => {
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
    expect(result?.toolPath).toBe(cliPath);
    expect(environment.DASH_BORED_TOOL).toBe(cliPath);
    expect(environment.PATH).toBe("/usr/bin");
  });
});

describe("configureDesktopExecutableEnvironment", () => {
  test("finds and launches a user-local ACP agent from a Finder-like PATH", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "dash-bored-user-bin-"));
    cleanup.push(homeDirectory);
    const binDirectory = join(homeDirectory, ".local", "bin");
    const agentPath = join(binDirectory, "portable-agent");
    const shellEnvironmentPath = join(homeDirectory, "replace-path.sh");
    await mkdir(binDirectory, { recursive: true });
    await mkdir(join(homeDirectory, ".dash-bored"), { recursive: true });
    await writeFile(agentPath, `#!/bin/sh\nexec '${process.execPath}' '${FAKE_AGENT}' "$@"\n`);
    await writeFile(shellEnvironmentPath, "PATH=/usr/bin:/bin\n");
    await chmod(agentPath, 0o755);
    const environment: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", ENV: shellEnvironmentPath, BASH_ENV: shellEnvironmentPath };

    configureDesktopExecutableEnvironment(environment, { homeDirectory, platform: "darwin" });
    expect(environment.PATH?.split(delimiter)).toContain(binDirectory);
    expect(() => assertAgentAvailable("portable-agent --acp", environment as Record<string, string>, homeDirectory)).not.toThrow();

    const sessions = new AgentSessions({ emitDelayMs: 5, shutdownGraceMs: 300 });
    try {
      const { taskId } = await sessions.launch({
        command: "portable-agent --acp",
        prompt: "quick setup",
        request: "Set up this dashboard",
        projectRoot: homeDirectory,
        bundleDirectory: join(homeDirectory, ".dash-bored"),
        configPath: join(homeDirectory, ".dash-bored", "dash-bored.yaml"),
        componentPath: "root",
        // The launch must keep these inherited shell hooks from undoing the
        // Finder PATH normalization before the agent starts.
        env: environment as Record<string, string>,
      });
      const deadline = Date.now() + 10_000;
      while (sessions.get(taskId).state !== "idle" && sessions.get(taskId).state !== "failed" && Date.now() < deadline) await Bun.sleep(10);
      expect(sessions.get(taskId)).toMatchObject({ state: "idle", turns: 1, stopReason: "end_turn" });
    } finally {
      await sessions.shutdown();
    }
  });
});
