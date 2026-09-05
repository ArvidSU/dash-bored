import { readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { ComponentEnvironmentSnapshot } from "../shared/contracts";
import { envEntries, invalidEnvLineCount, parseEnv } from "../shared/env";
import { CoreError } from "./diagnostics";
import { resolveContainedPath } from "./paths";

export type PublishedEnvironment = () => Readonly<Record<string, string>>;

/** Parse bundle defaults as data, without changing Bun.env or evaluating shell syntax. */
export async function readBundleEnvironment(configPath?: string): Promise<Record<string, string>> {
  if (!configPath) return {};
  try {
    const path = await resolveContainedPath(dirname(configPath), ".env", { mustExist: false });
    if ((await stat(path)).size > 1024 * 1024) {
      throw new CoreError("ENV_FILE_TOO_LARGE", "The bundle .env file may not exceed 1 MiB.");
    }
    const bytes = await readFile(path);
    if (bytes.byteLength > 1024 * 1024) {
      throw new CoreError("ENV_FILE_TOO_LARGE", "The bundle .env file may not exceed 1 MiB.");
    }
    const document = parseEnv(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (invalidEnvLineCount(document) > 0) {
      throw new CoreError("ENV_FILE_INVALID", "The bundle .env contains invalid entries. Open its environment editor and correct the raw file.");
    }
    return Object.fromEntries(envEntries(document).map(({ entry }) => [entry.key, entry.value]));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    if (error instanceof CoreError) throw error;
    throw new CoreError("ENV_FILE_READ_FAILED", "The bundle .env could not be read as UTF-8. Check the file and its permissions.");
  }
}

export function mergeEnvironment(
  bundle: Readonly<Record<string, string>>,
  published: Readonly<Record<string, string>> = {},
  explicit: Readonly<Record<string, string>> = {},
  inherited: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return { ...bundle, ...Object.fromEntries(Object.entries(inherited).filter((entry): entry is [string, string] => entry[1] !== undefined)), ...published, ...explicit };
}

export async function resolveEnvironment(
  configPath?: string,
  published: Readonly<Record<string, string>> = {},
  explicit: Readonly<Record<string, string>> = {},
): Promise<Record<string, string>> {
  return mergeEnvironment(await readBundleEnvironment(configPath), published, explicit);
}

/** Only these public configuration keys may cross into a renderer snapshot. */
export function environmentSnapshot(
  bundle: Readonly<Record<string, string>>,
  published: Readonly<Record<string, string>> = {},
  explicit: Readonly<Record<string, string>> = {},
): ComponentEnvironmentSnapshot {
  const key = "DASH_BORED_AGENT";
  const source = Object.hasOwn(explicit, key) ? "component"
    : Object.hasOwn(published, key) ? "app"
      : process.env[key] !== undefined ? "process"
        : Object.hasOwn(bundle, key) ? "bundle" : "unset";
  return { values: [{ key, value: mergeEnvironment(bundle, published, explicit)[key] ?? "", source }] };
}
