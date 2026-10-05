import { readFile } from "node:fs/promises";
import { ensureDevEnvironment, exists } from "./dev-environment";
import { join } from "node:path";

const root = process.cwd();
const worktreeEnvPath = join(root, ".env.worktree");
const hutchTsconfigPath = join(root, ".hutch", "devkit", "tsconfig.json");
const hutchVitePath = join(root, ".hutch", "devkit", "api", "config", "electrobun-vite.ts");

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

try {
  console.log("Installing locked worktree dependencies…");
  await run(["bun", "install", "--frozen-lockfile"]);

  Object.assign(process.env, await ensureDevEnvironment(root));
  await run(["bun", "run", "packages:restore"]);
  await run(["bun", "run", "dash-bored", "--", "validate", "."]);
  await run(["bun", "run", "dash-bored", "--", "validate", ".dash-bored/dogfood"]);

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
