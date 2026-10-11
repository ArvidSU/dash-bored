import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, readFile, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { agentSpawnCommand } from "../../src/main/acp-connection";
import { AgentSessions, pathWithin, resolveRealPath, type AgentSessionLaunchOptions, type AgentSessionsOptions } from "../../src/main/agent-sessions";
import { shellWord } from "../../src/main/agent-handoff";
import type { AgentSessionTask } from "../../src/shared/agent-session";
import { removeTemporaryDirectory, temporaryDirectory } from "../core/helpers";

const FAKE_AGENT = join(import.meta.dir, "..", "fixtures", "acp", "fake-agent.ts");
const fakeCommand = (...flags: string[]) => [shellWord(process.execPath), shellWord(FAKE_AGENT), ...flags].join(" ");

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

function sessions(options: AgentSessionsOptions = {}): AgentSessions {
  const manager = new AgentSessions({ emitDelayMs: 5, shutdownGraceMs: 300, ...options });
  cleanup.push(() => manager.shutdown());
  return manager;
}

async function project(name = "project"): Promise<string> {
  const base = await temporaryDirectory();
  cleanup.push(() => removeTemporaryDirectory(base));
  const root = join(base, name);
  await mkdir(join(root, ".dash-bored"), { recursive: true });
  return root;
}

function options(root: string, overrides: Partial<AgentSessionLaunchOptions> = {}): AgentSessionLaunchOptions {
  return {
    command: fakeCommand(),
    prompt: "Update the README.",
    projectRoot: root,
    bundleDirectory: join(root, ".dash-bored"),
    componentPath: `${root}/.dash-bored/dash-bored.yaml#root`,
    configPath: join(root, ".dash-bored", "dash-bored.yaml"),
    request: "Update the README.",
    env: process.env as Record<string, string>,
    ...overrides,
  };
}

async function until(manager: AgentSessions, id: string, predicate: (task: AgentSessionTask) => boolean, timeoutMs = 10_000): Promise<AgentSessionTask> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const task = manager.get(id);
    if (predicate(task)) return task;
    if (Date.now() > deadline) throw new Error(`Timed out; last task: ${JSON.stringify(task, null, 2).slice(0, 4_000)}`);
    await Bun.sleep(10);
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A directory with executables named like known agents that run the fake agent. */
async function agentBin(root: string, names: string[]): Promise<string> {
  const bin = join(root, "..", "bin");
  await mkdir(bin, { recursive: true });
  for (const name of names) {
    await writeFile(join(bin, name), `#!/bin/sh\nexec ${fakeCommand()} "$@"\n`);
    await chmod(join(bin, name), 0o755);
  }
  return bin;
}

