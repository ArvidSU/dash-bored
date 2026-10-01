import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { instanceSocketPath, listAppInstances, selectAppInstance } from "../../src/core/app-instances";
import type { ProcessSnapshot } from "../../src/shared/contracts";
import { startAgentControlServer, type AgentControlBridge } from "../../src/main/agent-control-server";
import {
  agentActionRefusal,
  agentProcessInfo,
  agentProcessLogs,
  summarizeAgentDiagnostics,
  suggestActions,
  unknownActionReason,
  type AgentNodeMeasurement,
  type AgentRunActionRequest,
  type AgentViewState,
} from "../../src/shared/agent-control";
import { pngSize } from "../../src/main/png-crop";
import { syntheticPng } from "./synthetic-png";

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
    diagnostics: summarizeAgentDiagnostics([
      { severity: "error", code: "COMPONENT_PROP_INVALID", message: "Bad prop", path: "tree.children[0]", file: "dash-bored.yaml", line: 4 },
      { severity: "warning", code: "RUNTIME_WARN", message: "Slow" },
    ]),
    trust: { trusted: false, pendingPermissions: ["process:execute", "network:http"] },
  };
  const processes: ProcessSnapshot[] = [
    {
      id: "tests", phase: "exited", pid: null, exitCode: 1, signal: null, startedAt: "2026-01-01T00:00:00.000Z", durationMs: 2500,
      logs: [
        { sequence: 1, stream: "stdout", text: "\u001b[32mok\u001b[0m one\r\ntwo\r\n" },
        { sequence: 2, stream: "stderr", text: "\u001b[31mfail\u001b[0m three\r\n" },
      ],
    },
    { id: "serve", phase: "idle", pid: null, exitCode: null, signal: null, logs: [] },
  ];
  const labels: Record<string, string> = { tests: "Run tests", serve: "Serve" };
  const runs: AgentRunActionRequest[] = [];
  const opened: string[] = [];
  const idleCalls: number[] = [];
  const tails: number[] = [];
  const capture = { events: [] as string[], png: PNG as Uint8Array<ArrayBuffer>, failCapture: false };
  const measurement: AgentNodeMeasurement = {
    nodeId: "logs",
    rect: { x: 10, y: 5, width: 20, height: 10 },
    fullWidth: 20,
    fullHeight: 10,
    truncated: false,
    viewport: { width: 90, height: 60 },
    devicePixelRatio: 2,
    changes: { revealed: false, scrolled: false },
  };
  const bridge: AgentControlBridge = {
    viewState: async () => ({ ...state }),
    listActions: async () => [
      { id: "focus:logs", label: "Focus Logs", group: "Dashboard nodes", enabled: true },
      {
        id: "project:reveal",
        label: "Reveal component",
        group: "Dashboard presentation",
        enabled: true,
        choices: [{ id: "node", label: "Component", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] }],
      },
      { id: "project:trust", label: "Trust project", group: "Project", enabled: true, refusal: agentActionRefusal({ id: "project:trust" }) },
    ],
    runAction: async (request) => {
      runs.push(request);
      if (request.reference === "project:trust") return { status: "refused", id: request.reference, reason: "reserved" };
      if (request.reference === "focus:missing") {
        const suggestions = ["focus:logs"];
        return { status: "unavailable", reason: unknownActionReason(request.reference, suggestions), suggestions };
      }
      state.focusedNodeId = decodeURIComponent(request.reference.replace(/^focus:/, ""));
      return { status: "completed", id: request.reference };
    },
    settle: async () => undefined,
    idle: async (timeoutMs) => { idleCalls.push(timeoutMs); return true; },
    capture: async () => {
      capture.events.push("capture");
      if (capture.failCapture) throw new Error("capture failed");
      return capture.png;
    },
    beginNodeCapture: async (nodeId) => {
      capture.events.push(`begin:${nodeId}`);
      return { ...measurement, nodeId };
    },
    endNodeCapture: async () => { capture.events.push("end"); },
    openDashboard: async (configPath) => { opened.push(configPath); },
    processes: () => processes.map((item) => agentProcessInfo(item, labels[item.id]!)),
    processLogs: (id, tail) => {
      tails.push(tail);
      const found = processes.find((item) => item.id === id);
      return found ? agentProcessLogs(agentProcessInfo(found, labels[id]!), found, tail) : null;
    },
  };
  return { bridge, state, runs, opened, idleCalls, processes, tails, capture, measurement };
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

