import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { stringify } from "yaml";
import { ProjectRuntime, TrustStore } from "../../src/core";
import { AgentConfigMemory } from "../../src/main/agent-config-memory";
import { AgentLauncher, type AgentLauncherOptions } from "../../src/main/agent-launch";
import type { AgentSessionLaunchOptions, AgentSessions } from "../../src/main/agent-sessions";
import type { AgentCommandChoice, DetectedAgent } from "../../src/shared/agent-session";
import { KNOWN_AGENTS } from "../../src/shared/agent-catalog";
import { createProject, installCoreFixture, removeTemporaryDirectory, temporaryDirectory } from "../core/helpers";

const cleanup: string[] = [];
const runtimes: ProjectRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(cleanup.splice(0).map(removeTemporaryDirectory));
});

const GEMINI: DetectedAgent = { id: "gemini", name: "Gemini CLI", command: "gemini --acp", resumable: true };

async function setup(environment: string, appSetting: { value: string | null; enabledAgentIds?: string[] }, detected: DetectedAgent[] = [], extra: Partial<AgentLauncherOptions> = {}) {
  const root = await temporaryDirectory();
  cleanup.push(root);
  const config = { schemaVersion: 4 as const, name: "Agents", root: {
    id: "test", component: "./components/external/core/markdown", props: { content: "Ready" },
  } };
  await createProject(root, config);
  const configPath = join(root, ".dash-bored", "dash-bored.yaml");
  await writeFile(join(root, ".dash-bored", ".env"), environment);
  const runtime = new ProjectRuntime({ trustStore: new TrustStore(join(root, "state", "trust.json")) });
  runtimes.push(runtime);
  await runtime.load(root);
  const launches: AgentSessionLaunchOptions[] = [];
  const sessions = {
    launch: async (options: AgentSessionLaunchOptions) => {
      launches.push(options);
      return { taskId: `task-${launches.length}`, command: options.command, componentPath: options.componentPath, pid: 123 };
    },
    list: () => [],
    followUp: () => undefined,
    setValidation: () => undefined,
  } as unknown as AgentSessions;
  const launcher = new AgentLauncher({
    runtime,
    sessions,
    settings: { get: async () => ({ dashBoredAgent: appSetting.value, enabledAgentIds: appSetting.enabledAgentIds }) } as never,
    publishedEnvironment: () => ({ APP_PUBLISHED_VALUE: "available" }),
    detect: () => detected,
    packageRunner: () => "npx",
    ...extra,
  });
  return { root: await realpath(root), config, configPath: await realpath(configPath), runtime, launcher, launches };
}

test("diagnostics repair runs untrusted with a clean environment, then uses the trusted bundle environment", async () => {
  const { root, config, configPath, runtime, launcher, launches } = await setup("DASH_BORED_AGENT=/bin/echo\nPROJECT_VALUE=available\n", { value: "/bin/echo" });
  await writeFile(configPath, stringify({ ...config, schemaVersion: 3 }));
  await runtime.reload();
  // Untrusted repair: launches without a trust grant and never receives
  // project-controlled bundle values; permission requests outside the bundle are refused.
  const untrusted = await launcher.launch({ kind: "diagnostics" });
  expect(untrusted.command).toBe("/bin/echo");
  expect(launches[0]).toMatchObject({ purpose: "edit", untrusted: true, projectRoot: root, bundleDirectory: join(root, ".dash-bored") });
  expect(launches[0]!.onTurnEnd).toBeFunction();
  expect(launches[0]!.env?.PROJECT_VALUE).toBeUndefined();
  expect(launches[0]!.env?.APP_PUBLISHED_VALUE).toBe("available");
  expect(launches[0]!.prompt).toContain("untrusted data");
  expect(launches[0]!.prompt).toContain("CONFIG_SCHEMA_INVALID");
  await runtime.trust();
  const launched = await launcher.launch({ kind: "diagnostics" });
  expect(launched.command).toBe("/bin/echo");
  expect(launches[1]!.untrusted).toBeUndefined();
  expect(launches[1]!.onTurnEnd).toBeFunction();
  expect(launches[1]!.env?.PROJECT_VALUE).toBe("available");
  expect(launches[1]!.prompt).toContain("CONFIG_SCHEMA_INVALID");
  expect(launches[1]!.prompt).not.toContain("untrusted data");
});

