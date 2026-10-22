import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { isAppReady } from "../src/cli/app";
import { listAppInstances } from "../src/core/app-instances";
import { devInstance, ensureDevEnvironment, exists, readDevEnvironment } from "./dev-environment";

const root = process.cwd();
const mode = process.argv[2] ?? "run";
const wait = process.argv.slice(3).includes("--wait");
const logPath = join(root, ".hutch", "dev.log");
/** Bounds `--wait` once the new instance is expected: replacement plus readiness. */
const READY_TIMEOUT_MS = 180_000;
const POLL_MS = 300;

async function status() {
  const environment = await readDevEnvironment(root);
  const identifier = devInstance(environment);
  const instance = (await listAppInstances()).find((record) => record.identifier === identifier);
  return { root, identifier, running: instance !== undefined, starting: await exists(join(root, ".hutch", "dev-starting")), pid: instance?.pid ?? null, logPath,
    url: environment.DASH_BORED_DEV_SERVER_URL ?? null };
}

type Status = Awaited<ReturnType<typeof status>>;

async function command(args: string[], environment: NodeJS.ProcessEnv): Promise<void> {
  const child = Bun.spawn(args, { cwd: root, env: environment, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  const forward = () => child.kill("SIGTERM");
  process.once("SIGTERM", forward);
  process.once("SIGINT", forward);
  try {
    const code = await child.exited;
    if (code !== 0) throw new Error(`${args.join(" ")} exited ${code}.`);
  } finally {
    process.removeListener("SIGTERM", forward);
    process.removeListener("SIGINT", forward);
  }
}

async function start(): Promise<void> {
  const current = await status();
  if (current.running) {
    console.log(JSON.stringify(wait ? await untilReady(current.pid!, Date.now() + READY_TIMEOUT_MS) : current));
    return;
  }
  await mkdir(join(root, ".hutch"), { recursive: true });
  const lock = join(root, ".hutch", "dev-starting");
  await mkdir(lock).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`This checkout is already starting; see ${logPath}.`);
    throw error;
  });
  let value: Status;
  let child: ChildProcess | undefined;
  try {
    await ensureDevEnvironment(root);
    child = launchDetached("run");
    value = await untilPublished(child);
  } catch (error) {
    if (child?.pid && child.exitCode === null) {
      try { process.kill(-child.pid, "SIGTERM"); } catch { /* Already exited. */ }
    }
    throw error;
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
  console.log(JSON.stringify(wait ? await untilReady(value.pid!, Date.now() + READY_TIMEOUT_MS) : { ...value, starting: false }));
}

/** Waits for the launched run process to publish its instance record. */
async function untilPublished(child: ChildProcess): Promise<Status> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const value = await status();
    if (value.running) return value;
    if (child.exitCode !== null) throw new Error(`Dev startup exited ${child.exitCode}; see ${logPath}.`);
    await Bun.sleep(POLL_MS);
  }
  throw new Error(`Dev startup did not publish its instance in 120 seconds; see ${logPath}.`);
}

async function restart(): Promise<void> {
  await mkdir(join(root, ".hutch"), { recursive: true });
  // Remembered before the worker stops anything, so a replacement can be told apart from the old instance.
  const previousPid = wait ? (await status()).pid : null;
  const child = launchDetached("restart-worker");
  if (!wait) {
    console.log(JSON.stringify({ root, restarting: true, supervisorPid: child.pid, logPath }));
    return;
  }
  const deadline = Date.now() + READY_TIMEOUT_MS;
  const pid = await untilReplaced(child, previousPid, deadline);
  console.log(JSON.stringify(await untilReady(pid, deadline)));
}

/** Waits until the restart worker has published a new instance, failing if the worker fails first. */
async function untilReplaced(child: ChildProcess, previousPid: number | null, deadline: number): Promise<number> {
  for (;;) {
    const value = await status();
    if (value.running && value.pid !== previousPid) return value.pid!;
    if (child.exitCode !== null && child.exitCode !== 0) {
      throw new Error(`Dev restart failed (worker exited ${child.exitCode}); see ${logPath}.\nLast lines of the log:\n${await logTail()}`);
    }
    if (Date.now() >= deadline) throw new Error(`Dev restart did not replace the app within ${READY_TIMEOUT_MS / 1000} seconds; see ${logPath}.`);
    await Bun.sleep(POLL_MS);
  }
}

/**
 * Waits until the instance with this pid answers status and reports no source
 * fetch in flight. Its answer is what `app` commands rely on, so ready means
 * they can be used right away.
 */
async function untilReady(pid: number, deadline: number): Promise<Record<string, unknown>> {
  for (;;) {
    const value = await status();
    if (!value.running || value.pid !== pid) throw new Error(`The dev app (pid ${pid}) stopped before it was ready; see ${logPath}.`);
    const record = (await listAppInstances()).find((instance) => instance.identifier === value.identifier);
    if (record && await isAppReady(record)) return { ...value, starting: false, ready: true };
    if (Date.now() >= deadline) {
      throw new Error(`The dev app (pid ${pid}) was not ready within ${READY_TIMEOUT_MS / 1000} seconds; it may still be loading. See ${logPath}.`);
    }
    await Bun.sleep(POLL_MS);
  }
}

async function logTail(): Promise<string> {
  try {
    return (await readFile(logPath, "utf8")).trimEnd().split("\n").slice(-5).join("\n");
  } catch {
    return "(no log)";
  }
}

function launchDetached(mode: string): ChildProcess {
  const log = openSync(logPath, "a", 0o600);
  const child = spawn(process.execPath, [join(import.meta.dirname, "dev.ts"), mode], {
    cwd: root, detached: true, stdio: ["ignore", log, log],
  });
  closeSync(log);
  child.unref();
  return child;
}

try {
  if (wait && mode !== "start" && mode !== "restart") throw new Error("--wait applies to dev:start and dev:restart only.");
  if (mode === "status") console.log(JSON.stringify(await status()));
  else if (mode === "start") await start();
  else if (mode === "restart") await restart();
  else if (mode === "restart-worker") {
    await command([process.execPath, join(import.meta.dirname, "stop-dev.ts")], { ...process.env });
    await start();
  } else if (mode === "run" || mode === "desktop") {
    if ((await status()).running) throw new Error("This checkout's dev app is already running. Use bun run dev:restart or dev:status.");
    const environment = { ...process.env, ...await ensureDevEnvironment(root) };
    delete environment.DASH_BORED_APP_INSTANCE;
    delete environment.DASH_BORED_TOOL;
    delete environment.DASH_BORED_CONFIG_PATH;
    delete environment.DASH_BORED_RELEASE;
    await command(["bun", "run", "setup"], environment);
    await command(["bun", "run", "build:renderer:fast"], environment);
    await command(["bun", "run", "build:cli"], environment);
    await command(mode === "desktop"
      ? ["./node_modules/.bin/electrobun", "dev", "--watch"]
      : ["./node_modules/.bin/concurrently", "--kill-others", "vite --host 127.0.0.1", "electrobun dev --watch"], environment);
  } else throw new Error(`Unknown dev mode: ${mode}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
