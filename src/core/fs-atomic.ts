import { randomUUID } from "node:crypto";
import { link, open, rename, rm } from "node:fs/promises";

export interface AtomicWriteOptions {
  /** Creation permissions before the process umask is applied. Defaults to 0o666. */
  mode?: number;
  /** Apply the requested mode exactly after creation instead of honoring umask. */
  exactMode?: boolean;
  /** Flush file contents before publishing the temporary file. */
  sync?: boolean;
  /** Publish only if the target does not already exist. */
  exclusive?: boolean;
  /** Caller-owned guard that runs immediately before the atomic publish. */
  beforePublish?: () => void | Promise<void>;
}

/**
 * Write through a unique sibling temporary file, then publish it with one
 * rename (replace) or hard link (create-only). Parent creation and caller
 * validation remain the responsibility of the owning operation.
 */
export async function writeFileAtomically(
  path: string,
  contents: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, "wx", options.mode ?? 0o666);
  let closed = false;

  try {
    if (typeof contents === "string") await handle.writeFile(contents, "utf8");
    else await handle.writeFile(contents);
    if (options.exactMode) await handle.chmod(options.mode ?? 0o666);
    if (options.sync) await handle.sync();
    await handle.close();
    closed = true;

    await options.beforePublish?.();
    if (options.exclusive) await link(temporaryPath, path);
    else await rename(temporaryPath, path);
  } finally {
    if (!closed) await handle.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}
