import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify, parse } from "yaml";
import type { AgentSessionTask } from "../../src/shared/agent-session";
import type { ComponentAgentLaunch, Permission, ResolvedComponentNode } from "../../src/shared/contracts";
import { ensureProjectFiles, loadProjectDefinition, resolveProjectLocation } from "../../src/core";
import { AgentSessions, type AgentSessionLaunchOptions } from "../../src/main/agent-sessions";
import { shellWord } from "../../src/main/agent-handoff";
import { DashboardSetupSupervisor, type DashboardSetupHarness } from "../../src/main/dashboard-setup";
import { installCoreFixture, removeTemporaryDirectory, temporaryDirectory } from "../core/helpers";

const FAKE_AGENT = join(import.meta.dir, "..", "fixtures", "acp", "fake-agent.ts");
const FAKE_COMMAND = [shellWord(process.execPath), shellWord(FAKE_AGENT)].join(" ");

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

/** A task as `onTurnEnd` sees it after one turn. */
function task(overrides: Partial<AgentSessionTask> = {}): AgentSessionTask {
  return {
    id: `task-${Math.random()}`, agent: { command: "fake-agent", name: "fake-agent" }, prompt: "original", componentPath: "config#setup",
    request: "Set up this dashboard", configPath: "", startedAt: new Date().toISOString(), state: "idle", sessionId: "s", pid: 1,
    entries: [], truncated: 0, plan: null, permission: null, configOptions: [], turns: 1, stopReason: "end_turn", handoff: null,
    dashboardChanged: false, log: [], ...overrides,
  };
}

function runtime(location: Awaited<ReturnType<typeof resolveProjectLocation>>, node: ResolvedComponentNode, requestedPermissions: Permission[] = []) {
  let current: { projectRoot: string; configPath: string; trusted: boolean; tree: ResolvedComponentNode | null; requestedPermissions: Permission[] } = { projectRoot: location.projectRoot, configPath: location.configPath, trusted: true, tree: node, requestedPermissions };
  return {
    getSnapshot: () => current,
    getLaunchEnvironment: async () => ({ DASH_BORED_AGENT: "fake-agent" }),
    reload: async () => undefined,
    switchConfig: (configPath: string) => { current = { ...current, configPath }; },
    revoke: () => { current = { ...current, trusted: false }; },
    removeNode: () => { current = { ...current, tree: null }; },
  };
}

async function fixture() {
  const root = await temporaryDirectory();
  cleanup.push(() => removeTemporaryDirectory(root));
  await ensureProjectFiles(root);
  await installCoreFixture((await resolveProjectLocation(root)).configDirectory);
  const location = await resolveProjectLocation(root);
  const config = parse(await readFile(location.configPath, "utf8"));
  const node: ResolvedComponentNode = { id: "setup", component: "./components/external/core/setup-agent", props: {}, source: "external", sourceConfigPath: location.configPath, sourcePath: "root", manifest: { schemaVersion: 3, apiVersion: "2.0.0", id: "./components/external/core/setup-agent", name: "Setup", description: "", entry: "builtin:setup-agent", propsSchema: {}, permissions: ["process:execute"] } };
  const definition = await loadProjectDefinition(location, { compile: true });
  return { location, node, config, permissions: definition.permissions };
}

const INVALID_ROOT = { component: "./components/external/core/setup-agent", props: { unexpected: true } };

/** Records launches and follow-ups; a test ends each turn by calling `turnEnd`. */
function harness() {
  const launches: Array<{ options: AgentSessionLaunchOptions; task: AgentSessionTask; validations: NonNullable<AgentSessionTask["validation"]>[] }> = [];
  const followUps: Array<{ id: string; prompt: string }> = [];
  const fake = {
    launches,
    followUps,
    setValidation(id: string, validation: AgentSessionTask["validation"]) {
      if (validation) launches.find((launch) => launch.task.id === id)?.validations.push(validation);
    },
    launch(options: AgentSessionLaunchOptions): Promise<ComponentAgentLaunch> {
      const launched = task({ configPath: options.configPath, ...(options.purpose ? { purpose: options.purpose } : {}) });
      launches.push({ options, task: launched, validations: [] });
      return Promise.resolve({ taskId: launched.id, command: options.command, componentPath: options.componentPath, pid: null });
    },
    followUp(id: string, prompt: string) {
      followUps.push({ id, prompt });
    },
    /** End the current turn of launch `index` with the task's state at that point. */
    async turnEnd(index = 0, overrides: Partial<AgentSessionTask> = {}) {
      const launch = launches[index]!;
      launch.task = { ...launch.task, turns: launch.task.turns + 1, ...overrides };
      await launch.options.onTurnEnd?.(launch.task);
      return launch.validations.at(-1);
    },
  };
  return fake satisfies DashboardSetupHarness;
}

