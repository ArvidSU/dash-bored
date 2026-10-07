import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { stringify } from "yaml";
import { ProjectRuntime, TrustStore } from "../../src/core";
import { AgentLauncher } from "../../src/main/agent-launch";
import type { DashboardAgentHarness } from "../../src/main/component-agent";
import type { AppSettingsStore } from "../../src/main/app-settings";
import { createProject, removeTemporaryDirectory, temporaryDirectory } from "../core/helpers";

const cleanup: string[] = [];
const runtimes: ProjectRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(cleanup.splice(0).map(removeTemporaryDirectory));
});

test("diagnostics repair requires normal trust, then uses the trusted bundle environment", async () => {
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
  const settings = { get: async () => ({ dashBoredAgent: null }) } as unknown as AppSettingsStore;
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
  await expect(launcher.launch({ kind: "diagnostics" })).rejects.toMatchObject({ code: "PROJECT_UNTRUSTED" });
  expect(launchOptions).toBeUndefined();
  await runtime.trust();
  const launched = await launcher.launch({ kind: "diagnostics" });
  expect(launched.command).toBe("/bin/echo");
  expect(launchOptions?.purpose).toBe("edit");
  expect(launchOptions?.onFinished).toBeFunction();
  expect(launchOptions?.env?.PROJECT_VALUE).toBe("available");
  expect(launchOptions?.prompt).toContain("CONFIG_SCHEMA_INVALID");
});
