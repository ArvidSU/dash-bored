import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { instanceSocketPath, listAppInstances, selectAppInstance } from "../../src/core/app-instances";
import { startAgentControlServer, type AgentControlBridge } from "../../src/main/agent-control-server";
import { agentActionRefusal, type AgentRunActionRequest, type AgentViewState } from "../../src/shared/agent-control";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

// Unix socket paths are short-limited, so avoid the long per-user TMPDIR.
async function home(): Promise<string> {
  const path = await mkdtemp("/tmp/dbac-");
  cleanup.push(() => rm(path, { recursive: true, force: true }));
  return path;
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

function fakeBridge() {
  const state: AgentViewState = {
    view: "dashboard",
    configPath: "/project/.dash-bored/dash-bored.yaml",
    dashboardName: "Project",
    focusedNodeId: null,
    editing: false,
    diagnostics: { errors: 0, warnings: 0 },
  };
  const runs: AgentRunActionRequest[] = [];
  const opened: string[] = [];
  const bridge: AgentControlBridge = {
    viewState: async () => ({ ...state }),
    listActions: async () => [
      { id: "focus:logs", label: "Focus Logs", group: "Dashboard nodes", enabled: true },
      { id: "project:trust", label: "Trust project", group: "Project", enabled: true, refusal: agentActionRefusal({ id: "project:trust" }) },
    ],
    runAction: async (request) => {
      runs.push(request);
      if (request.reference === "project:trust") return { status: "refused", id: request.reference, reason: "reserved" };
      state.focusedNodeId = decodeURIComponent(request.reference.replace(/^focus:/, ""));
      return { status: "completed", id: request.reference };
    },
    settle: async () => undefined,
    capture: async () => PNG,
    openDashboard: async (configPath) => { opened.push(configPath); },
  };
  return { bridge, state, runs, opened };
}

async function cli(homeDirectory: string, ...args: string[]) {
  const child = Bun.spawn([process.execPath, resolve(import.meta.dirname, "../../src/cli/index.ts"), "app", ...args], {
    env: { ...process.env, HOME: homeDirectory, DASH_BORED_APP_INSTANCE: "", DASH_BORED_SKILL_DIR: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function serve(homeDirectory: string, identifier = "dev.dash-bored.test") {
  const fake = fakeBridge();
  const server = await startAgentControlServer({
    identifier,
    pid: process.pid,
    version: "9.9.9",
    socketPath: instanceSocketPath(identifier, homeDirectory),
    toolPath: null,
  }, fake.bridge, { homeDirectory });
  cleanup.push(() => server.close());
  return { ...fake, server };
}

test("the socket is private and the instance record is withdrawn on close", async () => {
  const homeDirectory = await home();
  const { server } = await serve(homeDirectory);
  expect((await stat(server.record.socketPath)).mode & 0o077).toBe(0);
  expect((await listAppInstances(homeDirectory)).map((item) => item.identifier)).toEqual(["dev.dash-bored.test"]);
  await server.close();
  expect(await listAppInstances(homeDirectory)).toEqual([]);
});

test("the agent tool reads state, runs actions, and reports refusals through the channel", async () => {
  const homeDirectory = await home();
  const { runs } = await serve(homeDirectory);

  const status = await cli(homeDirectory, "status");
  expect(status.exitCode).toBe(0);
  expect(JSON.parse(status.stdout).state.dashboardName).toBe("Project");

  const actions = await cli(homeDirectory, "actions");
  expect(JSON.parse(actions.stdout).map((action: { id: string }) => action.id)).toEqual(["focus:logs"]);

  const refused = await cli(homeDirectory, "run", "project:trust");
  expect(refused.exitCode).toBe(1);
  expect(JSON.parse(refused.stdout).result.status).toBe("refused");

  const ran = await cli(homeDirectory, "run", "focus:logs", "--select", "mode=all");
  expect(ran.exitCode).toBe(0);
  expect(runs.at(-1)).toEqual({ reference: "focus:logs", selections: { mode: "all" } });
});

test("screenshot focuses the requested node and writes the captured PNG", async () => {
  const homeDirectory = await home();
  const { runs } = await serve(homeDirectory);
  const output = join(homeDirectory, "shots", "window.png");

  const result = await cli(homeDirectory, "screenshot", "--focus", "logs", "--output", output);

  expect(result.exitCode).toBe(0);
  expect(runs.map((run) => run.reference)).toEqual(["focus:logs"]);
  expect(new Uint8Array(await readFile(output))).toEqual(PNG);
  expect(JSON.parse(result.stdout)).toMatchObject({ path: output, bytes: PNG.byteLength, state: { focusedNodeId: "logs" } });
});

test("open is refused while the user edits a draft", async () => {
  const homeDirectory = await home();
  const { state, opened } = await serve(homeDirectory);
  state.editing = true;
  const project = join(homeDirectory, "project");
  await Bun.$`mkdir -p ${project}`;
  const init = Bun.spawn([process.execPath, resolve(import.meta.dirname, "../../src/cli/index.ts"), "init", "--project", project], { stdout: "ignore", stderr: "ignore" });
  expect(await init.exited).toBe(0);

  const result = await cli(homeDirectory, "open", project);

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("editing a dashboard draft");
  expect(opened).toEqual([]);
});

test("instance selection prefers explicit, then launching, then the only instance", () => {
  const record = (identifier: string) => ({ identifier, pid: 1, version: "1", socketPath: "", toolPath: null, startedAt: "" });
  const instances = [record("a"), record("b")];
  expect(selectAppInstance(instances, "b", "a").identifier).toBe("b");
  expect(selectAppInstance(instances, undefined, "a").identifier).toBe("a");
  expect(selectAppInstance([record("a")], undefined, undefined).identifier).toBe("a");
  expect(() => selectAppInstance(instances, undefined, undefined)).toThrow("Several");
  expect(() => selectAppInstance([], undefined, undefined)).toThrow("No dash-bored app is running");
});

test("trust, draft lifecycle, and confirmations are reserved for the user", () => {
  expect(agentActionRefusal({ id: "project:trust" })).toBeDefined();
  expect(agentActionRefusal({ id: "project:save-draft" })).toBeDefined();
  expect(agentActionRefusal({ id: "component:x:y", confirmation: { title: "Deploy?" } })).toBeDefined();
  expect(agentActionRefusal({ id: "focus:logs" })).toBeUndefined();
});
