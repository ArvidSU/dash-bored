import { access, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";

const root = process.cwd();
const worktreeEnvPath = join(root, ".env.worktree");
const hutchTsconfigPath = join(root, ".hutch", "devkit", "tsconfig.json");
const hutchVitePath = join(root, ".hutch", "devkit", "api", "config", "electrobun-vite.ts");

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function hutchDevelopmentFilesReady(): Promise<boolean> {
  return (await exists(hutchTsconfigPath)) && (await exists(hutchVitePath));
}

async function worktreeDevServerUrl(): Promise<string | null> {
  try {
    const contents = await readFile(worktreeEnvPath, "utf8");
    return contents.match(/^DASH_BORED_DEV_SERVER_URL="([^"]+)"$/m)?.[1] ?? null;
  } catch {
    return null;
  }
}

async function worktreeDevServerIsRunning(): Promise<boolean> {
  const url = await worktreeDevServerUrl();
  if (!url) return false;

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(750) });
    return response.ok;
  } catch {
    return false;
  }
}

async function run(command: string[]): Promise<void> {
  const child = Bun.spawn({
    cmd: command,
    cwd: root,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`${command.join(" ")} exited with code ${exitCode}.`);
  }
}

function hash(value: string): number {
  let result = 2_166_136_261;
  for (const character of value) {
    result ^= character.codePointAt(0) ?? 0;
    result = Math.imul(result, 16_777_619);
  }
  return result >>> 0;
}

function shellEnvValue(value: string): string {
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("$", "\\$")
    .replaceAll("`", "\\`")}"`;
}

async function portIsAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

async function findPort(start: number): Promise<number> {
  for (let port = start; port < start + 600; port += 1) {
    if (await portIsAvailable(port)) return port;
  }
  throw new Error("Could not find an available worktree development port.");
}

async function createWorktreeEnv(): Promise<void> {
  if (await exists(worktreeEnvPath)) {
    console.log(`Keeping existing ${worktreeEnvPath}.`);
    return;
  }

  const port = await findPort(5200 + (hash(root) % 600));
  const instance = `wt-${hash(root).toString(16).padStart(8, "0")}`;
  const contents = [
    "# Generated for this worktree; do not commit.",
    `DASH_BORED_PROJECT_ROOT=${shellEnvValue(root)}`,
    `DASH_BORED_VITE_PORT=${port}`,
    `DASH_BORED_DEV_SERVER_URL=${shellEnvValue(`http://127.0.0.1:${port}`)}`,
    `DASH_BORED_INSTANCE=${shellEnvValue(instance)}`,
    "",
  ].join("\n");

  try {
    await writeFile(worktreeEnvPath, contents, { flag: "wx", mode: 0o600 });
    console.log(`Created ${worktreeEnvPath} using port ${port}.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    console.log(`Keeping existing ${worktreeEnvPath}.`);
  }
}

try {
  console.log("Installing locked worktree dependencies…");
  await run(["bun", "install", "--frozen-lockfile"]);

  await createWorktreeEnv();
  await run(["bun", "run", "dash-bored", "--", "validate", "."]);

  if (await hutchDevelopmentFilesReady()) {
    console.log("Electrobun/Hutch development files already prepared.");
  } else if (await worktreeDevServerIsRunning()) {
    console.log(
      "Worktree dev server is already running; reusing its Electrobun/Hutch preparation.",
    );
  } else {
    console.log("Preparing Electrobun/Hutch development files…");
    await run(["bun", "run", "setup"]);
  }

  console.log("Worktree setup complete. Run `bun run dev` to start the isolated desktop environment.");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