test("an untrusted repair cannot select its agent command from the bundle", async () => {
  const detected: DetectedAgent[] = [];
  const { configPath, launcher } = await setup("DASH_BORED_AGENT=/bin/echo\n", { value: null }, detected);
  await expect(launcher.command(configPath, { bundleless: true })).rejects.toMatchObject({ code: "AGENT_UNAVAILABLE" });
  detected.push(GEMINI);
  expect(await launcher.command(configPath, { bundleless: true })).toBe("gemini --acp");
  expect(await launcher.command(configPath)).toBe("/bin/echo");
});

test("an omitted choice resolves the app setting, then the bundle, then the first detected agent", async () => {
  const app = { value: "/usr/bin/true" as string | null };
  const detected: DetectedAgent[] = [GEMINI];
  const { root, configPath, launcher } = await setup("DASH_BORED_AGENT=/bin/echo\n", app, detected);
  expect(await launcher.resolve(configPath)).toEqual({ source: "app", command: "/usr/bin/true", name: "true" });
  app.value = null;
  expect(await launcher.resolve(configPath)).toEqual({ source: "project", command: "/bin/echo", name: "echo" });
  await writeFile(join(root, ".dash-bored", ".env"), "OTHER=1\n");
  expect(await launcher.resolve(configPath)).toEqual({ source: "detected", command: "gemini --acp", name: "Gemini CLI" });
  detected.splice(0);
  const error = await launcher.resolve(configPath).catch((caught: unknown) => caught);
  expect(error).toMatchObject({ code: "AGENT_UNAVAILABLE" });
  expect(String((error as Error).message)).toContain("Settings → General → Dashboard agent");
});

test("a detected choice is re-resolved from the catalog, never from the request", async () => {
  const { configPath, launcher } = await setup("", { value: null }, [{ id: "codex", name: "Codex", command: "codex-acp", resumable: true }]);
  const forged = { source: "detected", id: "codex", command: "rm -rf ~" } as unknown as AgentCommandChoice;
  expect(await launcher.resolve(configPath, forged)).toEqual({ source: "detected", command: "codex-acp", name: "Codex" });
  await expect(launcher.resolve(configPath, { source: "detected", id: "nope" })).rejects.toMatchObject({ code: "AGENT_UNAVAILABLE" });
});

test("the composer's choice selects the app, bundle, or a custom command", async () => {
  const app = { value: "/usr/bin/true" as string | null };
  const { root, configPath, runtime, launcher } = await setup("DASH_BORED_AGENT=/bin/echo\n", app, [GEMINI]);
  await runtime.trust();
  expect(await launcher.agentOptions(configPath)).toMatchObject({
    app: "/usr/bin/true",
    project: "/bin/echo",
    detected: [GEMINI],
    known: KNOWN_AGENTS.map((agent) => ({ ...agent })),
    effective: { source: "app", command: "/usr/bin/true", name: "true" },
  });
  // Settings has no bundle.
  expect(await launcher.agentOptions()).toMatchObject({ project: null, effective: { source: "app" } });
  const preview = await launcher.preview({ nodeIds: ["test"], prompt: "" });
  expect(preview.agents.project).toBe("/bin/echo");
  const launch = (agent?: AgentCommandChoice) =>
    launcher.launch({ kind: "component", nodeIds: ["test"], prompt: "Do it.", ...(agent ? { agent } : {}) });
  expect((await launch()).command).toBe("/usr/bin/true");
  expect((await launch({ source: "project" })).command).toBe("/bin/echo");
  expect((await launch({ source: "custom", command: "  /bin/cat  " })).command).toBe("/bin/cat");
  await expect(launch({ source: "custom", command: " " })).rejects.toThrow("DASH_BORED_AGENT");

  app.value = null;
  expect((await launcher.agentOptions(configPath)).effective).toEqual({ source: "project", command: "/bin/echo", name: "echo" });
  await expect(launch({ source: "app" })).rejects.toThrow("No app-wide agent");
  await writeFile(join(root, ".dash-bored", ".env"), "OTHER=1\n");
  expect(await launcher.agentOptions(configPath)).toMatchObject({ project: null, effective: { source: "detected", command: "gemini --acp" } });
  await expect(launch({ source: "project" })).rejects.toThrow("does not set DASH_BORED_AGENT");
});