describe("DashboardSetupSupervisor", () => {
  test("project work skips dashboard validation and keeps its template", async () => {
    const { location, node, permissions } = await fixture(); const rt = runtime(location, node, permissions); const h = harness();
    await new DashboardSetupSupervisor({ runtime: rt, harness: h, command: "fake-agent", location }).launchRequest({
      purpose: "project", followUp: false, template: "project", prompt: "Implement todo-022", configPath: location.configPath,
      componentPath: `${location.configPath}#id=yaml-todo`, request: "Implement todo-022",
    });
    expect(h.launches[0]!.options).toMatchObject({ purpose: "project", template: "project", projectRoot: location.projectRoot, bundleDirectory: location.configDirectory });
    expect(h.launches[0]!.options.onTurnEnd).toBeUndefined();
    expect(h.launches[0]!.options.untrusted).toBeUndefined();
  });

  test("passes resolved launch environment and validates a successful turn", async () => {
    const { location, node, permissions } = await fixture(); const rt = runtime(location, node, permissions); const h = harness();
    await new DashboardSetupSupervisor({ runtime: rt, harness: h, command: "fake-agent", location }).launchRequest({ prompt: "Set up dashboard", configPath: location.configPath, componentPath: "root", request: "Set up dashboard", purpose: "edit" });
    expect(h.launches[0]!.options.env).toEqual({ DASH_BORED_AGENT: "fake-agent" });
    expect((await h.turnEnd())?.status).toBe("valid");
    expect(h.launches[0]!.validations.map((validation) => validation.status)).toEqual(["checking", "valid"]);
    expect(h.followUps).toHaveLength(0);
  });

  test("repairs invalid config once as a follow-up in the same session and validates the repair", async () => {
    const { location, node, config, permissions } = await fixture(); const rt = runtime(location, node, permissions); const h = harness();
    await writeFile(location.configPath, stringify({ ...config, root: INVALID_ROOT }));
    await new DashboardSetupSupervisor({ runtime: rt, harness: h, command: "fake-agent", location }).launchRequest({ prompt: "Set up dashboard", configPath: location.configPath, componentPath: "root", request: "Set up dashboard", purpose: "edit" });
    expect((await h.turnEnd())?.status).toBe("repairing");
    expect(h.launches).toHaveLength(1);
    expect(h.followUps).toEqual([{ id: h.launches[0]!.task.id, prompt: expect.stringContaining("dash-bored validated the dashboard after your last turn") }]);
    expect(h.followUps[0]!.prompt).toContain("COMPONENT_PROPS_INVALID");
    expect(h.followUps[0]!.prompt).not.toContain("Original setup request");
    await writeFile(location.configPath, stringify(config));
    expect((await h.turnEnd())?.status).toBe("valid");
  });

  test("does not repair twice when the repair turn leaves errors, nor after a later turn", async () => {
    const { location, node, config, permissions } = await fixture(); await writeFile(location.configPath, stringify({ ...config, root: INVALID_ROOT }));
    const rt = runtime(location, node, permissions); const h = harness();
    await new DashboardSetupSupervisor({ runtime: rt, harness: h, command: "fake-agent", location }).launchRequest({ prompt: "Set up dashboard", configPath: location.configPath, componentPath: "root", request: "Set up dashboard", purpose: "edit" });
    await h.turnEnd();
    expect(await h.turnEnd()).toMatchObject({ status: "failed", message: "Configuration errors remain after the single repair attempt." });
    // A later user follow-up is validated again but never repaired automatically.
    expect(await h.turnEnd()).toMatchObject({ status: "failed", message: expect.stringContaining("automatic repair was already used") });
    expect(h.followUps).toHaveLength(1);
  });

  test.each([
    [{ stopReason: "max_tokens" as const }, "failed", "max_tokens"],
    [{ stopReason: "refusal" as const }, "failed", "refusal"],
    [{ stopReason: "cancelled" as const }, "cancelled", "cancelled"],
    [{ state: "failed" as const, stopReason: undefined, error: "The agent process exited with code 3." }, "failed", "exited with code 3"],
    [{ state: "closed" as const, stopReason: undefined, cancelled: true }, "cancelled", "stopped"],
  ])("does not repair after a turn that did not end cleanly %j", async (overrides, status, message) => {
    const { location, node, config, permissions } = await fixture(); await writeFile(location.configPath, stringify({ ...config, root: INVALID_ROOT }));
    const rt = runtime(location, node, permissions); const h = harness();
    await new DashboardSetupSupervisor({ runtime: rt, harness: h, command: "fake-agent", location }).launchRequest({ prompt: "Set up dashboard", configPath: location.configPath, componentPath: "root", request: "Set up dashboard", purpose: "edit" });
    const validation = await h.turnEnd(0, overrides);
    expect(String(validation?.status)).toBe(String(status));
    expect(validation?.message ?? "").toContain(String(message));
    expect(validation?.message).toMatch(/no automatic repair/i);
    expect(h.followUps).toHaveLength(0);
  });

  test("does not repair after trust revoke", async () => {
    const { location, node, config } = await fixture(); await writeFile(location.configPath, stringify({ ...config, root: INVALID_ROOT }));
    const rt = runtime(location, node); const h = harness();
    await new DashboardSetupSupervisor({ runtime: rt, harness: h, command: "fake-agent", location }).launchRequest({ prompt: "Set up dashboard", configPath: location.configPath, componentPath: "root", request: "Set up dashboard", purpose: "edit" });
    rt.revoke();
    expect((await h.turnEnd())?.status).toBe("trust-required");
    expect(h.followUps).toHaveLength(0);
  });

  test("an untrusted repair launches without trust, refuses out-of-bundle requests, and never auto-repairs", async () => {
    const { location, node, config } = await fixture(); await writeFile(location.configPath, stringify({ ...config, root: INVALID_ROOT }));
    const rt = runtime(location, node); rt.revoke(); const h = harness();
    const s = new DashboardSetupSupervisor({ runtime: rt, harness: h, command: "fake-agent", location });
    await s.launchRequest({ prompt: "fix", configPath: location.configPath, componentPath: `${location.configPath}#diagnostics`, request: "Fix dashboard configuration diagnostics.", purpose: "edit", untrustedRepair: true, env: { CLEAN: "yes" } });
    expect(h.launches[0]!.options).toMatchObject({ env: { CLEAN: "yes" }, untrusted: true, bundleDirectory: location.configDirectory });
    expect(await h.turnEnd()).toMatchObject({ status: "trust-required", message: expect.stringContaining("review project trust") });
    expect(h.followUps).toHaveLength(0);
  });

  test("a trusted-required request still refuses to launch without a grant", async () => {
    const { location, node } = await fixture();
    const rt = runtime(location, node); rt.revoke(); const h = harness();
    const s = new DashboardSetupSupervisor({ runtime: rt, harness: h, command: "fake-agent", location });
    expect(s.launchRequest({ prompt: "fix", configPath: location.configPath, componentPath: `${location.configPath}#diagnostics`, request: "Fix dashboard configuration diagnostics.", purpose: "edit" })).rejects.toThrow("trust changed");
    expect(h.launches).toHaveLength(0);
  });

  test.each(["navigation", "cancel", "session"] as const)("does not repair after %s", async (reason) => {
    const { location, node, config, permissions } = await fixture();
    const rt = runtime(location, node, permissions); const h = harness();
    let session = 1; let cancelled = false;
    const s = new DashboardSetupSupervisor({ runtime: { ...rt, getSessionToken: () => session }, harness: Object.assign(h, { isCancelled: () => cancelled }), command: "fake-agent", location });
    await s.launchRequest({ prompt: "Set up dashboard", configPath: location.configPath, componentPath: "root", request: "Set up dashboard", purpose: "edit" });
    await writeFile(location.configPath, stringify({ ...config, root: INVALID_ROOT }));
    if (reason === "navigation") rt.switchConfig("/other/dashboard.yaml");
    if (reason === "cancel") cancelled = true;
    if (reason === "session") session += 1;
    expect((await h.turnEnd())?.status).toBe("cancelled");
    expect(h.followUps).toHaveLength(0);
  });

  test("finishes after the agent replaces the starter and removes its setup node", async () => {
    const { location, node, permissions } = await fixture(); const rt = runtime(location, node, permissions); const h = harness();
    await new DashboardSetupSupervisor({ runtime: rt, harness: h, command: "fake-agent", location }).launchRequest({ prompt: "Set up dashboard", configPath: location.configPath, componentPath: "root", request: "Set up dashboard", purpose: "edit" });
    await writeFile(location.configPath, stringify({ schemaVersion: 4, name: "Finished", root: { component: "./components/external/core/status", props: { label: "Ready", state: "healthy" } } }));
    rt.removeNode();
    expect((await h.turnEnd())?.status).toBe("valid");
  });

  test("reports missing config as a read failure without an automatic repair", async () => {
    const { location, node, permissions } = await fixture(); const rt = runtime(location, node, permissions); const h = harness();
    await new DashboardSetupSupervisor({ runtime: rt, harness: h, command: "fake-agent", location }).launchRequest({ prompt: "Set up dashboard", configPath: location.configPath, componentPath: "root", request: "Set up dashboard", purpose: "edit" });
    await unlink(location.configPath);
    expect((await h.turnEnd())?.status).toBe("failed");
    expect(h.followUps).toHaveLength(0);
  });

  test("new permissions require trust even when the saved dashboard validates", async () => {
    const { location, node, permissions } = await fixture(); const rt = runtime(location, node, permissions); const h = harness();
    await new DashboardSetupSupervisor({ runtime: rt, harness: h, command: "fake-agent", location }).launchRequest({ prompt: "Set up dashboard", configPath: location.configPath, componentPath: "root", request: "Set up dashboard", purpose: "edit" });
    await writeFile(location.configPath, stringify({ schemaVersion: 4, name: "Needs trust", root: { component: "./components/external/core/webview", props: { url: "https://example.com" } } }));
    expect((await h.turnEnd())?.status).toBe("trust-required");
    expect(h.followUps).toHaveLength(0);
  });

  test("local component syntax errors trigger the bounded repair", async () => {
    const { location, node, permissions } = await fixture(); const rt = runtime(location, node, permissions); const h = harness();
    await new DashboardSetupSupervisor({ runtime: rt, harness: h, command: "fake-agent", location }).launchRequest({ prompt: "Set up dashboard", configPath: location.configPath, componentPath: "root", request: "Set up dashboard", purpose: "edit" });
    const directory = `${location.configDirectory}/components/broken`;
    await mkdir(directory, { recursive: true });
    await writeFile(`${directory}/component.yaml`, stringify({ schemaVersion: 3, apiVersion: "2.0.0", id: "broken", name: "Broken", description: "Test component", entry: "./index.tsx", propsSchema: { type: "object" } }));
    await writeFile(`${directory}/index.tsx`, "export default (;");
    await writeFile(location.configPath, stringify({ schemaVersion: 4, name: "Compile check", root: { component: "./components/broken" } }));
    await h.turnEnd();
    expect(h.followUps).toHaveLength(1);
    expect(h.followUps[0]!.prompt).toContain("COMPONENT_COMPILE_FAILED");
  });

  test("repair errors remain visible on the task", async () => {
    const { location, node, config, permissions } = await fixture(); const rt = runtime(location, node, permissions); const h = harness();
    h.followUp = () => { throw new Error("The agent is still working."); };
    await new DashboardSetupSupervisor({ runtime: rt, harness: h, command: "fake-agent", location }).launchRequest({ prompt: "Set up dashboard", configPath: location.configPath, componentPath: "root", request: "Set up dashboard", purpose: "edit" });
    await writeFile(location.configPath, stringify({ ...config, root: INVALID_ROOT }));
    expect(await h.turnEnd()).toMatchObject({ status: "failed", diagnostics: [{ severity: "error", code: "DASHBOARD_SETUP_FOLLOWUP_FAILED", message: "The agent is still working." }] });
  });
});

