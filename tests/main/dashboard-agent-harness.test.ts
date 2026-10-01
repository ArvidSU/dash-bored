import { describe, expect, test } from "bun:test";
import { DashboardAgentHarness } from "../../src/main/component-agent";
import { assertAgentAvailable } from "../../src/main/agent-preflight";
import type { DashboardAgentTask } from "../../src/shared/contracts";
import { isProcessRunActive } from "../../src/shared/process-state";

describe("DashboardAgentHarness", () => {
  test("retains the agent exit code and an interactive shell after passing the prompt literally through the PTY", async () => {
    const harness = new DashboardAgentHarness();
    const prompt = "A request with 'quotes', $HOME and $(printf unsafe).";
    try {
      const launch = await harness.launch({
        command: "sh -c 'printf \"%s\\n\" \"$1\"; exit 7' agent",
        prompt,
        request: "Test finite agent work",
        projectRoot: process.cwd(),
        configPath: "/project/.dash-bored/dash-bored.yaml",
        componentPath: "/project/.dash-bored/dash-bored.yaml#root",
      });
      const deadline = Date.now() + 5_000;
      while (isProcessRunActive(harness.list()[0]?.process) && Date.now() < deadline) {
        await Bun.sleep(10);
      }
      const task = harness.list()[0]!;
      expect(task.process.phase).toBe("running");
      expect(task.process.run).toMatchObject({ phase: "exited", exitCode: 7 });
      expect(task.process.logs.map((entry) => entry.text).join("")).toContain(prompt);
      await harness.writeTerminal(launch.taskId, "printf 'SHELL_%s\\n' READY\r");
      while (!harness.list()[0]?.process.logs.map((entry) => entry.text).join("").includes("SHELL_READY") && Date.now() < deadline) await Bun.sleep(10);
      expect(harness.list()[0]?.process.logs.map((entry) => entry.text).join("")).toContain("SHELL_READY");
      expect(harness.list()[0]?.process.run).toMatchObject({ phase: "exited", exitCode: 7 });
    } finally {
      await harness.close();
    }
  });

  test("tracks only a dashboard request and reports an observed dashboard change", async () => {
    const updates: DashboardAgentTask[] = [];
    const harness = new DashboardAgentHarness({ onTask: (task) => updates.push(task) });
    try {
      const launch = await harness.launch({
        command: "sh -c 'sleep 1'",
        prompt: "Change the dashboard.",
        request: "Change the dashboard.",
        projectRoot: process.cwd(),
        configPath: "/project/.dash-bored/dash-bored.yaml",
        componentPath: "/project/.dash-bored/dash-bored.yaml#root",
      });

      expect(launch.taskId).toStartWith("component-agent-");
      expect(harness.list()).toHaveLength(1);
      expect(harness.list()[0]).toMatchObject({
        id: launch.taskId,
        request: "Change the dashboard.",
        dashboardChanged: false,
        process: { phase: "running" },
      });

      expect((await harness.resizeTerminal(launch.taskId, 80, 24)).process.phase).toBe("running");
      expect((await harness.writeTerminal(launch.taskId, "\n")).process.phase).toBe("running");

      harness.markDashboardChanged("/project/.dash-bored/dash-bored.yaml");
      expect(harness.list()[0]?.dashboardChanged).toBeTrue();
      expect(updates.some((task) => task.dashboardChanged)).toBeTrue();

      const stopped = await harness.stop(launch.taskId);
      expect(stopped.process.phase).toBe("exited");
    } finally {
      await harness.close();
    }
  });

  test("generated request environment wins and finisher runs once", async () => {
    let finished = 0;
    const harness = new DashboardAgentHarness();
    try {
      const prompt = "generated prompt";
      const launch = await harness.launch({
        command: "sh -c 'printf \"%s\\n\" \"$DASH_BORED_AGENT_PROMPT\"'",
        prompt,
        request: prompt,
        projectRoot: process.cwd(),
        configPath: "/project/dash-bored.yaml",
        componentPath: "/project/dash-bored.yaml#root",
        env: { DASH_BORED_AGENT_PROMPT: "stale prompt" },
        onFinished: () => { finished += 1; },
      });
      const deadline = Date.now() + 5_000;
      while (isProcessRunActive(harness.list()[0]?.process) && Date.now() < deadline) await Bun.sleep(10);
      expect(harness.list()[0]?.process.logs.map((entry) => entry.text).join("")).toContain(prompt);
      expect(finished).toBe(1);
      expect(launch.taskId).toStartWith("component-agent-");
      await harness.stop(launch.taskId);
      await Bun.sleep(10);
      expect(finished).toBe(1);
    } finally {
      await harness.close();
    }
  });

  test("project trust revocation stops its shell while preserving other projects", async () => {
    const harness = new DashboardAgentHarness();
    try {
      const launch = (projectRoot: string) => harness.launch({ command: "sh -c 'exit 0'", prompt: "Proof",
        request: "Proof", projectRoot, configPath: `${projectRoot}/.dash-bored/dash-bored.yaml`, componentPath: "root" });
      const own = await launch(process.cwd());
      const other = await launch("/tmp");
      const deadline = Date.now() + 5_000;
      while (harness.list().some((task) => isProcessRunActive(task.process)) && Date.now() < deadline) await Bun.sleep(10);
      expect(harness.list().every((task) => task.process.phase === "running")).toBe(true);
      await harness.stopProject(process.cwd());
      expect(harness.list().find((task) => task.id === own.taskId)?.process.phase).toBe("exited");
      expect(harness.list().find((task) => task.id === other.taskId)?.process.phase).toBe("running");
    } finally { await harness.close(); }
  });

  test("preflight skips shell expressions and rejects missing literal agents", () => {
    expect(() => assertAgentAvailable("definitely-missing-dash-bored-agent", { PATH: "" }, process.cwd())).toThrow("Settings");
    expect(() => assertAgentAvailable("sh -c 'echo hi'", { PATH: "" }, process.cwd())).not.toThrow();
    expect(() => assertAgentAvailable("DASH_AGENT=missing", { PATH: "" }, process.cwd())).not.toThrow();
    expect(() => assertAgentAvailable("echo hi", { PATH: "" }, process.cwd())).not.toThrow();
  });
});
