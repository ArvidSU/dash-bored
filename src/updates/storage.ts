import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { UpdateSettings } from "../shared/updates";
import { atomicJson } from "../core/fs-atomic";

/** Shared by all release app/CLI entrypoints; never inside a replaced bundle. */
export function updateDirectory(): string { return join(homedir(), ".config", "dash-bored", "updates"); }
export async function readJson(path: string): Promise<unknown | null> {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
export function validateUpdateSettings(value: unknown): UpdateSettings {
  const s = value as UpdateSettings;
  if (!s || s.channel !== "canary") throw new Error("Only Canary is available. Beta and Stable are coming later.");
  if (typeof s.automaticChecks !== "boolean") throw new Error("automaticChecks must be true or false.");
  return { channel: "canary", automaticChecks: s.automaticChecks };
}
export async function getUpdateSettings(directory: string): Promise<UpdateSettings> {
  const saved = await readJson(join(directory, "settings.json"));
  return saved === null ? { channel: "canary", automaticChecks: true } : validateUpdateSettings(saved);
}

/** Atomic cross-process lock; stale locks require explicit recovery, never a guessed timeout. */
export async function withUpdateLock<T>(directory: string, operation: () => Promise<T>): Promise<T> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "operation.lock");
  try { await mkdir(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Another update operation owns the lock. If it was interrupted, choose Recover interrupted update after that process exits."); throw error; }
  try { await atomicJson(join(path, "owner.json"), { pid: process.pid }); return await operation(); }
  finally { await rm(path, { recursive: true, force: true }); }
}
export async function hasUpdateLock(directory: string): Promise<boolean> {
  return stat(join(directory, "operation.lock")).then(() => true, () => false);
}
export async function recoverUpdateLock(directory: string): Promise<void> {
  const lock = join(directory, "operation.lock");
  const owner = await readJson(join(lock, "owner.json")) as { pid?: number } | null;
  if (!owner || !Number.isInteger(owner.pid) || owner.pid! <= 0) throw new Error("Lock ownership is unknown; inspect the lock before removing it manually.");
  try { process.kill(owner.pid!, 0); throw new Error("The update lock owner is still running; cancel it before recovery."); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  await rm(lock, { recursive: true });
}