test.each(["edit", "migration"] as const)("%s uses the shared verification boundary with one repair", async (purpose) => {
  const { location, node, permissions } = await fixture();
  const rt = runtime(location, node, permissions); const h = harness();
  const s = new DashboardSetupSupervisor({ runtime: rt, harness: h, command: "fake-agent", location });
  await s.launchRequest({ purpose, prompt: "Change the selected dashboard", configPath: location.configPath, componentPath: `${location.configPath}#root`, request: "Change dashboard" });
  await writeFile(location.configPath, "schemaVersion: 4\nroot: invalid\n");
  await h.turnEnd();
  expect(h.followUps).toHaveLength(1);
  expect((await h.turnEnd())?.status).toBe("failed");
  expect(h.followUps).toHaveLength(1);
});

test.each(["edit", "migration"] as const)("%s respects migration authorization when an agent leaves schema v2", async (purpose) => {
  const { location, node, permissions } = await fixture();
  const rt = runtime(location, node, permissions); const h = harness();
  const s = new DashboardSetupSupervisor({ runtime: rt, harness: h, command: "fake-agent", location });
  await s.launchRequest({ purpose, prompt: "Change the selected dashboard", configPath: location.configPath, componentPath: `${location.configPath}#root`, request: "Change dashboard" });
  await writeFile(location.configPath, "schemaVersion: 2\nname: Old dashboard\nroot:\n  component: \"./components/external/core/group\"\n");
  await h.turnEnd();
  expect(h.followUps).toHaveLength(purpose === "migration" ? 1 : 0);
  if (purpose === "migration") await h.turnEnd();
  expect(h.launches[0]!.validations.at(-1)?.status).toBe("failed");
});

