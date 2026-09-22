import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AppInstanceRecord } from "../shared/agent-control";
import { CoreError } from "./diagnostics";

/** Unix socket paths are limited to roughly 104 bytes on macOS. */
const MAX_SOCKET_PATH_BYTES = 100;

/**
 * Shared, instance-keyed runtime directory. Each running app publishes one
 * record here so agent tools can find its control socket without a PATH entry.
 */
export function appRunDirectory(homeDirectory = homedir()): string {
  return join(homeDirectory, ".config", "dash-bored", "run");
}

/** Where the release app records its bundled agent tool for the skill launcher. */
export function toolLocatorPath(homeDirectory = homedir()): string {
  return join(homeDirectory, ".config", "dash-bored", "tool-path");
}

export function instanceSocketPath(identifier: string, homeDirectory = homedir()): string {
  const direct = join(appRunDirectory(homeDirectory), `${identifier}.sock`);
  if (Buffer.byteLength(direct) <= MAX_SOCKET_PATH_BYTES) return direct;
  const digest = createHash("sha256").update(identifier).digest("hex").slice(0, 16);
  return join(appRunDirectory(homeDirectory), `${digest}.sock`);
}

function recordPath(identifier: string, homeDirectory: string): string {
  return join(appRunDirectory(homeDirectory), `${identifier}.json`);
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, contents, { mode: 0o600 });
  await rename(temporary, path);
}

export async function publishAppInstance(record: AppInstanceRecord, homeDirectory = homedir()): Promise<void> {
  await mkdir(appRunDirectory(homeDirectory), { recursive: true, mode: 0o700 });
  await atomicWrite(recordPath(record.identifier, homeDirectory), `${JSON.stringify(record, null, 2)}\n`);
}

export async function publishToolLocator(toolPath: string, homeDirectory = homedir()): Promise<void> {
  await mkdir(join(homeDirectory, ".config", "dash-bored"), { recursive: true });
  await atomicWrite(toolLocatorPath(homeDirectory), `${toolPath}\n`);
}

/** Removes the record only when it still belongs to this process. */
export async function withdrawAppInstance(identifier: string, pid: number, homeDirectory = homedir()): Promise<void> {
  const path = recordPath(identifier, homeDirectory);
  const current = await readRecord(path);
  if (current?.pid !== pid) return;
  await rm(path, { force: true });
  await rm(current.socketPath, { force: true });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readRecord(path: string): Promise<AppInstanceRecord | null> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<AppInstanceRecord>;
    if (typeof value.identifier !== "string" || typeof value.pid !== "number" || typeof value.socketPath !== "string") return null;
    return {
      identifier: value.identifier,
      pid: value.pid,
      version: typeof value.version === "string" ? value.version : "unknown",
      socketPath: value.socketPath,
      toolPath: typeof value.toolPath === "string" ? value.toolPath : null,
      startedAt: typeof value.startedAt === "string" ? value.startedAt : "",
    };
  } catch {
    return null;
  }
}

export async function listAppInstances(homeDirectory = homedir()): Promise<AppInstanceRecord[]> {
  let names: string[];
  try {
    names = await readdir(appRunDirectory(homeDirectory));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const records = await Promise.all(names
    .filter((name) => name.endsWith(".json"))
    .map((name) => readRecord(join(appRunDirectory(homeDirectory), name))));
  return records
    .filter((record): record is AppInstanceRecord => record !== null && isAlive(record.pid))
    .sort((left, right) => left.identifier.localeCompare(right.identifier));
}

/**
 * An explicit identifier wins, then the instance that launched this agent, then
 * the only running instance. Several candidates are ambiguous by design.
 */
export function selectAppInstance(
  instances: readonly AppInstanceRecord[],
  requested: string | undefined,
  launchedBy: string | undefined,
): AppInstanceRecord {
  const wanted = requested ?? launchedBy;
  if (wanted !== undefined) {
    const match = instances.find((instance) => instance.identifier === wanted);
    if (match) return match;
    throw new CoreError(
      "APP_INSTANCE_NOT_RUNNING",
      `The dash-bored app instance ${wanted} is not running.${describeInstances(instances)}`,
    );
  }
  if (instances.length === 1) return instances[0]!;
  if (instances.length === 0) {
    throw new CoreError("APP_NOT_RUNNING", "No dash-bored app is running. Ask the user to open it.");
  }
  throw new CoreError(
    "APP_INSTANCE_AMBIGUOUS",
    `Several dash-bored app instances are running; pass --instance <identifier>.${describeInstances(instances)}`,
  );
}

function describeInstances(instances: readonly AppInstanceRecord[]): string {
  if (instances.length === 0) return "";
  return ` Running: ${instances.map((instance) => `${instance.identifier} (${instance.version})`).join(", ")}.`;
}