async function serve(
  homeDirectory: string,
  identifier = "dev.dash-bored.test",
  overrides: Partial<AgentControlBridge> = {},
  settleTimeoutMs?: number,
) {
  const fake = fakeBridge();
  Object.assign(fake.bridge, overrides);
  const server = await startAgentControlServer({
    identifier,
    pid: process.pid,
    version: "9.9.9",
    socketPath: instanceSocketPath(identifier, homeDirectory),
    toolPath: null,
  }, fake.bridge, { homeDirectory, ...(settleTimeoutMs === undefined ? {} : { settleTimeoutMs }) });
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
  expect(JSON.parse(actions.stdout).map((action: { id: string }) => action.id)).toEqual(["focus:logs", "project:reveal"]);
  const ids = async (...args: string[]) =>
    JSON.parse((await cli(homeDirectory, "actions", ...args)).stdout).map((action: { id: string }) => action.id);
  expect(await ids("LOGS")).toEqual(["focus:logs"]);
  expect(await ids("trust")).toEqual([]);
  expect(await ids("trust", "--all")).toEqual(["project:trust"]);

  const refused = await cli(homeDirectory, "run", "project:trust");
  expect(refused.exitCode).toBe(1);
  expect(JSON.parse(refused.stdout).result.status).toBe("refused");

  const ran = await cli(homeDirectory, "run", "focus:logs", "--select", "mode=all");
  expect(ran.exitCode).toBe(0);
  expect(runs.at(-1)).toEqual({ reference: "focus:logs", selections: { mode: "all" } });
});

test("status reports diagnostic text, bounded, and the read-only trust state", async () => {
  const homeDirectory = await home();
  const { state } = await serve(homeDirectory);

  const status = JSON.parse((await cli(homeDirectory, "status")).stdout).state;
  expect(status.diagnostics).toMatchObject({ errors: 1, warnings: 1, total: 2 });
  expect(status.diagnostics.items[0]).toEqual({
    code: "COMPONENT_PROP_INVALID", severity: "error", message: "Bad prop", file: "dash-bored.yaml", path: "tree.children[0]", line: 4,
  });
  expect(status.trust).toEqual({ trusted: false, pendingPermissions: ["process:execute", "network:http"] });

  state.diagnostics = summarizeAgentDiagnostics(Array.from({ length: 120 }, (_, index) => ({
    severity: "warning" as const, code: "W", message: `warning ${index}`.padEnd(900, "x"),
  })));
  const bounded = JSON.parse((await cli(homeDirectory, "status")).stdout).state.diagnostics;
  expect(bounded.total).toBe(120);
  expect(bounded.items).toHaveLength(50);
  expect(bounded.items[0].message).toHaveLength(500);
});

test("processes lists each command process with state, exit, and times", async () => {
  const homeDirectory = await home();
  await serve(homeDirectory);

  const result = await cli(homeDirectory, "processes");

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual([
    {
      id: "tests", label: "Run tests", state: "exited", phase: "exited", exitCode: 1, signal: null,
      startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T00:00:02.500Z",
    },
    { id: "serve", label: "Serve", state: "idle", phase: "idle", exitCode: null, signal: null },
  ]);
});

test("logs returns stripped, tail-bounded output and reports unknown commands", async () => {
  const homeDirectory = await home();
  const { processes, tails } = await serve(homeDirectory);

  const full = JSON.parse((await cli(homeDirectory, "logs", "tests")).stdout);
  expect(full).toMatchObject({ id: "tests", state: "exited", totalLines: 3, truncated: false, lines: ["ok one", "two", "fail three"] });
  expect(tails.at(-1)).toBe(200);

  const tail = JSON.parse((await cli(homeDirectory, "logs", "tests", "--tail", "2")).stdout);
  expect(tail).toMatchObject({ lines: ["two", "fail three"], truncated: true });

  const capped = await cli(homeDirectory, "logs", "tests", "--tail", "999999");
  expect(capped.exitCode).toBe(0);
  expect(tails.at(-1)).toBe(1000);

  processes[0]!.logs = [{ sequence: 1, stream: "stdout", text: `${"x".repeat(3000)}\r\nprogress 10%\rprogress 100%\r\n` }];
  const long = JSON.parse((await cli(homeDirectory, "logs", "tests")).stdout);
  expect(long.lines[0]).toHaveLength(2003);
  expect(long.lines[1]).toBe("progress 100%");

  processes[0]!.logs = [{ sequence: 1, stream: "stdout", text: "\u001b(Bdone\u001b=\u001b>\r\n" }];
  expect(JSON.parse((await cli(homeDirectory, "logs", "tests")).stdout).lines).toEqual(["done"]);

  const empty = JSON.parse((await cli(homeDirectory, "logs", "serve")).stdout);
  expect(empty).toMatchObject({ totalLines: 0, lines: [], truncated: false });

  const missing = await cli(homeDirectory, "logs", "nope");
  expect(missing.exitCode).toBe(1);
  expect(missing.stderr).toContain("No command process has the id nope");

  const invalid = await cli(homeDirectory, "logs", "tests", "--tail", "0");
  expect(invalid.exitCode).toBe(1);
  expect(invalid.stderr).toContain("--tail");
});

