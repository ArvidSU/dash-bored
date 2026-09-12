import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { assertAgentAvailable } from "../../src/main/agent-preflight";
import { DashboardAgentHarness } from "../../src/main/component-agent";
import { configureBundledToolEnvironment, configureDesktopExecutableEnvironment } from "../../src/main/tool-environment";

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

describe("configureDesktopExecutableEnvironment", () => {
  test("finds and launches a user-local agent from a Finder-like PATH", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "dash-bored-user-bin-"));
    cleanup.push(homeDirectory);
    const binDirectory = join(homeDirectory, ".local", "bin");
    const agentPath = join(binDirectory, "portable-agent");
    const shellEnvironmentPath = join(homeDirectory, "replace-path.sh");
    await mkdir(binDirectory, { recursive: true });
    await writeFile(agentPath, "#!/bin/sh\nprintf 'agent prompt: %s\\n' \"$DASH_BORED_AGENT_PROMPT\"\n");
    await writeFile(shellEnvironmentPath, "PATH=/usr/bin:/bin\n");
    await chmod(agentPath, 0o755);
    const environment: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", ENV: shellEnvironmentPath };

    configureDesktopExecutableEnvironment(environment, { homeDirectory, platform: "darwin" });
    expect(environment.PATH?.split(delimiter)).toContain(binDirectory);
    expect(() => assertAgentAvailable("portable-agent exec", environment as Record<string, string>, homeDirectory)).not.toThrow();

    const harness = new DashboardAgentHarness();
    try {
      await harness.launch({
        command: "portable-agent exec",
        prompt: "make a new dashboard",
        request: "Set up this dashboard",
        projectRoot: homeDirectory,
        configPath: join(homeDirectory, ".dash-bored", "dash-bored.yaml"),
        componentPath: "root",
        // The harness must prevent this inherited interactive-shell hook from
        // undoing the Finder PATH normalization before launching the agent.
        env: environment as Record<string, string>,
      });
      const deadline = Date.now() + 5_000;
      while (harness.list()[0]?.process.phase === "running" && Date.now() < deadline) await Bun.sleep(10);
      expect(harness.list()[0]?.process).toMatchObject({ phase: "exited", exitCode: 0 });
      expect(harness.list()[0]?.process.logs.map((entry) => entry.text).join("")).toContain("agent prompt: make a new dashboard");
    } finally {
      await harness.close();
    }
  });
});
