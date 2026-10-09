import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { stringify } from "yaml";
import { ProjectRuntime, TrustStore } from "../../src/core";
import { AgentLauncher } from "../../src/main/agent-launch";
import type { DashboardAgentHarness } from "../../src/main/component-agent";
import type { AppSettingsStore } from "../../src/main/app-settings";
import type { AgentCommandChoice } from "../../src/shared/contracts";
import { createProject, removeTemporaryDirectory, temporaryDirectory } from "../core/helpers";

const cleanup: string[] = [];
const runtimes: ProjectRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(cleanup.splice(0).map(removeTemporaryDirectory));
});

test("diagnostics repair runs untrusted with a clean environment, then uses the trusted bundle environment", async () => {
  const root = await temporaryDirectory();
  cleanup.push(root);
  const config = { schemaVersion: 4 as const, name: "Repairable", root: {
    id: "test", component: "./components/external/core/markdown", props: { content: "Ready" },
  } };
  await createProject(root, config);
  const configPath = join(root, ".dash-bored", "dash-bored.yaml");
  await writeFile(configPath, stringify({ ...config, schemaVersion: 3 }));
  await writeFile(join(root, ".dash-bored", ".env"), "DASH_BORED_AGENT=/bin/echo\nPROJECT_VALUE=available\n");
  const runtime = new ProjectRuntime({ trustStore: new TrustStore(join(root, "state", "trust.json")) });
  runtimes.push(runtime);
  await runtime.load(root);
  const settings = { get: async () => ({ dashBoredAgent: "/bin/echo" }) } as unknown as AppSettingsStore;
  let launchOptions: Parameters<DashboardAgentHarness["launch"]>[0] | undefined;
  const harness = {
    launch: async (options: Parameters<DashboardAgentHarness["launch"]>[0]) => {
      launchOptions = options;
      return { taskId: "diagnostics-task", command: options.command, componentPath: options.componentPath, pid: 123 };
    },
  } as unknown as DashboardAgentHarness;
  const launcher = new AgentLauncher({ runtime, harness, settings,
    publishedEnvironment: () => ({ APP_PUBLISHED_VALUE: "available" }),
  });
  // Untrusted repair: launches without a trust grant and never receives
  // project-controlled bundle values.
  const untrusted = await launcher.launch({ kind: "diagnostics" });
  expect(untrusted.command).toBe("/bin/echo");
  expect(launchOptions?.purpose).toBe("edit");
  expect(launchOptions?.onFinished).toBeFunction();
  expect(launchOptions?.env?.PROJECT_VALUE).toBeUndefined();
  expect(launchOptions?.env?.APP_PUBLISHED_VALUE).toBe("available");
  expect(launchOptions?.prompt).toContain("untrusted data");
  expect(launchOptions?.prompt).toContain("CONFIG_SCHEMA_INVALID");
  await runtime.trust();
  const launched = await launcher.launch({ kind: "diagnostics" });
  expect(launched.command).toBe("/bin/echo");
  expect(launchOptions?.purpose).toBe("edit");
  expect(launchOptions?.onFinished).toBeFunction();
  expect(launchOptions?.env?.PROJECT_VALUE).toBe("available");
  expect(launchOptions?.prompt).toContain("CONFIG_SCHEMA_INVALID");
  expect(launchOptions?.prompt).not.toContain("untrusted data");
});

test("an untrusted repair cannot select its agent command from the bundle", async () => {
  const root = await temporaryDirectory();
  cleanup.push(root);
  const config = { schemaVersion: 4 as const, name: "Selectable", root: {
    id: "test", component: "./components/external/core/markdown", props: { content: "Ready" },
  } };
  await createProject(root, config);
  const configPath = join(root, ".dash-bored", "dash-bored.yaml");
  await writeFile(join(root, ".dash-bored", ".env"), "DASH_BORED_AGENT=/bin/echo\n");
  const runtime = new ProjectRuntime({ trustStore: new TrustStore(join(root, "state", "trust.json")) });
  runtimes.push(runtime);
  await runtime.load(root);
  const settings = { get: async () => ({ dashBoredAgent: null }) } as unknown as AppSettingsStore;
  const harness = {
    launch: async (options: Parameters<DashboardAgentHarness["launch"]>[0]) =>
      ({ taskId: "t", command: options.command, componentPath: options.componentPath, pid: 123 }),
  } as unknown as DashboardAgentHarness;
  const launcher = new AgentLauncher({ runtime, harness, settings, publishedEnvironment: () => ({}) });
  expect(await launcher.command(configPath, { bundleless: true })).not.toBe("/bin/echo");
  expect(await launcher.command(configPath)).toBe("/bin/echo");
});

test("the composer's command choice selects the app, bundle, or a custom command", async () => {
  const root = await temporaryDirectory();
  cleanup.push(root);
  const config = { schemaVersion: 4 as const, name: "Choosable", root: {
    id: "test", component: "./components/external/core/markdown", props: { content: "Ready" },
  } };
  await createProject(root, config);
  const configPath = join(root, ".dash-bored", "dash-bored.yaml");
  await writeFile(join(root, ".dash-bored", ".env"), "DASH_BORED_AGENT=/bin/echo\n");
  const runtime = new ProjectRuntime({ trustStore: new TrustStore(join(root, "state", "trust.json")) });
  runtimes.push(runtime);
  await runtime.load(root);
  await runtime.trust();
  let appSetting: string | null = "/usr/bin/true";
  const settings = { get: async () => ({ dashBoredAgent: appSetting }) } as unknown as AppSettingsStore;
  const harness = {
    launch: async (options: Parameters<DashboardAgentHarness["launch"]>[0]) =>
      ({ taskId: "t", command: options.command, componentPath: options.componentPath, pid: 123 }),
  } as unknown as DashboardAgentHarness;
  const launcher = new AgentLauncher({ runtime, harness, settings, publishedEnvironment: () => ({}) });

  expect(await launcher.commandOptions(configPath)).toEqual({ app: "/usr/bin/true", project: "/bin/echo", effective: "app" });
  const preview = await launcher.preview({ nodeId: "test", prompt: "" });
  expect(preview.agents.project).toBe("/bin/echo");
  const launch = (agent?: AgentCommandChoice) =>
    launcher.launch({ kind: "component", nodeId: "test", prompt: "Do it.", ...(agent ? { agent } : {}) });
  expect((await launch()).command).toBe("/usr/bin/true");
  expect((await launch({ source: "project" })).command).toBe("/bin/echo");
  expect((await launch({ source: "custom", command: "  /bin/cat  " })).command).toBe("/bin/cat");
  await expect(launch({ source: "custom", command: " " })).rejects.toThrow("DASH_BORED_AGENT");

  // A cleared app setting means the bundle wins by default, and "app" is the built-in default.
  appSetting = null;
  expect(await launcher.commandOptions(configPath)).toEqual({ app: "codex exec", project: "/bin/echo", effective: "project" });
  await writeFile(join(root, ".dash-bored", ".env"), "OTHER=1\n");
  expect((await launcher.commandOptions(configPath)).project).toBeNull();
  await expect(launch({ source: "project" })).rejects.toThrow("does not set DASH_BORED_AGENT");
});
