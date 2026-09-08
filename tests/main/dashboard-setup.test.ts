import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { stringify, parse } from "yaml";
import type { ComponentAgentLaunch, DashboardAgentTask, Permission, ProcessSnapshot, ResolvedComponentNode } from "../../src/shared/contracts";
import { ensureProjectFiles, loadProjectDefinition, resolveProjectLocation } from "../../src/core";
import { DashboardSetupSupervisor } from "../../src/main/dashboard-setup";
import { DashboardAgentHarness } from "../../src/main/component-agent";
import { removeTemporaryDirectory, temporaryDirectory } from "../core/helpers";

const cleanup: string[] = [];
afterEach(async () => Promise.all(cleanup.splice(0).map(removeTemporaryDirectory)));

function task(phase: ProcessSnapshot["phase"] = "exited", exitCode: number | null = 0, signal: string | null = null): DashboardAgentTask {
  return { id: `task-${Math.random()}`, command: "fake-agent", prompt: "original", componentPath: "config#setup", request: "Set up this dashboard", configPath: "", dashboardChanged: false, process: { id: "p", phase, pid: null, exitCode, signal, logs: [] } };
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
  const root = await temporaryDirectory(); cleanup.push(root);
  await ensureProjectFiles(root);
  const location = await resolveProjectLocation(root);
  const config = parse(await readFile(location.configPath, "utf8"));
  const node: ResolvedComponentNode = { id: "setup", component: "@dash-bored/setup-agent", props: {}, source: "builtin", sourceConfigPath: location.configPath, sourcePath: "root", manifest: { schemaVersion: 2, id: "@dash-bored/setup-agent", name: "Setup", description: "", entry: "builtin:setup-agent", propsSchema: {}, permissions: ["process:execute"] } };
  const definition = await loadProjectDefinition(location, { compile: true });
  return { location, node, config, permissions: definition.permissions };
}

function harness() {
  const launches: any[] = [];
  return { launches, setValidation(id: string, validation: DashboardAgentTask["validation"]) { launches.find((x) => x.task.id === id)?.validations.push(validation); }, launch(options: any): Promise<ComponentAgentLaunch> { const t = task(); t.configPath = options.configPath; launches.push({ options, task: t, validations: [] }); return Promise.resolve({ taskId: t.id, command: options.command, componentPath: options.componentPath, pid: null }); } };
}