test("actions list choice counts by default and options only on request", async () => {
  const homeDirectory = await home();
  await serve(homeDirectory);

  const summary = JSON.parse((await cli(homeDirectory, "actions", "reveal")).stdout);
  expect(summary).toHaveLength(1);
  expect(summary[0].choices).toEqual([{ id: "node", label: "Component", optionCount: 2 }]);

  const full = JSON.parse((await cli(homeDirectory, "actions", "reveal", "--choices")).stdout);
  expect(full[0].choices[0].options).toHaveLength(2);
});

test("screenshot --node crops the window capture to the node and reports view changes", async () => {
  const homeDirectory = await home();
  const { capture, measurement } = await serve(homeDirectory);
  // 90x60 CSS px at 2x plus a 40px title bar and 10px side margins.
  capture.png = syntheticPng(200, 160) as Uint8Array<ArrayBuffer>;
  measurement.changes = { revealed: true, scrolled: false };
  const output = join(homeDirectory, "shots", "node.png");

  const result = await cli(homeDirectory, "screenshot", "--node", "logs", "--output", output);

  expect(result.exitCode).toBe(0);
  expect(capture.events).toEqual(["begin:logs", "capture", "end"]);
  expect(pngSize(new Uint8Array(await readFile(output)))).toEqual({ width: 40, height: 20 });
  expect(JSON.parse(result.stdout).node).toMatchObject({
    nodeId: "logs",
    truncated: false,
    changes: { revealed: true, scrolled: false },
  });
});

test("a failed node capture still ends the capture session", async () => {
  const homeDirectory = await home();
  const { capture } = await serve(homeDirectory);
  capture.failCapture = true;

  const result = await cli(homeDirectory, "screenshot", "--node", "logs");

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("capture failed");
  expect(capture.events).toEqual(["begin:logs", "capture", "end"]);
});