test("composer config choices are checked, set before the first prompt, and offered again", async () => {
  const state = await temporaryDirectory();
  cleanup.push(state);
  const configMemory = new AgentConfigMemory(join(state, "agent-config.json"));
  const { configPath, runtime, launcher, launches } = await setup("", { value: "/usr/bin/true" }, [], { configMemory });
  await runtime.trust();
  await configMemory.offered("/usr/bin/true", [{ id: "effort", name: "Effort", type: "select", currentValue: "default", options: [{ value: "high", name: "High" }] }]);
  const launch = (config?: unknown) =>
    launcher.launch({ kind: "component", nodeIds: ["test"], prompt: "Do it.", ...(config === undefined ? {} : { config }) } as never);

  await launch({ effort: "high", fast: true });
  expect(launches[0]!.config).toEqual({ effort: "high", fast: true });
  expect((await launcher.agentOptions(configPath)).config?.["/usr/bin/true"]?.chosen).toEqual({ effort: "high", fast: true });
  // Nothing chosen returns every option to the agent's default.
  await launch({});
  expect(launches[1]!.config).toBeUndefined();
  expect((await launcher.preview({ nodeIds: ["test"], prompt: "" })).agents.config?.["/usr/bin/true"]).toMatchObject({ chosen: {} });
  // A launch without the composer's options leaves the remembered choices alone.
  await configMemory.chose("/usr/bin/true", { effort: "high" });
  await launch();
  expect((await launcher.agentOptions(configPath)).config?.["/usr/bin/true"]?.chosen).toEqual({ effort: "high" });
  for (const config of [[], { effort: 3 }, { "": "high" }, Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`o${index}`, true]))]) {
    await expect(launch(config)).rejects.toMatchObject({ code: "COMPONENT_AGENT_CONFIG_INVALID" });
  }
  expect(launches).toHaveLength(3);
});

test("enabled packages resolve in main and stale disabled picker choices are rejected", async () => {
  const app = { value: null, enabledAgentIds: ["codex"] };
  const { configPath, launcher } = await setup("", app);
  expect((await launcher.resolve(configPath, { source: "detected", id: "codex" })).command).toBe("npx -y @agentclientprotocol/codex-acp");
  app.enabledAgentIds = [];
  await expect(launcher.resolve(configPath, { source: "detected", id: "codex" })).rejects.toMatchObject({ code: "AGENT_UNAVAILABLE" });
  await expect(launcher.resolve(configPath)).rejects.toMatchObject({ code: "AGENT_UNAVAILABLE" });
  expect((await launcher.agentOptions()).setup?.find((agent) => agent.id === "codex")?.enabled).toBe(false);
});

test("project work is not validated; dashboard work validates on each turn end", async () => {
  const { configPath, runtime, launcher, launches } = await setup("", { value: "/usr/bin/true" });
  await runtime.trust();
  await launcher.launch({ kind: "component", nodeIds: ["test"], prompt: "Implement it.", template: "project" });
  expect(launches[0]).toMatchObject({ purpose: "project", template: "project", configPath });
  expect(launches[0]!.onTurnEnd).toBeUndefined();
  await launcher.launch({ kind: "component", nodeIds: ["test"], prompt: "Retitle it.", template: "dashboard" });
  expect(launches[1]).toMatchObject({ purpose: "edit", template: "dashboard" });
  expect(launches[1]!.onTurnEnd).toBeFunction();
});

