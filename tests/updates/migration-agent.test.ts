import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadProjectDefinition, resolveProjectLocation } from "../../src/core";
import { shellWord } from "../../src/main/agent-handoff";
import { AgentSessions } from "../../src/main/agent-sessions";
import type { DashboardSetupHarness } from "../../src/main/dashboard-setup";
import type { AgentSessionTask } from "../../src/shared/agent-session";
import { superviseMigrationSession, type MigrationSessionOptions } from "../../src/updates/migration-agent";
import { createProject, removeTemporaryDirectory, temporaryDirectory } from "../core/helpers";

const FAKE_AGENT = join(import.meta.dir, "..", "fixtures", "acp", "fake-agent.ts");
const FAKE_COMMAND = [shellWord(process.execPath), shellWord(FAKE_AGENT)].join(" ");

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

/** The migration's session supervision against real ACP sessions and the fake agent. */
async function fixture(harness?: (manager: AgentSessions) => DashboardSetupHarness) {
  const root = await temporaryDirectory();
  cleanup.push(() => removeTemporaryDirectory(root));
  await createProject(root);
  const location = await resolveProjectLocation(root);
  const definition = await loadProjectDefinition(location, { compile: true });
  const manager = new AgentSessions({ emitDelayMs: 5, shutdownGraceMs: 300 });
  cleanup.push(() => manager.shutdown());
  const reports: string[] = [];
  const options: MigrationSessionOptions = {
    command: FAKE_COMMAND,
    location,
    configPath: location.configPath,
    prompt: "quick migration",
    env: process.env as Record<string, string>,
    permissions: definition.permissions,
    harness: harness?.(manager) ?? manager,
    close: (id, closeOptions) => manager.close(id, closeOptions),
    isTrusted: async () => true,
    cancelled: async () => false,
    report: (phase) => { reports.push(phase); },
  };
  return { manager, options, reports };
}

async function settled(manager: AgentSessions, predicate: (task: AgentSessionTask) => boolean): Promise<AgentSessionTask> {
  const deadline = Date.now() + 10_000;
  while (true) {
    const task = manager.list()[0];
    if (task && predicate(task)) return task;
    if (Date.now() > deadline) throw new Error(`Timed out; last task: ${JSON.stringify(task)?.slice(0, 2_000)}`);
    await Bun.sleep(10);
  }
}

describe("migration session supervision", () => {
  test("a validated migration closes its session without marking it cancelled", async () => {
    const { manager, options, reports } = await fixture();
    expect(await superviseMigrationSession(options)).toEqual({ stopped: false });
    expect(reports).toEqual(["migrating", "verifying"]);
    const task = await settled(manager, (candidate) => candidate.state === "closed");
    expect(task).toMatchObject({ purpose: "migration", turns: 1, validation: { status: "valid" } });
    expect(task.cancelled).toBeUndefined();
  });

  test("a failing turn-end hook rejects the migration and closes its session", async () => {
    let trustUnreadable = false;
    const { manager, options } = await fixture((sessions) => ({
      // The trust store becomes unreadable exactly when the turn ends.
      launch: (request) => sessions.launch({ ...request, onTurnEnd: async (task) => { trustUnreadable = true; await request.onTurnEnd?.(task); } }),
      followUp: (id, prompt) => sessions.followUp(id, prompt),
      setValidation: (id, validation) => sessions.setValidation(id, validation),
      isCancelled: (id) => sessions.isCancelled(id),
    }));
    options.isTrusted = async () => {
      if (trustUnreadable) throw new Error("The trust store could not be read.");
      return true;
    };
    await expect(superviseMigrationSession(options)).rejects.toThrow("The trust store could not be read.");
    const task = await settled(manager, (candidate) => candidate.state === "closed" && candidate.validation?.status === "failed");
    expect(task.validation?.diagnostics[0]).toMatchObject({ code: "DASHBOARD_AGENT_FINISH_FAILED" });
  });
});
