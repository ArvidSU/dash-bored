import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { listAppInstances } from "../src/core/app-instances";
import { devInstance, ensureDevEnvironment, exists, readDevEnvironment } from "./dev-environment";

const root = process.cwd();
const mode = process.argv[2] ?? "run";
const logPath = join(root, ".hutch", "dev.log");

async function status() {
  const environment = await readDevEnvironment(root);
  const identifier = devInstance(environment);
  const instance = (await listAppInstances()).find((record) => record.identifier === identifier);
  return { root, identifier, running: instance !== undefined, starting: await exists(join(root, ".hutch", "dev-starting")), pid: instance?.pid ?? null, logPath,
    url: environment.DASH_BORED_DEV_SERVER_URL ?? null };
}

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
  if (current.running) { console.log(JSON.stringify(current)); return; }
  await mkdir(join(root, ".hutch"), { recursive: true });
  const lock = join(root, ".hutch", "dev-starting");
  await mkdir(lock).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`This checkout is already starting; see ${logPath}.`);
    throw error;
  });
  let child: ReturnType<typeof launchDetached> | undefined;
  try {
    await ensureDevEnvironment(root);
    child = launchDetached("run");
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const value = await status();
      if (value.running) {
        await rm(lock, { recursive: true, force: true });
        console.log(JSON.stringify({ ...value, starting: false }));
        return;
      }
      if (child.exitCode !== null) throw new Error(`Dev startup exited ${child.exitCode}; see ${logPath}.`);
      await Bun.sleep(300);
    }
    throw new Error(`Dev startup did not publish its instance in 120 seconds; see ${logPath}.`);
  } catch (error) {
    if (child?.pid && child.exitCode === null) {
      try { process.kill(-child.pid, "SIGTERM"); } catch { /* Already exited. */ }
    }
    throw error;
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

function launchDetached(mode: string) {
  const log = openSync(logPath, "a", 0o600);
  const child = spawn(process.execPath, [join(import.meta.dirname, "dev.ts"), mode], {
    cwd: root, detached: true, stdio: ["ignore", log, log],
  });
  closeSync(log);
  child.unref();
  return child;
}

try {
  if (mode === "status") console.log(JSON.stringify(await status()));
  else if (mode === "start") await start();
  else if (mode === "restart") {
    await mkdir(join(root, ".hutch"), { recursive: true });
    const child = launchDetached("restart-worker");
    console.log(JSON.stringify({ root, restarting: true, supervisorPid: child.pid, logPath }));
  } else if (mode === "restart-worker") {
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