test("several picked components brief one agent; targets across bundles are refused", async () => {
  const { root, configPath, runtime, launcher, launches } = await setup("", { value: "/usr/bin/true" });
  const linked = join(root, ".dash-bored", "linked");
  await mkdir(join(linked, "components"), { recursive: true });
  await mkdir(join(linked, "prompts"));
  await mkdir(join(root, ".dash-bored", "prompts"));
  await writeFile(join(root, ".dash-bored", "prompts", "root-only.md"), "---\ndescription: Root work\nscope: project\n---\n{{input}}\n");
  await writeFile(join(linked, "prompts", "linked-only.md"), "---\ndescription: Linked dashboard work\nscope: dashboard\ninput: optional\nvars:\n  id: Target ID\n---\n{{vars.id}}\n");
  await installCoreFixture(linked);
  await Promise.all([
    writeFile(join(linked, "dash-bored.yaml"), stringify({
      schemaVersion: 4, name: "Linked", root: { id: "linked-note", component: "./components/external/core/markdown", props: { content: "Linked" } },
    })),
    writeFile(join(linked, "dash-bored-lock.yaml"), stringify({ lockfileVersion: 1, components: {} })),
  ]);
  await writeFile(configPath, stringify({ schemaVersion: 4, name: "Agents", root: {
    component: "./components/external/core/tabs",
    children: [
      { node: { id: "notes", component: "./components/external/core/markdown", props: { content: "Notes" } }, metadata: { label: "Notes" } },
      { node: { id: "status", component: "./components/external/core/status", props: { label: "Ready", state: "healthy" } }, metadata: { label: "Status" } },
      { node: { id: "personal", component: "./linked" }, metadata: { label: "Linked" } },
    ],
  } }));
  await runtime.reload();
  await runtime.trust();
  expect(runtime.getSnapshot().diagnostics).toEqual([]);

  expect((await launcher.promptTemplates("notes")).map(({ name }) => name)).toEqual(["dashboard", "project", "root-only"]);
  const linkedCatalog = await launcher.promptTemplates("personal::linked-note");
  expect(linkedCatalog.map(({ name }) => name)).toEqual(["dashboard", "project", "linked-only"]);
  expect(linkedCatalog[2]).toMatchObject({ scope: "dashboard", input: "optional", vars: { id: "Target ID" } });
  expect(launches).toHaveLength(0);
  await expect(launcher.promptTemplates("gone")).rejects.toMatchObject({ code: "COMPONENT_NOT_FOUND" });

  const preview = await launcher.preview({ nodeIds: ["status", "notes", "status"], prompt: "Align them.", template: "dashboard" });
  expect(preview.prompt).toContain(`Target components:\n- ${configPath}#root.children[1].node (id \`status\``);
  expect(preview.prompt).toContain(`- ${configPath}#root.children[0].node (id \`notes\``);
  await launcher.launch({ kind: "component", nodeIds: ["status", "notes"], prompt: "Align them.", template: "dashboard" });
  expect(launches[0]).toMatchObject({ purpose: "edit", componentPath: `${configPath}#root.children[1].node` });

  await expect(launcher.preview({ nodeIds: ["notes", "personal::linked-note"], prompt: "" }))
    .rejects.toMatchObject({ code: "COMPONENT_AGENT_TARGETS_MIXED" });
  await expect(launcher.preview({ nodeIds: ["notes", "gone"], prompt: "" }))
    .rejects.toMatchObject({ code: "COMPONENT_NOT_FOUND" });
  await expect(launcher.preview({ nodeIds: [], prompt: "" }))
    .rejects.toMatchObject({ code: "COMPONENT_NOT_FOUND" });
});

test("template discovery re-reads summaries without launch environment or an agent launch", async () => {
  const { root, runtime, launcher, launches } = await setup("PRIVATE_VALUE=secret-value\n", { value: null });
  const directory = join(root, ".dash-bored", "prompts");
  await mkdir(directory);
  await writeFile(join(directory, "custom.md"), "---\ndescription: A custom request\nscope: project\nenv: [PRIVATE_VALUE]\n---\n{{env.PRIVATE_VALUE}} {{input}}\n");
  runtime.getLaunchEnvironment = async () => { throw new Error("Catalog must not resolve environment."); };
  const catalog = await launcher.promptTemplates("test");
  expect(catalog.map(({ name }) => name)).toEqual(["dashboard", "project", "custom"]);
  expect(JSON.stringify(catalog)).not.toContain("secret-value");
  await writeFile(join(directory, "custom.md"), "---\ndescription: Updated request\nscope: dashboard\n---\n{{input}}\n");
  expect((await launcher.promptTemplates("test"))[2]).toMatchObject({ description: "Updated request", scope: "dashboard" });
  expect(launches).toHaveLength(0);
});
