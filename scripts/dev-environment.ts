import { constants } from "node:fs";
import { access, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { envEntries, parseEnv } from "../src/shared/env";

export async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

export async function readDevEnvironment(root: string): Promise<Record<string, string>> {
  try {
    const document = parseEnv(await readFile(join(root, ".env.worktree"), "utf8"));
    return Object.fromEntries(envEntries(document).map(({ entry }) => [entry.key, entry.value]));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
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

function shellValue(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("$", "\\$").replaceAll("`", "\\`")}"`;
}

async function findPort(start: number): Promise<number> {
  for (let port = start; port < start + 600; port++) {
    const available = await new Promise<boolean>((done) => {
      const server = createServer();
      server.once("error", () => done(false));
      server.listen(port, "127.0.0.1", () => server.close(() => done(true)));
    });
    if (available) return port;
  }
  throw new Error("Could not find an available checkout development port.");
}

/** Each checkout owns its build state; cached toolchains are copied, never linked. */
export async function ensureDevEnvironment(
  root: string,
  sharedHutch = process.env.HUTCH_HOME ?? join(homedir(), ".hutch"),
): Promise<Record<string, string>> {
  root = resolve(root);
  const existing = await readDevEnvironment(root);
  const sameCheckout = existing.DASH_BORED_PROJECT_ROOT === root;
  const port = sameCheckout && existing.DASH_BORED_VITE_PORT
    ? Number(existing.DASH_BORED_VITE_PORT)
    : await findPort(5200 + hash(root) % 600);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid DASH_BORED_VITE_PORT in .env.worktree.");
  const instance = sameCheckout && existing.DASH_BORED_INSTANCE || `wt-${hash(root).toString(16).padStart(8, "0")}`;
  if (!/^[a-zA-Z0-9.-]+$/.test(instance)) throw new Error("Invalid DASH_BORED_INSTANCE in .env.worktree.");
  const hutchHome = join(root, ".hutch", "home");
  const environment = {
    ...existing,
    DASH_BORED_PROJECT_ROOT: root,
    DASH_BORED_VITE_PORT: String(port),
    DASH_BORED_DEV_SERVER_URL: sameCheckout && existing.DASH_BORED_DEV_SERVER_URL || `http://127.0.0.1:${port}`,
    DASH_BORED_INSTANCE: instance,
    HUTCH_HOME: hutchHome,
  };
  await mkdir(hutchHome, { recursive: true });
  if (resolve(sharedHutch) !== hutchHome) {
    for (const name of ["releases", "toolchains", "npm"]) {
      const source = join(sharedHutch, name);
      const destination = join(hutchHome, name);
      if (await exists(source) && !await exists(destination)) {
        await cp(source, destination, {
          recursive: true, mode: constants.COPYFILE_FICLONE,
          filter: (path) => !path.endsWith(".lock") && !path.includes(".install-lock"),
        });
      }
    }
  }
  const contents = "# Generated for this checkout; do not commit.\n"
    + Object.entries(environment).map(([key, value]) => `${key}=${shellValue(value)}`).join("\n") + "\n";
  if (await readFile(join(root, ".env.worktree"), "utf8").catch(() => "") !== contents) {
    await writeFile(join(root, ".env.worktree"), contents, { mode: 0o600 });
  }
  return environment;
}

export function devInstance(environment: Record<string, string>): string | undefined {
  return environment.DASH_BORED_INSTANCE ? `dev.dash-bored.${environment.DASH_BORED_INSTANCE}.dev` : undefined;
}
