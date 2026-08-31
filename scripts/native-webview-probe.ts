import { access } from "node:fs/promises";
import { createServer } from "node:net";

const root = process.cwd();
const requestedPort = Number(process.env.DASH_BORED_NATIVE_PROBE_PORT ?? "5499");

async function assertPrepared(): Promise<void> {
  try {
    await access(".hutch/devkit/api/config/electrobun-vite.ts");
  } catch {
    throw new Error("Native probe needs prepared Electrobun files. Run `bun run setup` when no user-owned development watcher is using the build lock, then rerun this probe.");
  }
}

async function assertPortAvailable(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = createServer();
    server.once("error", () => reject(new Error(`Native probe refuses to use busy port ${port}; it will not attach to an existing server.`)));
    server.listen(port, "127.0.0.1", () => server.close((error) => error ? reject(error) : resolve()));
  });
}

function probeEnvironment(port: number): Record<string, string> {
  return {
    ...process.env,
    DASH_BORED_NATIVE_PROBE: "1",
    DASH_BORED_NATIVE_PROBE_PORT: String(port),
    DASH_BORED_VITE_PORT: String(port),
    DASH_BORED_DEV_SERVER_URL: `http://127.0.0.1:${port}`,
    DASH_BORED_INSTANCE: `native-probe-${port}`,
  };
}

await assertPrepared();
await assertPortAvailable(requestedPort);
const environment = probeEnvironment(requestedPort);
const vite = Bun.spawn({
  cmd: ["bun", "./node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", String(requestedPort), "--strictPort"],
  cwd: root,
  env: environment,
  stdin: "ignore",
  stdout: "inherit",
  stderr: "inherit",
});

try {
  const desktop = Bun.spawn({
    cmd: ["./node_modules/.bin/electrobun", "dev", "--watch"],
    cwd: root,
    env: environment,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await desktop.exited;
  if (exitCode !== 0) process.exitCode = exitCode;
} finally {
  vite.kill();
  await vite.exited;
}