test("screenshot --focus restores the previous focus unless asked to keep it", async () => {
  const homeDirectory = await home();
  const { runs, state } = await serve(homeDirectory);
  state.focusedNodeId = "overview";
  const output = join(homeDirectory, "shots", "focus.png");

  const restored = await cli(homeDirectory, "screenshot", "--focus", "logs", "--output", output);
  expect(runs.map((run) => run.reference)).toEqual(["focus:logs", "focus:overview"]);
  expect(JSON.parse(restored.stdout)).toMatchObject({ previousFocusedNodeId: "overview", focusRestored: true, state: { focusedNodeId: "overview" } });

  runs.length = 0;
  state.focusedNodeId = "overview";
  const kept = await cli(homeDirectory, "screenshot", "--focus", "logs", "--keep-focus", "--output", output);
  expect(runs.map((run) => run.reference)).toEqual(["focus:logs"]);
  expect(JSON.parse(kept.stdout)).toMatchObject({ previousFocusedNodeId: "overview", focusRestored: false, state: { focusedNodeId: "logs" } });
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

test("a window that never paints fails screenshots and warns on runs instead of hanging", async () => {
  const homeDirectory = await home();
  await serve(homeDirectory, undefined, { settle: () => new Promise<void>(() => undefined) }, 50);

  const shot = await cli(homeDirectory, "screenshot", "--output", join(homeDirectory, "never.png"));
  expect(shot.exitCode).toBe(1);
  expect(shot.stderr).toContain("not rendering");

  const run = await cli(homeDirectory, "run", "focus:logs");
  expect(run.exitCode).toBe(0);
  expect(JSON.parse(run.stdout)).toMatchObject({ result: { status: "completed" }, warning: expect.stringContaining("minimized") });
});

test("large action lists reach a slow pipe reader intact", async () => {
  const homeDirectory = await home();
  const actions = Array.from({ length: 2_000 }, (_, index) => ({
    id: `focus:node-${index}`, label: `Focus node ${index}`, group: "Dashboard nodes", enabled: true,
  }));
  await serve(homeDirectory, undefined, { listActions: async () => actions });

  // Bun 1.3 console.log lost output past the 64 KiB pipe buffer when the
  // reader was slow, as with an agent shell piping into another tool.
  const cliPath = resolve(import.meta.dirname, "../../src/cli/index.ts");
  const child = Bun.spawn(["/bin/sh", "-c", '"$0" "$1" app actions | (sleep 0.5; cat)', process.execPath, cliPath], {
    env: { ...process.env, HOME: homeDirectory, DASH_BORED_APP_INSTANCE: "", DASH_BORED_SKILL_DIR: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  expect(stdout.length).toBeGreaterThan(64 * 1024);
  expect(JSON.parse(stdout)).toHaveLength(2_000);
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
  expect(agentActionRefusal({ id: "agent:prompt" })).toContain("user review");
});

test("run waits for the renderer to go idle, and --no-wait skips it", async () => {
  const homeDirectory = await home();
  let finished = false;
  const { idleCalls } = await serve(homeDirectory, undefined, {
    idle: async () => { await Bun.sleep(150); finished = true; return true; },
  });

  const waited = await cli(homeDirectory, "run", "focus:logs");
  expect(finished).toBe(true);
  expect(JSON.parse(waited.stdout)).toMatchObject({ result: { status: "completed" }, idle: true });
  expect(JSON.parse(waited.stdout).warning).toBeUndefined();

  finished = false;
  const skipped = await cli(homeDirectory, "run", "focus:logs", "--no-wait");
  expect(finished).toBe(false);
  expect(JSON.parse(skipped.stdout).idle).toBeUndefined();
  expect(idleCalls).toEqual([]);
});

test("the idle wait defaults to ten seconds and a timeout returns idle false with a warning", async () => {
  const homeDirectory = await home();
  const calls: number[] = [];
  await serve(homeDirectory, undefined, { idle: async (timeoutMs) => { calls.push(timeoutMs); return calls.length > 1; } });

  const timedOut = await cli(homeDirectory, "run", "focus:logs");
  expect(timedOut.exitCode).toBe(0);
  expect(JSON.parse(timedOut.stdout)).toMatchObject({ idle: false, warning: expect.stringContaining("still loading") });

  await cli(homeDirectory, "run", "focus:logs", "--timeout", "250");
  expect(calls).toEqual([10_000, 250]);
});

test("a hung renderer idle request is cut off after the timeout plus the paint backstop", async () => {
  const homeDirectory = await home();
  await serve(homeDirectory, undefined, { idle: () => new Promise<boolean>(() => undefined) }, 50);
  const run = await cli(homeDirectory, "run", "focus:logs", "--timeout", "20");
  expect(JSON.parse(run.stdout)).toMatchObject({ result: { status: "completed" }, idle: false });
});

test("screenshots wait for idle but still capture, noting a timeout", async () => {
  const homeDirectory = await home();
  const { idleCalls } = await serve(homeDirectory);
  const output = join(homeDirectory, "idle.png");
  const shot = await cli(homeDirectory, "screenshot", "--output", output, "--timeout", "500");
  expect(shot.exitCode).toBe(0);
  expect(idleCalls).toEqual([500]);
  expect(JSON.parse(shot.stdout).idle).toBeUndefined();

  const stuck = await serve(await home(), "dev.dash-bored.other", { idle: async () => false });
  const response = await fetch("http://dash-bored/v1/screenshot", { method: "POST", unix: stuck.server.record.socketPath, body: "{}" } as RequestInit);
  expect(response.status).toBe(200);
  expect(response.headers.get("x-dash-bored-idle")).toBe("false");
});

test("unknown focus targets name the missing node and suggest close matches", async () => {
  const homeDirectory = await home();
  await serve(homeDirectory);
  const result = await cli(homeDirectory, "screenshot", "--focus", "missing", "--output", join(homeDirectory, "x.png"));
  expect(result.exitCode).toBe(1);
  const { result: outcome } = JSON.parse(result.stdout);
  expect(outcome.reason).toContain("Node missing is not in the active dashboard");
  expect(outcome.reason).toContain("focus:logs");
  expect(outcome.reason).toContain("app actions focus");
});

test("action suggestions rank substring and near matches and unknown ids point to app actions", () => {
  const known = [
    { id: "focus:logs", reference: "focus:logs" },
    { id: "focus:build", reference: "focus:build" },
    { id: "component:workspace-status:refresh", reference: "component:workspace-status:refresh" },
    { id: "theme:dark" },
    ...Array.from({ length: 8 }, (_, index) => ({ id: `focus:no-such-node-${index}` })),
  ];
  expect(suggestActions("focus:log", known)).toEqual(["focus:logs"]);
  expect(suggestActions("focus:bulid", known)).toContain("focus:build");
  expect(suggestActions("workspace-status", known)).toEqual(["component:workspace-status:refresh"]);
  expect(suggestActions("focus:no-such", known)).toHaveLength(5);
  expect(suggestActions("zzzzzzzz", known)).toEqual([]);
  const reason = unknownActionReason("focus:no-such-node", ["focus:logs"]);
  expect(reason).toContain("No action matches focus:no-such-node.");
  expect(reason).toContain("Close matches: focus:logs.");
  expect(reason).toContain("dash-bored app actions <filter>");
  expect(unknownActionReason("x", [])).not.toContain("Close matches");
});

test("user-only ids are refused by id alone, even when the action is not registered", () => {
  expect(agentActionRefusal({ id: "project:trust" })).toContain("reserved for the user");
  expect(agentActionRefusal({ id: "app:add-dashboard" })).toContain("reserved for the user");
});