describe("DashboardSetupSupervisor with a real ACP session", () => {
  async function until(sessions: AgentSessions, id: string, predicate: (task: AgentSessionTask) => boolean): Promise<AgentSessionTask> {
    const deadline = Date.now() + 15_000;
    while (true) {
      const current = sessions.get(id);
      if (predicate(current)) return current;
      if (Date.now() > deadline) throw new Error(`Timed out: ${JSON.stringify({ state: current.state, validation: current.validation, error: current.error })}`);
      await Bun.sleep(10);
    }
  }

  test("validates when the turn ends and repairs in the same session", async () => {
    const { location, node, config, permissions } = await fixture();
    const rt = { ...runtime(location, node, permissions), getLaunchEnvironment: async () => process.env as Record<string, string> };
    const sessions = new AgentSessions({ emitDelayMs: 5, shutdownGraceMs: 300 });
    cleanup.push(() => sessions.shutdown());
    const statuses: string[] = [];
    const supervisor = new DashboardSetupSupervisor({ runtime: rt, harness: sessions, command: FAKE_COMMAND, location, onValidation: (validation) => statuses.push(validation.status) });
    const { taskId, pid } = await supervisor.launchRequest({ purpose: "edit", prompt: "bundle-edit the dashboard", configPath: location.configPath, componentPath: `${location.configPath}#root`, request: "Edit" });

    let task = await until(sessions, taskId, (candidate) => candidate.state === "waiting");
    // Validation runs on turn end, not before.
    expect(task.validation).toBeUndefined();
    await writeFile(location.configPath, stringify({ ...config, root: INVALID_ROOT }));
    sessions.answerPermission(taskId, task.permission!.id, "allow");

    task = await until(sessions, taskId, (candidate) => candidate.state === "waiting" && candidate.turns === 1);
    expect(task.validation?.status).toBe("repairing");
    expect(task.sessionId).toBe("fake-session-1");
    expect(task.pid).toBe(pid);
    const repairPrompt = task.entries.filter((entry) => entry.kind === "user").at(-1);
    expect(repairPrompt).toMatchObject({ kind: "user", text: expect.stringContaining("COMPONENT_PROPS_INVALID") });
    expect(() => sessions.prompt(taskId, "user follow-up")).toThrow("still working");

    await writeFile(location.configPath, stringify(config));
    sessions.answerPermission(taskId, task.permission!.id, "allow");
    task = await until(sessions, taskId, (candidate) => candidate.validation?.status === "valid");
    expect(task).toMatchObject({ state: "idle", turns: 2, stopReason: "end_turn" });
    expect(statuses).toEqual(["checking", "repairing", "checking", "valid"]);
  });

  test("a refused turn is reported as failed without a repair", async () => {
    const { location, node, config, permissions } = await fixture();
    await writeFile(location.configPath, stringify({ ...config, root: INVALID_ROOT }));
    const rt = { ...runtime(location, node, permissions), getLaunchEnvironment: async () => process.env as Record<string, string> };
    const sessions = new AgentSessions({ emitDelayMs: 5, shutdownGraceMs: 300 });
    cleanup.push(() => sessions.shutdown());
    const supervisor = new DashboardSetupSupervisor({ runtime: rt, harness: sessions, command: FAKE_COMMAND, location });
    const { taskId } = await supervisor.launchRequest({ purpose: "edit", prompt: "refuse", configPath: location.configPath, componentPath: `${location.configPath}#root`, request: "Edit" });
    const task = await until(sessions, taskId, (candidate) => candidate.validation?.status === "failed");
    expect(task).toMatchObject({ state: "idle", turns: 1, stopReason: "refusal" });
    expect(task.validation?.message).toContain("refusal");
    // No repair follow-up was sent (the first prompt is not a transcript entry).
    expect(task.entries.filter((entry) => entry.kind === "user")).toHaveLength(0);
  });
});