describe("AgentSessions", () => {
  test("launches an ACP agent and reduces its session into the task", async () => {
    const root = await project();
    const emitted: AgentSessionTask[] = [];
    const manager = sessions({ onTask: (task) => emitted.push(task) });
    const launch = await manager.launch(options(root, { purpose: "edit", template: "dashboard" }));
    expect(launch).toMatchObject({ command: fakeCommand(), componentPath: `${root}/.dash-bored/dash-bored.yaml#root` });
    expect(launch.pid).toBeNumber();

    const waiting = await until(manager, launch.taskId, (task) => task.state === "waiting");
    expect(waiting).toMatchObject({
      purpose: "edit",
      template: "dashboard",
      sessionId: "fake-session-1",
      turns: 0,
      plan: [
        { content: "Edit README.md", priority: "high", status: "in_progress" },
        { content: "Report back", priority: "low", status: "pending" },
      ],
      configOptions: [
        { id: "model", category: "model", type: "select", currentValue: "fake-fast" },
        { id: "mode", category: "mode", type: "select", currentValue: "ask" },
      ],
      permission: { toolCallId: "call-1", title: "Edit README.md", toolKind: "edit", locations: [{ path: `${root}/README.md`, line: 1 }] },
      handoff: null,
    });
    expect(waiting.agent.name).toBe(process.execPath.split("/").at(-1)!);
    expect(waiting.permission?.options.map((option) => option.kind)).toEqual(["allow_once", "reject_once"]);
    expect(waiting.entries.map((entry) => entry.kind)).toEqual(["user", "agent", "tool"]);
    expect(waiting.entries[2]).toMatchObject({ kind: "tool", status: "pending", edits: [{ path: `${root}/README.md`, added: 1, removed: 1 }] });
    // Diff text never reaches the task.
    expect(JSON.stringify(waiting)).not.toContain("hello, world");

    manager.answerPermission(launch.taskId, waiting.permission!.id, "allow");
    const idle = await until(manager, launch.taskId, (task) => task.state === "idle");
    expect(idle).toMatchObject({ turns: 1, stopReason: "end_turn", permission: null });
    expect(idle.entries.map((entry) => entry.kind === "agent" || entry.kind === "user" ? entry.text : `${entry.kind}:${"status" in entry ? entry.status : ""}`))
      .toEqual(["Update the README.", "Working on it.", "tool:completed", "Done."]);
    expect(idle.plan?.every((entry) => entry.status === "completed")).toBeTrue();
    expect(idle.log).toContain("fake-acp-agent: ready");

    await Bun.sleep(30);
    expect(emitted.at(-1)).toMatchObject({ id: launch.taskId, state: "idle", turns: 1 });
    // Updates are coalesced rather than published one by one.
    expect(emitted.length).toBeLessThan(20);
  });

  test("queues permission requests and answers the rest cancelled when the turn is cancelled", async () => {
    const root = await project();
    const manager = sessions();
    const { taskId } = await manager.launch(options(root, { prompt: "queue" }));
    let task = await until(manager, taskId, (candidate) => candidate.state === "waiting" && candidate.permission?.toolCallId === "call-1");
    const first = task.permission!;
    expect(() => manager.answerPermission(taskId, first.id, "not-an-option")).toThrow("not one of the request's options");
    manager.answerPermission(taskId, first.id, "allow");
    task = await until(manager, taskId, (candidate) => candidate.permission?.toolCallId === "call-2");
    expect(task.state).toBe("waiting");
    // A stale click cannot answer the newer request.
    expect(() => manager.answerPermission(taskId, first.id, "allow")).toThrow("already answered");

    await manager.cancel(taskId);
    task = await until(manager, taskId, (candidate) => candidate.state === "idle");
    expect(task).toMatchObject({ permission: null, stopReason: "cancelled", turns: 1 });
    expect(task.log).toContain("fake-acp-agent: answers allow,cancelled");
  });

  test("pushes a task's change before a launch or task command resolves", async () => {
    const root = await project();
    const events: string[] = [];
    // A long coalescing delay: without the flush, every push would follow the answer.
    const manager = sessions({ emitDelayMs: 500, onTask: (task) => events.push(`push ${task.state} ${task.permission?.toolCallId ?? "-"}`) });
    const { taskId } = await manager.launch(options(root, { prompt: "queue" }));
    events.push("launched");
    expect(events).toEqual(["push starting -", "launched"]);

    const waiting = await until(manager, taskId, (task) => task.permission?.toolCallId === "call-1"
      && task.entries.some((entry) => entry.kind === "tool" && entry.id === "call-2"));
    events.length = 0;
    const answered = await manager.command(taskId, { type: "permission", requestId: waiting.permission!.id, optionId: "allow" });
    events.push("resolved");
    // The queued second request reaches the renderer before the first answer resolves.
    expect(events).toEqual(["push waiting call-2", "resolved"]);
    expect(answered.permission?.toolCallId).toBe("call-2");
    await expect(manager.command(taskId, { type: "permission", requestId: waiting.permission!.id, optionId: "allow" })).rejects.toThrow("already answered");
    await manager.cancel(taskId);
  });

  test("accepts follow-up prompts only while idle", async () => {
    const root = await project();
    const manager = sessions();
    const { taskId } = await manager.launch(options(root, { prompt: "hang" }));
    await until(manager, taskId, (task) => task.state === "working" && task.entries.some((entry) => entry.kind === "agent"));
    expect(() => manager.prompt(taskId, "quick")).toThrow("still working");
    await manager.cancel(taskId);
    await until(manager, taskId, (task) => task.state === "idle");
    expect(() => manager.prompt(taskId, "   ")).toThrow("between 1 and");

    manager.prompt(taskId, "quick follow-up");
    const task = await until(manager, taskId, (candidate) => candidate.state === "idle" && candidate.turns === 2);
    expect(task.stopReason).toBe("end_turn");
    expect(task.entries.filter((entry) => entry.kind === "user").map((entry) => entry.kind === "user" && entry.text)).toEqual(["hang", "quick follow-up"]);
    expect(task.sessionId).toBe("fake-session-1");
  });

  test("changes config options, and falls back to legacy modes as a mode select", async () => {
    const root = await project();
    const manager = sessions();
    const { taskId } = await manager.launch(options(root, { prompt: "quick" }));
    await until(manager, taskId, (task) => task.state === "idle");
    const changed = await manager.setConfig(taskId, "model", "fake-smart");
    expect(changed.configOptions.find((option) => option.id === "model")?.currentValue).toBe("fake-smart");
    await expect(manager.setConfig(taskId, "model", "fake-huge")).rejects.toThrow("not one of the choices");
    await expect(manager.setConfig(taskId, "temperature", "hot")).rejects.toThrow("does not offer");

    const modes = await manager.launch(options(root, { command: fakeCommand("--modes"), prompt: "quick" }));
    const idle = await until(manager, modes.taskId, (task) => task.state === "idle");
    expect(idle.configOptions).toEqual([{
      id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "ask",
      options: [{ value: "ask", name: "Ask" }, { value: "code", name: "Code", description: "Edits files" }],
    }]);
    const switched = await manager.setConfig(modes.taskId, "mode", "code");
    expect(switched.configOptions[0]?.currentValue).toBe("code");
    expect((await until(manager, modes.taskId, (task) => task.log.includes("fake-acp-agent: mode code"))).state).toBe("idle");
  });

  test("ignores update kinds it does not know", async () => {
    const root = await project();
    const manager = sessions();
    const { taskId } = await manager.launch(options(root, { prompt: "future" }));
    const task = await until(manager, taskId, (candidate) => candidate.state !== "starting" && candidate.state !== "working");
    expect(task).toMatchObject({ state: "idle", turns: 1, stopReason: "end_turn" });
  });

  test("reports a command that is not an ACP agent, with a hint for a known agent's own CLI", async () => {
    const root = await project();
    const manager = sessions();
    const cat = await manager.launch(options(root, { command: "cat" }));
    const failed = await until(manager, cat.taskId, (task) => task.state === "failed");
    expect(failed.error).toContain("This command did not answer as an ACP agent.");

    const bin = join(root, "..", "cli-bin");
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "codex"), "#!/bin/sh\necho 'not json'\n");
    await chmod(join(bin, "codex"), 0o755);
    const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` } as Record<string, string>;
    const codex = await manager.launch(options(root, { command: "codex exec", env }));
    const hinted = await until(manager, codex.taskId, (task) => task.state === "failed");
    expect(hinted.error).toContain("did not answer as an ACP agent");
    expect(hinted.error).toContain("codex-acp");
    expect(hinted.agent.name).toBe("codex");
  });

  test("reports a missing executable and an unusable working directory", async () => {
    const root = await project();
    const manager = sessions();
    const missing = await manager.launch(options(root, { command: "dash-bored-missing-agent-xyz --acp" }));
    const failed = await until(manager, missing.taskId, (task) => task.state === "failed");
    expect(failed.error).toContain("exited with code 127");
    expect(failed.log.join("\n")).toContain("dash-bored-missing-agent-xyz");

    await expect(manager.launch(options(root, { projectRoot: join(root, "missing") }))).rejects.toThrow("could not be started");
    expect(manager.list()).toHaveLength(1);
  });

  test("times out the handshake and stops the process", async () => {
    const root = await project();
    const manager = sessions({ timeouts: { initialize: 200 } });
    const { taskId, pid } = await manager.launch(options(root, { command: "sleep 30" }));
    const failed = await until(manager, taskId, (task) => task.state === "failed");
    expect(failed.error).toContain("did not answer the ACP handshake within 200 ms");
    const deadline = Date.now() + 3_000;
    while (alive(pid!) && Date.now() < deadline) await Bun.sleep(20);
    expect(alive(pid!)).toBeFalse();
  });

  test("a crash during a turn fails the session and ends its turn once", async () => {
    const root = await project();
    const manager = sessions();
    const ended: AgentSessionTask[] = [];
    const { taskId } = await manager.launch(options(root, { prompt: "crash", onTurnEnd: (task) => { ended.push(task); } }));
    const failed = await until(manager, taskId, (task) => task.state === "failed");
    expect(failed.error).toContain("exited with code 3");
    await Bun.sleep(50);
    expect(ended.map((task) => task.state)).toEqual(["failed"]);
  });

  test("close sends session/close, stops the process group, and ends the turn as cancelled", async () => {
    const root = await project();
    const manager = sessions();
    const ended: AgentSessionTask[] = [];
    const { taskId, pid } = await manager.launch(options(root, { prompt: "hang", onTurnEnd: (task) => { ended.push(task); } }));
    await until(manager, taskId, (task) => task.state === "working" && task.entries.some((entry) => entry.kind === "agent"));
    const closed = await manager.close(taskId);
    expect(closed).toMatchObject({ state: "closed", cancelled: true });
    expect(closed.log).toContain("fake-acp-agent: closed fake-session-1");
    expect(alive(pid!)).toBeFalse();
    await Bun.sleep(30);
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({ state: "closed", cancelled: true });
    expect(() => manager.prompt(taskId, "again")).toThrow("has ended");
  });

  test("an agent that ignores stdin EOF is stopped with signals", async () => {
    const root = await project();
    const manager = sessions({ shutdownGraceMs: 200 });
    const { taskId, pid } = await manager.launch(options(root, { command: fakeCommand("--ignore-eof"), prompt: "quick" }));
    await until(manager, taskId, (task) => task.state === "idle");
    const started = Date.now();
    await manager.close(taskId);
    expect(alive(pid!)).toBeFalse();
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
  });

  test("keeps at most the task limit: ended tasks go first, quiet sessions are closed, active work stays", async () => {
    const root = await project();
    const emitted: AgentSessionTask[] = [];
    const manager = sessions({ maxTasks: 2, onTask: (task) => emitted.push(task) });
    const ids = () => manager.list().map((task) => task.id).sort();
    const lastEmitted = (id: string) => emitted.filter((task) => task.id === id).at(-1);
    const quiet = await manager.launch(options(root, { prompt: "quick" }));
    await until(manager, quiet.taskId, (task) => task.state === "idle");
    const failed = await manager.launch(options(root, { command: "cat" }));
    await until(manager, failed.taskId, (task) => task.state === "failed");
    // The ended task goes before the quiet session, and publishes its final state.
    const working = await manager.launch(options(root, { prompt: "hang" }));
    expect(ids()).toEqual([quiet.taskId, working.taskId].sort());
    expect(lastEmitted(failed.taskId)?.state).toBe("failed");
    await until(manager, working.taskId, (task) => task.state === "working");

    // A quiet session is closed first; its closed snapshot is published before it goes.
    const third = await manager.launch(options(root, { prompt: "quick" }));
    expect(manager.list()).toHaveLength(3);
    let deadline = Date.now() + 5_000;
    while (manager.list().length > 2 && Date.now() < deadline) await Bun.sleep(10);
    expect(ids()).toEqual([third.taskId, working.taskId].sort());
    expect(lastEmitted(quiet.taskId)).toMatchObject({ state: "closed", cancelled: true });
    expect(alive(quiet.pid!)).toBeFalse();

    await until(manager, third.taskId, (task) => task.state === "idle");
    const fourth = await manager.launch(options(root, { prompt: "quick" }));
    deadline = Date.now() + 5_000;
    while (manager.list().length > 2 && Date.now() < deadline) await Bun.sleep(10);
    expect(ids()).toEqual([fourth.taskId, working.taskId].sort());
    expect(lastEmitted(third.taskId)?.state).toBe("closed");
  });

  test("an untrusted repair refuses tools outside the bundle and execute requests", async () => {
    const root = await project();
    const manager = sessions();
    const outside = await manager.launch(options(root, { untrusted: true }));
    const refused = await until(manager, outside.taskId, (task) => task.state === "idle");
    expect(refused.untrusted).toBeTrue();
    expect(refused.entries.find((entry) => entry.kind === "notice")).toMatchObject({ level: "warning" });
    expect(JSON.stringify(refused.entries)).toContain("outside the dashboard bundle");
    expect(refused.entries.at(-1)).toMatchObject({ kind: "agent", text: "Edit rejected." });

    manager.prompt(outside.taskId, "execute");
    const executed = await until(manager, outside.taskId, (task) => task.state === "idle" && task.turns === 2);
    expect(executed.log).toContain("fake-acp-agent: execute reject");
    expect(JSON.stringify(executed.entries)).toContain("execute tools are not allowed");

    // Inside the bundle the user still decides.
    manager.prompt(outside.taskId, "bundle-edit");
    const asked = await until(manager, outside.taskId, (task) => task.state === "waiting");
    expect(asked.permission?.locations[0]?.path).toBe(`${root}/.dash-bored/dash-bored.yaml`);
    manager.answerPermission(outside.taskId, asked.permission!.id, "allow");
    expect((await until(manager, outside.taskId, (task) => task.state === "idle" && task.turns === 3)).entries.at(-1))
      .toMatchObject({ kind: "agent", text: "Done." });
  });

  test("an untrusted repair never offers always-allow, refuses mode switches, and keeps its mode", async () => {
    const root = await project();
    const manager = sessions();
    const { taskId } = await manager.launch(options(root, { untrusted: true, prompt: "always" }));
    const asked = await until(manager, taskId, (task) => task.state === "waiting");
    expect(asked.permission?.options.map((option) => option.kind)).toEqual(["allow_once", "reject_once"]);
    expect(() => manager.answerPermission(taskId, asked.permission!.id, "always")).toThrow("cannot always allow");
    manager.answerPermission(taskId, asked.permission!.id, "allow");
    expect((await until(manager, taskId, (task) => task.state === "idle")).log).toContain("fake-acp-agent: always allow");

    manager.prompt(taskId, "switch-mode");
    const refused = await until(manager, taskId, (task) => task.state === "idle" && task.turns === 2);
    expect(refused.log).toContain("fake-acp-agent: switch-mode reject");
    expect(refused.entries.at(-1)).toMatchObject({ kind: "notice", level: "warning" });
    expect(JSON.stringify(refused.entries.at(-1))).toContain("mode switches are not allowed");

    await expect(manager.setConfig(taskId, "mode", "code")).rejects.toThrow("cannot change the agent's mode");
    expect((await manager.setConfig(taskId, "model", "fake-smart")).configOptions.find((option) => option.id === "model")?.currentValue).toBe("fake-smart");

    // A trusted session offers every option the agent sent.
    const trusted = await manager.launch(options(root, { prompt: "always" }));
    const offered = await until(manager, trusted.taskId, (task) => task.state === "waiting");
    expect(offered.permission?.options.map((option) => option.kind)).toEqual(["allow_once", "allow_always", "reject_once"]);
    manager.answerPermission(trusted.taskId, offered.permission!.id, "always");
    expect((await until(manager, trusted.taskId, (task) => task.state === "idle")).log).toContain("fake-acp-agent: always always");
  });

  test("an untrusted repair resolves symlinks before checking bundle containment", async () => {
    const root = await project();
    const outside = join(root, "..", "outside");
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(root, ".dash-bored", "linked"));
    const manager = sessions();
    const { taskId } = await manager.launch(options(root, { untrusted: true, prompt: "linked-edit" }));
    const refused = await until(manager, taskId, (task) => task.state === "idle");
    expect(refused.log).toContain("fake-acp-agent: linked-edit reject");
    expect(JSON.stringify(refused.entries)).toContain("outside the dashboard bundle");
  });

  test("bundle containment follows symlinks, .. segments, and relative paths", async () => {
    const root = await realpath(await project());
    const bundle = join(root, ".dash-bored");
    const outside = join(root, "..", "elsewhere");
    await mkdir(join(outside, "deep"), { recursive: true });
    await symlink(outside, join(bundle, "escape"));
    await symlink(join(bundle, "components"), join(root, "into-bundle"));
    await mkdir(join(bundle, "components"), { recursive: true });

    expect(await pathWithin(bundle, join(bundle, "dash-bored.yaml"), root)).toBeTrue();
    expect(await pathWithin(bundle, join(bundle, "new", "deeper", "file.ts"), root)).toBeTrue();
    expect(await pathWithin(bundle, bundle, root)).toBeTrue();
    // A symlink inside the bundle that points outside, existing or not below it.
    expect(await pathWithin(bundle, join(bundle, "escape", "deep"), root)).toBeFalse();
    expect(await pathWithin(bundle, join(bundle, "escape", "missing", "file"), root)).toBeFalse();
    // `..` is resolved through the link as the OS would, not lexically.
    expect(await pathWithin(bundle, `${bundle}/escape/../dash-bored.yaml`, root)).toBeFalse();
    expect(await pathWithin(bundle, `${bundle}/../README.md`, root)).toBeFalse();
    expect(await pathWithin(bundle, `${bundle}/missing/../../README.md`, root)).toBeFalse();
    expect(await pathWithin(bundle, `${bundle}/missing/../escape/file`, root)).toBeFalse();
    expect(await pathWithin(bundle, `${bundle}/missing/../components/new.ts`, root)).toBeTrue();
    // Relative paths are resolved against the project root.
    expect(await pathWithin(bundle, ".dash-bored/dash-bored.yaml", root)).toBeTrue();
    expect(await pathWithin(bundle, "README.md", root)).toBeFalse();
    expect(await pathWithin(bundle, ".dash-bored/../../etc/passwd", root)).toBeFalse();
    // A link from outside into the bundle resolves inside it.
    expect(await pathWithin(bundle, join(root, "into-bundle", "new.ts"), root)).toBeTrue();
    expect(await resolveRealPath(join(bundle, "escape", "a", "b"))).toBe(join(await realpath(outside), "a", "b"));
  });

  test("runs plain agent commands with exec and shell expressions as written", async () => {
    expect(agentSpawnCommand("codex-acp --flag", "darwin")).toEqual(["/bin/sh", "-c", "exec codex-acp --flag"]);
    expect(agentSpawnCommand("'/opt/my agent/bin' --acp", "darwin")).toEqual(["/bin/sh", "-c", "exec '/opt/my agent/bin' --acp"]);
    for (const command of ["FOO=1 agent", "cd x && agent", "source ~/.nvm/nvm.sh && agent", ". ./env.sh; agent", "agent | tee log", "if true; then agent; fi", "$AGENT --acp"]) {
      expect(agentSpawnCommand(command, "darwin")).toEqual(["/bin/sh", "-c", command]);
    }
    expect(agentSpawnCommand("FOO=1 agent", "win32")).toEqual(["cmd.exe", "/d", "/s", "/c", "FOO=1 agent"]);

    const root = await project();
    const script = join(root, "..", "env.sh");
    await writeFile(script, "FAKE_SOURCED=1\n");
    const manager = sessions();
    for (const command of [`FOO=1 ${fakeCommand()}`, `cd ${shellWord(root)} && ${fakeCommand()}`, `. ${shellWord(script)} && ${fakeCommand()}`]) {
      const { taskId } = await manager.launch(options(root, { command, prompt: "quick" }));
      const task = await until(manager, taskId, (candidate) => candidate.state !== "starting" && candidate.state !== "working");
      expect({ command, state: task.state, error: task.error }).toEqual({ command, state: "idle", error: undefined });
    }
  });

  test("answers permission requests that arrive after a cancel as cancelled, without showing them", async () => {
    const root = await project();
    const emitted: AgentSessionTask[] = [];
    const manager = sessions({ onTask: (task) => emitted.push(task) });
    const { taskId } = await manager.launch(options(root, { prompt: "late-permission" }));
    await until(manager, taskId, (task) => task.state === "working" && task.entries.some((entry) => entry.kind === "agent"));
    await manager.cancel(taskId);
    const idle = await until(manager, taskId, (task) => task.state === "idle");
    expect(idle).toMatchObject({ stopReason: "cancelled", permission: null });
    expect(idle.log).toContain("fake-acp-agent: late-permission cancelled");
    await Bun.sleep(20);
    expect(emitted.some((task) => task.permission !== null || task.state === "waiting")).toBeFalse();
  });

  test("an agent-handled sign-in creates the session and sends the first prompt", async () => {
    const root = await project();
    const manager = sessions();
    const { taskId } = await manager.launch(options(root, { command: fakeCommand("--auth"), prompt: "quick" }));
    const signIn = await until(manager, taskId, (task) => task.state === "auth-required");
    expect(signIn.auth).toEqual([{ id: "fake-login", name: "Fake login", description: "Signs in without a browser." }]);
    expect(() => manager.authenticate(taskId, "fake-terminal")).toThrow("does not offer");
    manager.authenticate(taskId, "fake-login");
    const idle = await until(manager, taskId, (task) => task.state === "idle");
    expect(idle).toMatchObject({ sessionId: "fake-session-1", turns: 1, stopReason: "end_turn" });
    expect(idle.auth).toBeUndefined();
  });

  test("marks dashboard changes during a turn and closes a project's sessions on trust revocation", async () => {
    const root = await project();
    const other = await project("other");
    const manager = sessions();
    const mine = await manager.launch(options(root, { prompt: "hang" }));
    const theirs = await manager.launch(options(other, { prompt: "quick" }));
    await until(manager, mine.taskId, (task) => task.state === "working");
    manager.markDashboardChanged(join(root, ".dash-bored", "dash-bored.yaml"));
    expect(manager.get(mine.taskId).dashboardChanged).toBeTrue();
    await until(manager, theirs.taskId, (task) => task.state === "idle");
    await manager.stopProject(root);
    expect(manager.get(mine.taskId)).toMatchObject({ state: "closed", cancelled: true });
    expect(manager.get(theirs.taskId).state).toBe("idle");
  });

  test("hands an idle session off to the agent's own app", async () => {
    const root = await project("it's here");
    const bin = await agentBin(root, ["codex-acp"]);
    const opened: string[] = [];
    const handoffDirectory = join(root, "..", "handoff");
    const manager = sessions({ platform: "darwin", handoffDirectory, openHandoff: async (path) => { opened.push(path); } });
    const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` } as Record<string, string>;
    const { taskId } = await manager.launch(options(root, { command: "codex-acp", prompt: "hang", env }));
    const working = await until(manager, taskId, (task) => task.state === "working");
    expect(working.agent).toEqual({ command: "codex-acp", name: "Codex", knownId: "codex" });
    // No turn has completed yet: some agents only persist a session after one.
    expect(working.handoff).toBeNull();
    await expect(manager.handoff(taskId)).rejects.toThrow("first turn");
    await manager.cancel(taskId);
    const idle = await until(manager, taskId, (task) => task.state === "idle");
    const quoted = `'${root.replaceAll("'", "'\\''")}'`;
    const resume = `codex resume -C ${quoted} 'fake-session-1'`;
    expect(idle.handoff).toEqual({ command: `cd ${quoted} && ${resume}`, app: "Codex" });

    manager.prompt(taskId, "hang");
    await until(manager, taskId, (task) => task.state === "working");
    await expect(manager.handoff(taskId)).rejects.toThrow("idle");
    await manager.cancel(taskId);
    await until(manager, taskId, (task) => task.state === "idle");

    const [handedOff, second] = await Promise.allSettled([manager.handoff(taskId), manager.handoff(taskId)]);
    expect(second.status === "rejected" && String(second.reason)).toContain("already being handed off");
    expect(handedOff.status).toBe("fulfilled");
    if (handedOff.status !== "fulfilled") return;
    expect(() => manager.prompt(taskId, "quick")).toThrow("has ended");
    expect(handedOff.value).toMatchObject({ state: "closed", handedOff: true });
    expect(handedOff.value.cancelled).toBeUndefined();
    expect(handedOff.value.log).toContain("fake-acp-agent: closed fake-session-1");
    expect(opened).toHaveLength(1);
    expect(opened[0]!.startsWith(handoffDirectory)).toBeTrue();
    expect(opened[0]!.endsWith(".command")).toBeTrue();
    expect(await readFile(opened[0]!, "utf8")).toBe(`#!/bin/sh\ncd ${quoted} || exit 1\nexec ${resume}\n`);
    expect((await stat(opened[0]!)).mode & 0o777).toBe(0o700);
    expect((await stat(handoffDirectory)).mode & 0o777).toBe(0o700);
  });

  test("hand-off opens a terminal only on macOS; elsewhere the session stays and the command is shown", async () => {
    const root = await project();
    const bin = await agentBin(root, ["codex-acp"]);
    const opened: string[] = [];
    const manager = sessions({ platform: "linux", handoffDirectory: join(root, "..", "handoff"), openHandoff: async (path) => { opened.push(path); } });
    const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` } as Record<string, string>;
    const { taskId } = await manager.launch(options(root, { command: "codex-acp", prompt: "quick", env }));
    const idle = await until(manager, taskId, (task) => task.state === "idle");
    await expect(manager.handoff(taskId)).rejects.toThrow(`macOS only. Run this instead: ${idle.handoff!.command}`);
    expect(manager.get(taskId).state).toBe("idle");
    expect(opened).toEqual([]);
  });
});