describe("DashboardSetupSupervisor", () => {
  test("a real PTY agent exit reaches the app validation verdict", async () => {
    const { location, node, permissions } = await fixture();
    const rt = runtime(location, node, permissions);
    const h = new DashboardAgentHarness();
    try {
      await new DashboardSetupSupervisor({ runtime: rt, harness: h, command: "sh -c 'exit 0'", location }).launch(node);
      const deadline = Date.now() + 5_000;
      while (h.list()[0]?.validation?.status !== "valid" && Date.now() < deadline) await Bun.sleep(10);
      expect(h.list()[0]).toMatchObject({ process: { phase: "exited", exitCode: 0 }, validation: { status: "valid" } });
    } finally {
      await h.close();
    }
  });

  test("passes resolved launch environment and validates a successful fresh config", async () => {
    const { location, node, permissions } = await fixture(); const rt = runtime(location, node, permissions); const h = harness();
    await new DashboardSetupSupervisor({ runtime: rt, harness: h, command: "fake-agent", location }).launch(node);
    expect(h.launches[0].options.env).toEqual({ DASH_BORED_AGENT: "fake-agent" });
    await h.launches[0].options.onFinished(h.launches[0].task);
    expect(h.launches[0].validations.at(-1).status).toBe("valid");
    expect(h.launches).toHaveLength(1);
  });

  test("repairs invalid config once and validates the repair", async () => {
    const { location, node, config, permissions } = await fixture(); const rt = runtime(location, node, permissions); const h = harness();
    await writeFile(location.configPath, stringify({ ...config, root: { component: "@dash-bored/setup-agent", props: { unexpected: true } } }));
    const supervisor = new DashboardSetupSupervisor({ runtime: rt, harness: h, command: "fake-agent", location }); await supervisor.launch(node);
    await h.launches[0].options.onFinished(h.launches[0].task);
    expect(h.launches).toHaveLength(2); expect(h.launches[1].options.componentPath).toBe(`${location.configPath}#diagnostics`);
    await writeFile(location.configPath, stringify(config));
    await h.launches[1].options.onFinished(h.launches[1].task);
    expect(h.launches[1].validations.at(-1).status).toBe("valid");
  });

  test.each([[1, null], [0, "SIGTERM"]] as const)("does not repair non-clean finish %j", async (exitCode, signal) => {
    const { location, node } = await fixture(); const rt = runtime(location, node); const h = harness(); const s = new DashboardSetupSupervisor({ runtime: rt, harness: h, command: "fake-agent", location }); await s.launch(node); const t = h.launches[0].task; t.process = { ...t.process, exitCode, signal }; await h.launches[0].options.onFinished(t); expect(h.launches).toHaveLength(1);
  });

  test("does not repair after active config switch or trust revoke", async () => {
    const { location, node, config } = await fixture(); await writeFile(location.configPath, stringify({ ...config, root: { component: "@dash-bored/setup-agent", props: { unexpected: true } } }));
    const rt = runtime(location, node); const h = harness(); const s = new DashboardSetupSupervisor({ runtime: rt, harness: h, command: "fake-agent", location }); await s.launch(node); rt.revoke(); await h.launches[0].options.onFinished(h.launches[0].task); expect(h.launches).toHaveLength(1); expect(h.launches[0].validations.at(-1).status).toBe("trust-required");
  });

  test("does not retry twice when repair remains invalid", async () => {
    const { location, node, config } = await fixture(); await writeFile(location.configPath, stringify({ ...config, root: { component: "@dash-bored/setup-agent", props: { unexpected: true } } }));
    const rt = runtime(location, node); const h = harness(); const s = new DashboardSetupSupervisor({ runtime: rt, harness: h, command: "fake-agent", location }); await s.launch(node); await h.launches[0].options.onFinished(h.launches[0].task); await h.launches[1].options.onFinished(h.launches[1].task); expect(h.launches).toHaveLength(2);
  });
  test.each(["navigation", "cancel", "session"] as const)("does not repair after %s", async (reason) => {
    const { location, node, config, permissions } = await fixture();
    const rt = runtime(location, node, permissions); const h = harness();
    let session = 1; let cancelled = false;
    const s = new DashboardSetupSupervisor({ runtime: { ...rt, getSessionToken: () => session }, harness: { ...h, isCancelled: () => cancelled }, command: "fake-agent", location });
    await s.launch(node);
    await writeFile(location.configPath, stringify({ ...config, root: { component: "@dash-bored/setup-agent", props: { unexpected: true } } }));
    if (reason === "navigation") rt.switchConfig("/other/dashboard.yaml");
    if (reason === "cancel") cancelled = true;
    if (reason === "session") session += 1;
    await h.launches[0].options.onFinished(h.launches[0].task);
    expect(h.launches).toHaveLength(1);
    expect(h.launches[0].validations.at(-1).status).toBe("cancelled");
  });

  test("finishes after the agent replaces the starter and removes its setup node", async () => {
    const { location, node, permissions } = await fixture(); const rt = runtime(location, node, permissions); const h = harness();
    await new DashboardSetupSupervisor({ runtime: rt, harness: h, command: "fake-agent", location }).launch(node);
    await writeFile(location.configPath, stringify({ schemaVersion: 2, name: "Finished", root: { component: "@dash-bored/status", props: { label: "Ready", state: "healthy" } } }));
    rt.removeNode();
    await h.launches[0].options.onFinished(h.launches[0].task);
    expect(h.launches[0].validations.at(-1).status).toBe("valid");
  });

  test("reports missing config as a read failure without an automatic repair", async () => {
    const { location, node, permissions } = await fixture(); const rt = runtime(location, node, permissions); const h = harness();
    await new DashboardSetupSupervisor({ runtime: rt, harness: h, command: "fake-agent", location }).launch(node);
    await unlink(location.configPath);
    await h.launches[0].options.onFinished(h.launches[0].task);
    expect(h.launches).toHaveLength(1);
    expect(h.launches[0].validations.at(-1).status).toBe("failed");
  });

  test("new permissions require trust even when the saved dashboard validates", async () => {
    const { location, node, permissions } = await fixture(); const rt = runtime(location, node, permissions); const h = harness();
    await new DashboardSetupSupervisor({ runtime: rt, harness: h, command: "fake-agent", location }).launch(node);
    await writeFile(location.configPath, stringify({ schemaVersion: 2, name: "Needs trust", root: { component: "@dash-bored/webview", props: { url: "https://example.com" } } }));
    await h.launches[0].options.onFinished(h.launches[0].task);
    expect(h.launches).toHaveLength(1);
    expect(h.launches[0].validations.at(-1).status).toBe("trust-required");
  });

  test("local component syntax errors trigger the bounded repair", async () => {
    const { location, node, permissions } = await fixture(); const rt = runtime(location, node, permissions); const h = harness();
    await new DashboardSetupSupervisor({ runtime: rt, harness: h, command: "fake-agent", location }).launch(node);
    const directory = `${location.configDirectory}/components/broken`;
    await mkdir(directory, { recursive: true });
    await writeFile(`${directory}/component.yaml`, stringify({ schemaVersion: 2, id: "broken", name: "Broken", description: "Test component", entry: "./index.tsx", propsSchema: { type: "object" } }));
    await writeFile(`${directory}/index.tsx`, "export default (;");
    await writeFile(location.configPath, stringify({ schemaVersion: 2, name: "Compile check", root: { component: "./components/broken" } }));
    await h.launches[0].options.onFinished(h.launches[0].task);
    expect(h.launches).toHaveLength(2);
    expect(h.launches[1].options.prompt).toContain("COMPONENT_COMPILE_FAILED");
  });

  test("repair launch errors remain visible on the original task", async () => {
    const { location, node, config, permissions } = await fixture(); const rt = runtime(location, node, permissions); const h = harness();
    const realLaunch = h.launch;
    h.launch = (options: any) => h.launches.length ? Promise.reject(new Error("repair executable unavailable")) : realLaunch(options);
    await new DashboardSetupSupervisor({ runtime: rt, harness: h, command: "fake-agent", location }).launch(node);
    await writeFile(location.configPath, stringify({ ...config, root: { component: "@dash-bored/setup-agent", props: { unexpected: true } } }));
    await h.launches[0].options.onFinished(h.launches[0].task);
    expect(h.launches[0].validations.at(-1)).toMatchObject({ status: "failed", diagnostics: [{ severity: "error", code: "DASHBOARD_SETUP_FOLLOWUP_FAILED", message: "repair executable unavailable" }] });
  });

});

test.each(['edit', 'migration'] as const)('%s uses the shared verification boundary with one repair', async purpose => {
  const { location, node, permissions } = await fixture();
  const rt = runtime(location, node, permissions); const h = harness();
  const s = new DashboardSetupSupervisor({ runtime: rt, harness: h, command: 'fake-agent', location });
  await s.launchRequest({ purpose, prompt: 'Change the selected dashboard', configPath: location.configPath, componentPath: `${location.configPath}#root`, request: 'Change dashboard' });
  await writeFile(location.configPath, 'schemaVersion: 2\nroot: invalid\n');
  await h.launches[0].options.onFinished(h.launches[0].task);
  expect(h.launches).toHaveLength(2);
  await h.launches[1].options.onFinished(h.launches[1].task);
  expect(h.launches).toHaveLength(2);
  expect(h.launches[0].validations.at(-1).status).toBe('failed');
});
