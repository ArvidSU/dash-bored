import { describe, expect, test } from "bun:test";
import { DashboardAgentHarness } from "../../src/main/component-agent";
import type { DashboardAgentTask } from "../../src/shared/contracts";

describe("DashboardAgentHarness", () => {
  test("tracks only a dashboard request and reports an observed dashboard change", async () => {
    const updates: DashboardAgentTask[] = [];
    const harness = new DashboardAgentHarness({ onTask: (task) => updates.push(task) });
    try {
      const launch = await harness.launch({
        command: "sh -c 'sleep 1'",
        prompt: "Change the dashboard.",
        request: "Change the dashboard.",
        projectRoot: process.cwd(),
        configPath: "/project/dash-bored/dash-bored.yaml",
        componentPath: "/project/dash-bored/dash-bored.yaml#root",
      });

      expect(launch.taskId).toStartWith("component-agent-");
      expect(harness.list()).toHaveLength(1);
      expect(harness.list()[0]).toMatchObject({
        id: launch.taskId,
        request: "Change the dashboard.",
        dashboardChanged: false,
        process: { phase: "running" },
      });

      harness.markDashboardChanged("/project/dash-bored/dash-bored.yaml");
      expect(harness.list()[0]?.dashboardChanged).toBeTrue();
      expect(updates.some((task) => task.dashboardChanged)).toBeTrue();

      const stopped = await harness.stop(launch.taskId);
      expect(stopped.process.phase).toBe("exited");
    } finally {
      await harness.close();
    }
  });
});
